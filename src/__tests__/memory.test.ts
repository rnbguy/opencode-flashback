import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Memory, SearchResult } from "../types";

// -- Deterministic embedding --------------------------------------------------

function deterministicVector(text: string): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
  }
  const vec = new Array(768);
  for (let i = 0; i < 768; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    vec[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

// -- Module mocks (hoisted by Bun) --------------------------------------------

const mockHybridSearch = mock(
  async (
    _q: string,
    _v: number[],
    _tag: string,
    _limit: number,
  ): Promise<SearchResult[]> => [],
);

mock.module("../embed/embedder.ts", () => ({
  embed: async (texts: string[], _mode: string) =>
    texts.map((t) => deterministicVector(t)),
  getEmbedderState: () => "ready" as const,
  resetEmbedder: () => {},
}));

mock.module("../search/index.ts", () => ({
  initSearch: async () => {},
  hybridSearch: (...args: unknown[]) =>
    mockHybridSearch(...(args as [string, number[], string, number])),
  markStale: () => {},
  rebuildIndex: async () => {},
  getSearchState: () => "ready" as const,
}));

// -- Imports (resolved after mocks) -------------------------------------------

import {
  getDb,
  closeDb,
  insertMemory,
  getAllActiveMemories,
} from "../db/database";
import {
  _setConfigForTesting,
  _resetConfigForTesting,
  type PluginConfig,
} from "../config";
import {
  addMemory,
  searchMemories,
  recallMemories,
  forgetMemory,
  listMemories,
  getContext,
  getMemoryById,
} from "../core/memory";

// -- Helpers ------------------------------------------------------------------

let tmpDir: string;

const testConfig: PluginConfig = {
  llm: {
    provider: "openai-chat",
    model: "test",
    apiUrl: "http://test",
    apiKey: "k",
  },
  storage: { path: "/tmp" },
  memory: {
    maxResults: 10,
    autoCapture: true,
    injection: "first",
    excludeCurrentSession: true,
  },
  web: { port: 4747, enabled: false },
  search: { retrievalQuality: "balanced" },
  toasts: {
    autoCapture: true,
    userProfile: true,
    errors: true,
  },
  compaction: {
    enabled: true,
    memoryLimit: 10,
  },
};

function makeTestMemory(
  id: string,
  containerTag: string,
  overrides?: Partial<Memory>,
): Memory {
  const now = Date.now();
  return {
    id,
    content: `content-${id}`,
    embedding: new Float32Array(768),
    containerTag,
    tags: [],
    type: "note",
    isPinned: false,
    createdAt: now,
    updatedAt: now,
    metadata: { importance: 5 },
    displayName: "",
    userName: "",
    userEmail: "",
    projectPath: "",
    projectName: "",
    gitRepoUrl: "",
    provenance: {
      sessionId: "",
      messageRange: [0, 0] as [number, number],
      toolCallIds: [],
    },
    lastAccessedAt: now,
    accessCount: 0,
    epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
    evictedAt: null,
    suspended: false,
    suspendedReason: null,
    suspendedAt: null,
    stability: 0,
    nextReviewAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  _setConfigForTesting(testConfig);
  closeDb();
  tmpDir = mkdtempSync(join(tmpdir(), "flashback-mem-"));
  getDb(join(tmpDir, "test.db"));
  mockHybridSearch.mockReset();
});

afterEach(() => {
  _resetConfigForTesting();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// -- addMemory ----------------------------------------------------------------

describe("addMemory", () => {
  test("adds a new memory and returns id", async () => {
    const result = await addMemory({
      content: "test memory content",
      containerTag: "test-tag",
    });

    expect(result.id).toBeTruthy();
    expect(result.deduplicated).toBe(false);

    const memory = await getMemoryById(result.id);
    expect(memory).not.toBeNull();
    expect(memory!.content).toBe("test memory content");
    expect(memory!.containerTag).toBe("test-tag");
  });

  test("detects duplicate via cosine similarity", async () => {
    const first = await addMemory({
      content: "identical content for dedup test",
      containerTag: "test-tag",
    });
    expect(first.deduplicated).toBe(false);

    const second = await addMemory({
      content: "identical content for dedup test",
      containerTag: "test-tag",
    });
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
  });

  test("does not dedup different content", async () => {
    const first = await addMemory({
      content: "first unique content about TypeScript generics",
      containerTag: "test-tag",
    });
    const second = await addMemory({
      content: "completely different topic about Rust lifetimes",
      containerTag: "test-tag",
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(false);
    expect(second.id).not.toBe(first.id);
  });

  test("does not dedup across container tags", async () => {
    const first = await addMemory({
      content: "same content across tags",
      containerTag: "tag-a",
    });
    const second = await addMemory({
      content: "same content across tags",
      containerTag: "tag-b",
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(false);
    expect(second.id).not.toBe(first.id);
  });

  test("clamps importance to 1-10 range", async () => {
    const high = await addMemory({
      content: "high importance memory",
      containerTag: "test-tag",
      importance: 15,
    });
    const memHigh = await getMemoryById(high.id);
    expect(memHigh!.metadata.importance).toBe(10);

    const low = await addMemory({
      content: "low importance memory",
      containerTag: "test-tag",
      importance: -3,
    });
    const memLow = await getMemoryById(low.id);
    expect(memLow!.metadata.importance).toBe(1);
  });

  test("uses default importance when not provided", async () => {
    const result = await addMemory({
      content: "no importance specified",
      containerTag: "test-tag",
    });
    const mem = await getMemoryById(result.id);
    expect(mem!.metadata.importance).toBe(5);
  });

  test("stores tags and type", async () => {
    const result = await addMemory({
      content: "tagged memory",
      containerTag: "test-tag",
      tags: ["rust", "wasm"],
      type: "feature",
    });
    const mem = await getMemoryById(result.id);
    expect(mem!.tags).toEqual(["rust", "wasm"]);
    expect(mem!.type).toBe("feature");
  });

  test("stores provenance metadata", async () => {
    const result = await addMemory({
      content: "provenance test",
      containerTag: "test-tag",
      provenance: {
        sessionId: "sess-1",
        messageRange: [0, 5],
        toolCallIds: ["tc-1"],
      },
    });
    const mem = await getMemoryById(result.id);
    expect(mem!.provenance.sessionId).toBe("sess-1");
    expect(mem!.provenance.messageRange).toEqual([0, 5]);
  });
});

// -- searchMemories -----------------------------------------------------------

describe("searchMemories", () => {
  test("returns reranked hybrid search results", async () => {
    const db = getDb();
    const mem = makeTestMemory("search-1", "test-tag", {
      content: "found via search",
    });
    insertMemory(db, mem);

    mockHybridSearch.mockImplementation(async () => [
      { memory: mem, score: 0.8, _debug: {} },
    ]);

    const results = await searchMemories("query", "test-tag");
    expect(results.length).toBe(1);
    expect(results[0].memory.id).toBe("search-1");
  });

  test("falls back to text search when hybrid fails", async () => {
    const db = getDb();
    const mem = makeTestMemory("fallback-1", "test-tag", {
      content: "searchable text content",
    });
    insertMemory(db, mem);

    mockHybridSearch.mockImplementation(async () => {
      throw new Error("search failed");
    });

    const results = await searchMemories("searchable", "test-tag");
    expect(results.length).toBe(1);
    expect(results[0].memory.id).toBe("fallback-1");
  });

  test("returns empty for no matches", async () => {
    mockHybridSearch.mockImplementation(async () => []);
    const results = await searchMemories("nonexistent", "test-tag");
    expect(results).toEqual([]);
  });
});

// -- recallMemories -----------------------------------------------------------

describe("recallMemories", () => {
  test("returns empty for no messages", async () => {
    const results = await recallMemories([], "test-tag");
    expect(results).toEqual([]);
  });

  test("returns empty for whitespace-only messages", async () => {
    const results = await recallMemories(["   ", "\n"], "test-tag");
    expect(results).toEqual([]);
  });

  test("delegates to searchMemories with joined messages", async () => {
    mockHybridSearch.mockImplementation(async () => []);
    const results = await recallMemories(
      ["user asked about Rust", "assistant explained lifetimes"],
      "test-tag",
    );
    expect(results).toEqual([]);
    expect(mockHybridSearch).toHaveBeenCalled();
  });
});

// -- forgetMemory -------------------------------------------------------------

describe("forgetMemory", () => {
  test("deletes memory from database", async () => {
    const result = await addMemory({
      content: "memory to forget",
      containerTag: "test-tag",
    });

    await forgetMemory(result.id);

    const mem = await getMemoryById(result.id);
    expect(mem).toBeNull();
  });
});

// -- listMemories -------------------------------------------------------------

describe("listMemories", () => {
  test("returns paginated memories with total", async () => {
    const db = getDb();
    for (let i = 0; i < 5; i++) {
      insertMemory(db, makeTestMemory(`list-${i}`, "test-tag"));
    }

    const { memories, total } = await listMemories("test-tag", 3, 0);
    expect(memories.length).toBe(3);
    expect(total).toBe(5);
  });

  test("returns second page", async () => {
    const db = getDb();
    for (let i = 0; i < 5; i++) {
      insertMemory(db, makeTestMemory(`page-${i}`, "test-tag"));
    }

    const { memories, total } = await listMemories("test-tag", 3, 3);
    expect(memories.length).toBe(2);
    expect(total).toBe(5);
  });

  test("returns empty for unknown tag", async () => {
    const { memories, total } = await listMemories("nonexistent-tag");
    expect(memories).toEqual([]);
    expect(total).toBe(0);
  });
});

// -- getContext ----------------------------------------------------------------

describe("getContext", () => {
  test("formats context with memories", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("ctx-1", "test-tag", {
        content: "Important project knowledge",
        epistemicStatus: { confidence: 0.85, evidenceCount: 2 },
      }),
    );

    const context = await getContext("test-tag");
    expect(context).toContain("[MEMORY]");
    expect(context).toContain("Project Knowledge:");
    expect(context).toContain("85%");
    expect(context).toContain("Important project knowledge");
  });

  test("returns empty string for no memories", async () => {
    const context = await getContext("empty-tag");
    expect(context).toBe("");
  });

  test("includes session suffix when provided", async () => {
    const db = getDb();
    insertMemory(db, makeTestMemory("ctx-2", "test-tag"));

    const context = await getContext("test-tag", "session-123");
    expect(context).toContain("session session-123");
  });

  test("excludes evicted memories", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("evicted-1", "test-tag", {
        content: "evicted memory",
        evictedAt: Date.now(),
      }),
    );

    const context = await getContext("test-tag");
    expect(context).toBe("");
  });

  test("includes user preferences from profile", async () => {
    const db = getDb();
    insertMemory(db, makeTestMemory("ctx-pref", "test-tag"));

    db.query(
      `INSERT INTO user_profiles (id, user_id, profile_data, version, created_at, last_analyzed_at, total_prompts_analyzed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "prof-1",
      "user-1",
      JSON.stringify({ preferences: { language: "Rust", editor: "neovim" } }),
      1,
      Date.now(),
      Date.now(),
      0,
    );

    const context = await getContext("test-tag");
    expect(context).toContain("User Preferences:");
    expect(context).toContain("[language] Rust");
    expect(context).toContain("[editor] neovim");
  });
});

// -- enforceTagBudget ---------------------------------------------------------

describe("enforceTagBudget", () => {
  test("evicts excess memories beyond 500 cap", async () => {
    const db = getDb();
    const tag = "budget-tag";
    const eightDaysAgo = Date.now() - 8 * 86_400_000;

    for (let i = 0; i < 500; i++) {
      insertMemory(
        db,
        makeTestMemory(`budget-${i}`, tag, {
          createdAt: eightDaysAgo,
          lastAccessedAt: eightDaysAgo,
          accessCount: 0,
        }),
      );
    }

    await addMemory({ content: "the 501st memory", containerTag: tag });

    const active = getAllActiveMemories(db).filter(
      (m) => m.containerTag === tag,
    );
    expect(active.length).toBe(500);
  });

  test("does not evict pinned memories", async () => {
    const db = getDb();
    const tag = "pin-budget-tag";
    const eightDaysAgo = Date.now() - 8 * 86_400_000;

    for (let i = 0; i < 499; i++) {
      insertMemory(
        db,
        makeTestMemory(`unpin-${i}`, tag, {
          createdAt: eightDaysAgo,
          lastAccessedAt: eightDaysAgo,
        }),
      );
    }
    insertMemory(
      db,
      makeTestMemory("pinned-mem", tag, {
        isPinned: true,
        createdAt: eightDaysAgo,
        lastAccessedAt: eightDaysAgo,
      }),
    );

    await addMemory({ content: "triggers eviction", containerTag: tag });

    const pinned = await getMemoryById("pinned-mem");
    expect(pinned).not.toBeNull();
    expect(pinned!.evictedAt).toBeNull();
  });

  test("does not evict when under budget", async () => {
    const db = getDb();
    const tag = "under-budget-tag";
    for (let i = 0; i < 5; i++) {
      insertMemory(db, makeTestMemory(`under-${i}`, tag));
    }

    await addMemory({ content: "another memory", containerTag: tag });

    const active = getAllActiveMemories(db).filter(
      (m) => m.containerTag === tag,
    );
    expect(active.length).toBe(6);
  });
});
