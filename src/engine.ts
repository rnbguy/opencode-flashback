import type {
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
  type AddMemoryOptions,
} from "./core/memory.ts";
import { getOrCreateProfile } from "./core/profile.ts";
import {
  enqueueCapture,
  getCaptureState,
  resetCapture,
  type CaptureRequest,
} from "./core/capture.ts";
import { embed, getEmbedderState, resetEmbedder } from "./embed/embedder.ts";
import { initSearch, getSearchState } from "./search/index.ts";
import { getDb, countMemories, closeDb } from "./db/database.ts";

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
  getMemoriesForReview(containerTag: string, limit?: number): Promise<Memory[]>;
  getOrCreateProfile(userId: string): UserProfile | null;
  enqueueCapture(request: CaptureRequest): void;
  resolveTag(directory: string): ContainerTagInfo;
  getDiagnostics(containerTag: string): Promise<DiagnosticsResponse>;
  warmup(): Promise<void>;
  shutdown(): void;
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
    getMemoriesForReview,
    getOrCreateProfile,
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
        embeddingModel: "onnx-community/embeddinggemma-300m-ONNX",
        subsystems: {
          embedder: getEmbedderState(),
          search: getSearchState(),
          capture: getCaptureState(),
        },
        version: "0.1.0",
      };
    },
    warmup: async () => {
      await Promise.all([initSearch(), embed(["warmup"], "query")]);
    },
    shutdown: () => {
      resetCapture();
      resetEmbedder();
      closeDb();
    },
  };
}
