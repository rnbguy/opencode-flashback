import type {
  ConsolidationCandidate,
  ContainerTagInfo,
  ContainerTagResolver,
  Memory,
  SearchResult,
  UserProfile,
  DiagnosticsResponse,
} from "./types.ts";
import {
  addMemory,
  exportMemories,
  findRelatedMemories,
  searchMemories,
  recallMemories,
  forgetMemory,
  getMemoriesForReview,
  listMemories,
  getContext,
  getMemoryById,
  suspendMemory,
  pinMemory,
  rateMemory,
  unpinMemory,
  type AddMemoryOptions,
} from "./core/memory.ts";
import { getOrCreateProfile } from "./core/profile.ts";
import { consolidateMemories } from "./core/consolidate.ts";
import {
  enqueueCapture,
  getCaptureState,
  initCapture,
  resetCapture,
  setCaptureNotifier,
  type CaptureRequest,
} from "./core/capture.ts";
import { embed, getEmbedderState, resetEmbedder } from "./core/ai/embed.ts";
import { initSearch, getSearchState } from "./search.ts";
import {
  getDb,
  countMemories,
  closeDb,
  clearAllData,
  clearOldData,
  getMetaValue,
  setMetaValue,
  META_KEY_EMBEDDING_MODEL,
} from "./db/database.ts";
import { getConfig } from "./config.ts";
import type { Database } from "bun:sqlite";
import { getLogger } from "./util/logger.ts";

export interface MemoryEngine {
  addMemory(
    opts: AddMemoryOptions,
  ): Promise<{ id: string; deduplicated: boolean }>;
  searchMemories(
    query: string,
    containerTag: string,
    limit?: number,
  ): Promise<SearchResult[]>;
  recallMemories(
    messages: string[],
    containerTag: string,
    limit?: number,
  ): Promise<SearchResult[]>;
  forgetMemory(id: string): Promise<void>;
  listMemories(
    containerTag: string,
    limit?: number,
    offset?: number,
  ): Promise<{ memories: Memory[]; total: number }>;
  getContext(containerTag: string, sessionId?: string): Promise<string>;
  getMemoryById(id: string): Promise<Memory | null>;
  exportMemories(
    containerTag: string,
    format: "json" | "markdown",
  ): Promise<{ data: string; count: number }>;
  findRelatedMemories(
    query: string,
    containerTag: string,
    limit?: number,
  ): Promise<SearchResult[]>;
  suspendMemory(id: string, reason: string | null): Promise<boolean>;
  pinMemory(id: string): Promise<boolean>;
  unpinMemory(id: string): Promise<boolean>;
  rateMemory(
    id: string,
    rating: 1 | 2 | 3 | 4 | 5,
  ): Promise<{ success: boolean; nextReviewAt: number | null }>;
  getMemoriesForReview(containerTag: string, limit?: number): Promise<Memory[]>;
  getOrCreateProfile(userId: string): UserProfile | null;
  enqueueCapture(request: CaptureRequest): void;
  setCaptureNotifier(fn: (status: string, error?: string) => void): void;
  resolveTag(directory: string): ContainerTagInfo;
  getDiagnostics(containerTag: string): Promise<DiagnosticsResponse>;
  clearAllData(durationSecs?: number): void;
  consolidateMemories(
    containerTag: string,
    dryRun: boolean,
  ): Promise<{ candidates: ConsolidationCandidate[]; merged: number }>;
  warmup(): Promise<void>;
  shutdown(): void;
}

async function checkEmbeddingModelChange(db: Database): Promise<void> {
  const config = getConfig();
  const currentModel = config.embedding?.model;
  if (!currentModel) return;

  const storedModel = getMetaValue(db, META_KEY_EMBEDDING_MODEL);

  if (!storedModel) {
    // First run -- store current model, don't re-embed
    setMetaValue(db, META_KEY_EMBEDDING_MODEL, currentModel);
    return;
  }

  if (storedModel === currentModel) return;

  // Model changed -- re-embed in background
  const logger = getLogger();
  logger.info(`Re-embedding memories for model change: ${storedModel} -> ${currentModel}`);

  // Don't await -- run in background
  reembedAllMemories(db, currentModel).catch((err) => {
    logger.error("Background re-embed failed", { error: String(err) });
  });
}

async function reembedAllMemories(db: Database, newModel: string): Promise<void> {
  const logger = getLogger();
  const memories = db.query("SELECT id, content FROM memories").all() as Array<{ id: string; content: string }>;

  if (memories.length === 0) {
    setMetaValue(db, META_KEY_EMBEDDING_MODEL, newModel);
    return;
  }

  logger.info(`Re-embedding ${memories.length} memories...`);

  const texts = memories.map((m) => m.content);
  const embeddings = await embed(texts, "document");

  const updateStmt = db.query("UPDATE memories SET embedding = ? WHERE id = ?");
  for (let i = 0; i < memories.length; i++) {
    const float32 = new Float32Array(embeddings[i]);
    updateStmt.run(Buffer.from(float32.buffer), memories[i].id);
  }

  setMetaValue(db, META_KEY_EMBEDDING_MODEL, newModel);
  logger.info(`Re-embedding complete: ${memories.length} memories updated`);
}

export function createEngine(resolver: ContainerTagResolver): MemoryEngine {
  return {
    addMemory,
    searchMemories,
    recallMemories,
    forgetMemory,
    listMemories,
    getContext,
    getMemoryById,
    exportMemories,
    findRelatedMemories,
    suspendMemory,
    pinMemory,
    unpinMemory,
    rateMemory,
    getMemoriesForReview,
    getOrCreateProfile,
    enqueueCapture,
    setCaptureNotifier,
    resolveTag: (directory) => resolver.resolve(directory),
    getDiagnostics: async (containerTag) => {
      const db = getDb();
      const dbPath = db.filename ?? "";
      const memoryCount = countMemories(db, containerTag);
      let dbSizeBytes = 0;
      try {
        if (dbPath) {
          dbSizeBytes = Bun.file(dbPath).size;
        }
      } catch {
        // DB file may not exist yet -- use zero size
      }
      return {
        memoryCount,
        dbSizeBytes,
        dbPath,
        embeddingModel: getConfig().embedding?.model ?? "embeddinggemma:latest",
        subsystems: {
          embedder: getEmbedderState(),
          search: getSearchState(),
          capture: getCaptureState(),
        },
        version: "0.1.0",
      };
    },
    clearAllData: (durationSecs?: number) => {
      const db = getDb();
      if (typeof durationSecs === "number" && durationSecs > 0) {
        clearOldData(db, Date.now() - durationSecs * 1000);
      } else {
        clearAllData(db);
      }
    },
    consolidateMemories: async (containerTag, dryRun) => {
      return consolidateMemories({ containerTag, dryRun });
    },
    warmup: async () => {
      await Promise.all([initCapture(), initSearch(), embed(["warmup"], "query")]);
      checkEmbeddingModelChange(getDb()).catch((err) => {
        getLogger().error("Embedding model change check failed", { error: String(err) });
      });
    },
    shutdown: () => {
      resetCapture();
      resetEmbedder();
      closeDb();
    },
  };
}
