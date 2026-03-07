import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SearchResult } from "../src/types";

// -- Module mocks (hoisted by Bun) --------------------------------------------

const mockHybridSearch = mock(
  async (
    _q: string,
    _v: number[],
    _tag: string,
    _limit: number,
  ): Promise<SearchResult[]> => [],
);

// -- Imports (resolved after mocks) -------------------------------------------

import { _resetConfigForTesting, _setConfigForTesting } from "../src/config";
import {
  _resetEmbedDepsForTesting,
  _setEmbedDepsForTesting,
  resetEmbedder,
} from "../src/core/ai/embed";
import type { createEmbeddingProvider } from "../src/core/ai/providers";
import {
  _resetEnforceTagBudgetForTesting,
  _setEnforceTagBudgetForTesting,
  addMemory,
  forgetMemory,
  getContext,
  getMemoryById,
  listMemories,
  recallMemories,
  searchMemories,
} from "../src/core/memory";
import {
  closeDb,
  getAllActiveMemories,
  getDb,
  insertMemory,
} from "../src/db/database";
import {
  _resetSearchDepsForTesting,
  _setSearchDepsForTesting,
} from "../src/search";
import { makeTestConfig } from "./fixtures/config";
import { makeTestMemory } from "./fixtures/memory";
import { seededVector } from "./fixtures/vectors";

// -- Helpers ------------------------------------------------------------------

let tmpDir: string;

const testConfig = makeTestConfig({ storage: { path: "/tmp" } });

beforeEach(() => {
  _setConfigForTesting(testConfig);
  _setEmbedDepsForTesting({
    embedMany: (async ({ values }: { values: string[] }) => ({
      embeddings: values.map((value) => seededVector(value)),
    })) as unknown as typeof import("ai").embedMany,
    createEmbeddingProvider: (async () => ({
      embedding: (_id: string) => ({}),
    })) as unknown as typeof createEmbeddingProvider,
  });
  _setSearchDepsForTesting({
    initSearch: async () => {},
    hybridSearch: async (...args: unknown[]) => {
      const results = await mockHybridSearch(
        ...(args as [string, number[], string, number]),
      );
      return { results, totalCount: results.length };
    },
    markStale: () => {},
    rebuildIndex: async () => {},
    getSearchState: () => "ready" as const,
  });
  resetEmbedder();
  closeDb();
  tmpDir = mkdtempSync(join(tmpdir(), "flashback-mem-"));
  getDb(join(tmpDir, "test.db"));
  mockHybridSearch.mockReset();
});

afterEach(() => {
  _resetConfigForTesting();
  _resetEmbedDepsForTesting();
  _resetSearchDepsForTesting();
  _resetEnforceTagBudgetForTesting();
  resetEmbedder();
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

  test("deduplicates concurrent identical addMemory calls", async () => {
    _setEmbedDepsForTesting({
      embedMany: (async ({ values }: { values: string[] }) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          embeddings: values.map((value) => seededVector(value)),
        };
      }) as unknown as typeof import("ai").embedMany,
    });
    resetEmbedder();

    const [first, second] = await Promise.all([
      addMemory({
        content: "concurrent dedup content",
        containerTag: "test-tag",
      }),
      addMemory({
        content: "concurrent dedup content",
        containerTag: "test-tag",
      }),
    ]);

    const memories = getAllActiveMemories(getDb()).filter(
      (memory) => memory.containerTag === "test-tag",
    );

    expect(memories).toHaveLength(1);
    expect(first.deduplicated).toBe(false);
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

  test("succeeds even when enforceTagBudget throws", async () => {
    _setEnforceTagBudgetForTesting(async () => {
      throw new Error("budget-enforcement-fail");
    });

    const result = await addMemory({
      content: "memory that survives budget failure",
      containerTag: "test-tag",
    });

    expect(result.id).toBeTruthy();
    expect(result.deduplicated).toBe(false);

    _resetEnforceTagBudgetForTesting();
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

    const { results } = await searchMemories("query", "test-tag");
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

    const { results } = await searchMemories("searchable", "test-tag");
    expect(results.length).toBe(1);
    expect(results[0].memory.id).toBe("fallback-1");
  });

  test("returns empty for no matches", async () => {
    mockHybridSearch.mockImplementation(async () => []);
    const { results } = await searchMemories("nonexistent", "test-tag");
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
    const createdAt = Date.now();
    const analyzedAt = createdAt;
    insertMemory(db, makeTestMemory("ctx-pref", "test-tag"));

    db.query(
      `INSERT INTO user_profiles (id, user_id, profile_data, created_at, last_analyzed_at, total_prompts_analyzed)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "prof-1",
      "user-1",
      JSON.stringify({ preferences: { language: "Rust", editor: "neovim" } }),
      createdAt,
      analyzedAt,
      0,
    );

    const context = await getContext(
      "test-tag",
      undefined,
      undefined,
      "user-1",
    );
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

  test("does not evict starred memories", async () => {
    const db = getDb();
    const tag = "star-budget-tag";
    const eightDaysAgo = Date.now() - 8 * 86_400_000;

    for (let i = 0; i < 499; i++) {
      insertMemory(
        db,
        makeTestMemory(`unstar-${i}`, tag, {
          createdAt: eightDaysAgo,
          lastAccessedAt: eightDaysAgo,
        }),
      );
    }
    insertMemory(
      db,
      makeTestMemory("starred-mem", tag, {
        isStarred: true,
        createdAt: eightDaysAgo,
        lastAccessedAt: eightDaysAgo,
      }),
    );

    await addMemory({ content: "triggers eviction", containerTag: tag });

    const starred = await getMemoryById("starred-mem");
    expect(starred).not.toBeNull();
    expect(starred!.evictedAt).toBeNull();
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
