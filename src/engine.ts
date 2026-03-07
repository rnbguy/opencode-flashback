import type { Database } from "bun:sqlite";
import { getConfig } from "./config.ts";
import {
  embed,
  getEmbedderState,
  getEmbeddingDimension,
  resetEmbedder,
} from "./core/ai/embed.ts";
import {
  type CaptureRequest,
  enqueueCapture,
  getCaptureState,
  initCapture,
  resetCapture,
} from "./core/capture.ts";
import { consolidateMemories } from "./core/consolidate.ts";
import {
  type AddMemoryOptions,
  addMemory,
  exportMemories,
  findRelatedMemories,
  forgetMemory,
  getContext,
  getMemoriesForReview,
  getMemoryById,
  listMemories,
  rateMemory,
  recallMemories,
  searchMemories,
  starMemory,
  suspendMemory,
  unstarMemory,
} from "./core/memory.ts";
import {
  deleteProfileItem,
  getOrCreateProfile,
  starProfileItem,
  unstarProfileItem,
} from "./core/profile.ts";
import {
  clearAllData,
  clearOldData,
  closeDb,
  countMemories,
  getDb,
  getMetaValue,
  incrementRevision,
  META_KEY_EMBEDDING_DIMENSION,
  META_KEY_EMBEDDING_MODEL,
  META_KEY_REEMBED_IN_PROGRESS,
  setMetaValue,
} from "./db/database.ts";
import { getSearchState, initSearch, markStale } from "./search.ts";
import type {
  ConsolidationCandidate,
  ContainerTagInfo,
  ContainerTagResolver,
  DiagnosticsResponse,
  Memory,
  SearchResult,
  UserProfile,
} from "./types.ts";
import { getLogger } from "./util/logger.ts";

export interface MemoryEngine {
  addMemory(
    opts: AddMemoryOptions,
  ): Promise<{ id: string; deduplicated: boolean }>;
  searchMemories(
    query: string,
    containerTag: string,
    limit?: number,
    offset?: number,
  ): Promise<{ results: SearchResult[]; totalCount: number }>;
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
  getContext(
    containerTag: string,
    sessionId?: string,
    queryHint?: string,
    userId?: string,
  ): Promise<string>;
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
  starMemory(id: string): Promise<boolean>;
  unstarMemory(id: string): Promise<boolean>;
  rateMemory(
    id: string,
    rating: 1 | 2 | 3 | 4 | 5,
  ): Promise<{ success: boolean; nextReviewAt: number | null }>;
  getMemoriesForReview(containerTag: string, limit?: number): Promise<Memory[]>;
  getOrCreateProfile(userId: string): UserProfile | null;
  starProfileItem(
    userId: string,
    section: "preferences" | "patterns" | "workflows",
    index: number,
  ): boolean;
  unstarProfileItem(
    userId: string,
    section: "preferences" | "patterns" | "workflows",
    index: number,
  ): boolean;
  deleteProfileItem(
    userId: string,
    section: "preferences" | "patterns" | "workflows",
    index: number,
  ): boolean;
  enqueueCapture(request: CaptureRequest): void;
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
  logger.info(
    `Re-embedding memories for model change: ${storedModel} -> ${currentModel}`,
  );

  // Don't await -- run in background
  reembedAllMemories(db, currentModel).catch((err) => {
    logger.error("Background re-embed failed", { error: String(err) });
  });
}

export async function reembedAllMemories(
  db: Database,
  newModel: string,
): Promise<void> {
  const logger = getLogger();

  // Check if re-embed is already in progress
  const inProgressValue = getMetaValue(db, META_KEY_REEMBED_IN_PROGRESS);
  if (inProgressValue) {
    const timestamp = parseInt(inProgressValue, 10);
    const now = Date.now();
    const elapsedMs = now - timestamp;
    const tenMinutesMs = 10 * 60 * 1000;

    if (elapsedMs < tenMinutesMs) {
      logger.info("skipping re-embed, another instance in progress");
      return;
    }
  }

  // Set the in-progress flag with current timestamp
  setMetaValue(db, META_KEY_REEMBED_IN_PROGRESS, String(Date.now()));

  try {
    const memories = db
      .query("SELECT id, content FROM memories")
      .all() as Array<{
      id: string;
      content: string;
    }>;

    if (memories.length === 0) {
      setMetaValue(db, META_KEY_EMBEDDING_MODEL, newModel);
      return;
    }

    logger.info(`Re-embedding ${memories.length} memories...`);

    const REEMBED_CHUNK_SIZE = 50;
    const updateStmt = db.query(
      "UPDATE memories SET embedding = ? WHERE id = ?",
    );

    for (let i = 0; i < memories.length; i += REEMBED_CHUNK_SIZE) {
      const chunk = memories.slice(i, i + REEMBED_CHUNK_SIZE);
      const texts = chunk.map((m) => m.content);
      const embeddings = await embed(texts, "document");

      for (let j = 0; j < chunk.length; j++) {
        const float32 = new Float32Array(embeddings[j]);
        updateStmt.run(Buffer.from(float32.buffer), chunk[j].id);
      }

      // Heartbeat: update in-progress timestamp to prevent timeout
      setMetaValue(db, META_KEY_REEMBED_IN_PROGRESS, String(Date.now()));
    }

    setMetaValue(db, META_KEY_EMBEDDING_MODEL, newModel);
    logger.info(`Re-embedding complete: ${memories.length} memories updated`);
    incrementRevision(db);
    markStale();
  } finally {
    // Clear the in-progress flag on completion or error
    const metaTable = db.query("DELETE FROM meta WHERE key = ?");
    metaTable.run(META_KEY_REEMBED_IN_PROGRESS);
  }
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
    starMemory,
    unstarMemory,
    rateMemory,
    getMemoriesForReview,
    getOrCreateProfile,
    starProfileItem,
    unstarProfileItem,
    deleteProfileItem,
    enqueueCapture,
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
      await Promise.all([
        initCapture(),
        initSearch(),
        embed(["warmup"], "query"),
      ]);
      const dim = getEmbeddingDimension();
      if (dim !== null) {
        setMetaValue(getDb(), META_KEY_EMBEDDING_DIMENSION, String(dim));
      }
      checkEmbeddingModelChange(getDb()).catch((err) => {
        getLogger().error("Embedding model change check failed", {
          error: String(err),
        });
      });
    },
    shutdown: () => {
      resetCapture();
      resetEmbedder();
      closeDb();
    },
  };
}

export { deriveUserId } from "./core/tags.ts";
