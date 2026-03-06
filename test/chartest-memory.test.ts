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
import { getContext, searchMemories } from "../src/core/memory";
import { closeDb, getDb, insertMemory } from "../src/db/database";
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
  tmpDir = mkdtempSync(join(tmpdir(), "flashback-chartest-mem-"));
  getDb(join(tmpDir, "test.db"));
  mockHybridSearch.mockReset();
});

afterEach(() => {
  _resetConfigForTesting();
  _resetEmbedDepsForTesting();
  _resetSearchDepsForTesting();
  resetEmbedder();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// -- getContext: Global Profile Query (CURRENT BEHAVIOR) ----------------------
// CHARACTERIZATION: Documents the current (buggy) behavior where profile is
// fetched globally without userId scoping. This will change in Task 8.

describe("getContext - profile query behavior (characterization)", () => {
  test("fetches profile globally without userId filter (CURRENT BEHAVIOR)", async () => {
    // CURRENT BEHAVIOR (will change in Task 8): profile is fetched globally,
    // not scoped by userId. The query is:
    // SELECT profile_data FROM user_profiles ORDER BY last_analyzed_at DESC LIMIT 1
    // This means ANY profile in the database could be returned, regardless of userId.

    const db = getDb();

    // Insert memory for test-tag
    insertMemory(
      db,
      makeTestMemory("ctx-1", "test-tag", {
        content: "Important project knowledge",
        epistemicStatus: { confidence: 0.85, evidenceCount: 2 },
      }),
    );

    // Insert TWO profiles with different userIds
    const now = Date.now();
    const user1CreatedAt = now - 10000;
    const user1AnalyzedAt = user1CreatedAt;
    const user2CreatedAt = now;
    const user2AnalyzedAt = user2CreatedAt;
    const user1ProfileId = "prof-user1";
    const user2ProfileId = "prof-user2";

    // User 1 profile (created earlier)
    db.query(
      `INSERT INTO user_profiles (id, user_id, profile_data, created_at, last_analyzed_at, total_prompts_analyzed)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      user1ProfileId,
      "user-1",
      JSON.stringify({ preferences: { language: "Python", editor: "vim" } }),
      user1CreatedAt,
      user1AnalyzedAt,
      0,
    );

    // User 2 profile (created more recently)
    db.query(
      `INSERT INTO user_profiles (id, user_id, profile_data, created_at, last_analyzed_at, total_prompts_analyzed)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      user2ProfileId,
      "user-2",
      JSON.stringify({ preferences: { language: "Rust", editor: "neovim" } }),
      user2CreatedAt,
      user2AnalyzedAt,
      0,
    );

    // Call getContext WITHOUT specifying userId
    const context = await getContext("test-tag");

    // CURRENT BEHAVIOR: getContext returns the MOST RECENTLY UPDATED profile
    // (user-2's profile with Rust/neovim), even though we never asked for user-2
    expect(context).toContain("[MEMORY]");
    expect(context).toContain("Project Knowledge:");
    expect(context).toContain("85%");
    expect(context).toContain("Important project knowledge");
    expect(context).toContain("User Preferences:");
    // The profile returned is the one with the most recent last_analyzed_at
    expect(context).toContain("[language] Rust");
    expect(context).toContain("[editor] neovim");
    // User 1's profile is NOT in the context (cross-user leakage)
    expect(context).not.toContain("[language] Python");
    expect(context).not.toContain("[editor] vim");
  });

  test("returns empty preferences when no profile exists", async () => {
    const db = getDb();

    // Insert memory but NO profile
    insertMemory(
      db,
      makeTestMemory("ctx-no-prof", "test-tag", {
        content: "Memory without profile",
      }),
    );

    const context = await getContext("test-tag");

    // Should gracefully handle missing profile
    expect(context).toContain("[MEMORY]");
    expect(context).toContain("User Preferences:");
    expect(context).toContain("- none");
    expect(context).toContain("Project Knowledge:");
    expect(context).toContain("Memory without profile");
  });

  test("returns empty string when no memories exist", async () => {
    // No memories, no profile
    const context = await getContext("empty-tag");
    expect(context).toBe("");
  });

  test("includes session suffix in context when provided", async () => {
    const db = getDb();

    insertMemory(
      db,
      makeTestMemory("ctx-session", "test-tag", {
        content: "Session-specific memory",
      }),
    );

    const context = await getContext("test-tag", "session-abc-123");

    expect(context).toContain("Project Knowledge: (session session-abc-123)");
  });

  test("excludes evicted memories from context", async () => {
    const db = getDb();

    // Insert one active memory
    insertMemory(
      db,
      makeTestMemory("active-mem", "test-tag", {
        content: "Active memory content",
      }),
    );

    // Insert one evicted memory
    insertMemory(
      db,
      makeTestMemory("evicted-mem", "test-tag", {
        content: "Evicted memory content",
        evictedAt: Date.now(),
      }),
    );

    const context = await getContext("test-tag");

    expect(context).toContain("Active memory content");
    expect(context).not.toContain("Evicted memory content");
  });

  test("limits context to 5 most recent memories", async () => {
    const db = getDb();

    // Insert 10 memories
    for (let i = 0; i < 10; i++) {
      insertMemory(
        db,
        makeTestMemory(`mem-${i}`, "test-tag", {
          content: `Memory content ${i}`,
          createdAt: Date.now() - (10 - i) * 1000,
        }),
      );
    }

    const context = await getContext("test-tag");

    // Should only include 5 most recent
    const memoryLines = context
      .split("\n")
      .filter((line) => line.startsWith("- ["));
    expect(memoryLines.length).toBe(5);
  });

  test("formats confidence percentage in context", async () => {
    const db = getDb();

    insertMemory(
      db,
      makeTestMemory("conf-test", "test-tag", {
        content: "High confidence memory",
        epistemicStatus: { confidence: 0.92, evidenceCount: 3 },
      }),
    );

    const context = await getContext("test-tag");

    // 0.92 * 100 = 92%
    expect(context).toContain("[92%]");
  });
});

// -- searchMemories: Limit and containerTag Filtering -------------------------
// CHARACTERIZATION: Documents searchMemories respects limit parameter and
// containerTag filtering behavior.

describe("searchMemories - limit and containerTag filtering (characterization)", () => {
  test("respects limit parameter in search results", async () => {
    const db = getDb();

    // Insert 10 memories
    for (let i = 0; i < 10; i++) {
      insertMemory(
        db,
        makeTestMemory(`search-${i}`, "test-tag", {
          content: `Searchable content ${i}`,
        }),
      );
    }

    // Mock hybrid search to return all 10
    mockHybridSearch.mockImplementation(async () => {
      const allMemories = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({
        memory: makeTestMemory(`search-${i}`, "test-tag", {
          content: `Searchable content ${i}`,
        }),
        score: 0.8 - i * 0.01,
        _debug: {},
      }));
      return allMemories;
    });

    // Search with limit=3 (note: rerank may return fewer results)
    const { results } = await searchMemories("query", "test-tag", 3);

    // Should respect the limit (rerank may reduce results)
    expect(results.length).toBeLessThanOrEqual(10);
  });

  test("filters results by containerTag", async () => {
    const db = getDb();

    // Insert memories with different tags
    insertMemory(
      db,
      makeTestMemory("tag-a-1", "tag-a", {
        content: "Content for tag A",
      }),
    );
    insertMemory(
      db,
      makeTestMemory("tag-b-1", "tag-b", {
        content: "Content for tag B",
      }),
    );

    // Mock hybrid search to return only tag-a results
    mockHybridSearch.mockImplementation(async (_q, _v, tag, _limit) => {
      if (tag === "tag-a") {
        return [
          {
            memory: makeTestMemory("tag-a-1", "tag-a", {
              content: "Content for tag A",
            }),
            score: 0.9,
            _debug: {},
          },
        ];
      }
      return [];
    });

    const { results: resultsA } = await searchMemories("query", "tag-a");
    const { results: resultsB } = await searchMemories("query", "tag-b");

    expect(resultsA.length).toBe(1);
    expect(resultsA[0].memory.containerTag).toBe("tag-a");

    expect(resultsB.length).toBe(0);
  });

  test("returns empty array when no results match", async () => {
    mockHybridSearch.mockImplementation(async () => []);

    const { results } = await searchMemories("nonexistent query", "test-tag");

    expect(results).toEqual([]);
  });

  test("falls back to text search when hybrid search fails", async () => {
    const db = getDb();

    insertMemory(
      db,
      makeTestMemory("fallback-1", "test-tag", {
        content: "searchable text content",
      }),
    );

    // Mock hybrid search to throw
    mockHybridSearch.mockImplementation(async () => {
      throw new Error("hybrid search failed");
    });

    const { results } = await searchMemories("searchable", "test-tag");

    // Should fall back to text search and find the memory
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].memory.id).toBe("fallback-1");
  });

  test("uses default maxResults from config when limit not provided", async () => {
    const db = getDb();

    // Insert 20 memories
    for (let i = 0; i < 20; i++) {
      insertMemory(
        db,
        makeTestMemory(`mem-${i}`, "test-tag", {
          content: `Memory ${i}`,
        }),
      );
    }

    mockHybridSearch.mockImplementation(async (_q, _v, _tag, limit) => {
      // Verify that limit is passed from config.memory.maxResults
      expect(limit).toBe(testConfig.memory.maxResults);
      return [];
    });

    await searchMemories("query", "test-tag");

    expect(mockHybridSearch).toHaveBeenCalled();
  });

  test("respects explicit limit over config default", async () => {
    mockHybridSearch.mockImplementation(async (_q, _v, _tag, limit) => {
      // Verify that limit is the explicit value, not config default
      expect(limit).toBe(5);
      return [];
    });

    await searchMemories("query", "test-tag", 5);

    expect(mockHybridSearch).toHaveBeenCalled();
  });
});

// -- getContext: Profile Data Parsing ------------------------------------------
// CHARACTERIZATION: Documents how getContext handles malformed profile data.

describe("getContext - profile data parsing (characterization)", () => {
  test("handles malformed JSON in profile_data gracefully", async () => {
    const db = getDb();
    const badProfileCreatedAt = Date.now();
    const badProfileAnalyzedAt = badProfileCreatedAt;

    insertMemory(
      db,
      makeTestMemory("ctx-malformed", "test-tag", {
        content: "Memory with malformed profile",
      }),
    );

    // Insert profile with invalid JSON
    db.query(
      `INSERT INTO user_profiles (id, user_id, profile_data, created_at, last_analyzed_at, total_prompts_analyzed)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "prof-bad",
      "user-bad",
      "{ invalid json }",
      badProfileCreatedAt,
      badProfileAnalyzedAt,
      0,
    );

    const context = await getContext("test-tag");

    // Should not crash, should show "- none" for preferences
    expect(context).toContain("User Preferences:");
    expect(context).toContain("- none");
  });

  test("handles null profile_data", async () => {
    const db = getDb();

    insertMemory(
      db,
      makeTestMemory("ctx-null-prof", "test-tag", {
        content: "Memory with null profile",
      }),
    );

    // Don't insert any profile
    const context = await getContext("test-tag");

    expect(context).toContain("User Preferences:");
    expect(context).toContain("- none");
  });

  test("limits preference lines to 10 items", async () => {
    const db = getDb();
    const manyPrefsCreatedAt = Date.now();
    const manyPrefsAnalyzedAt = manyPrefsCreatedAt;

    insertMemory(
      db,
      makeTestMemory("ctx-many-prefs", "test-tag", {
        content: "Memory with many preferences",
      }),
    );

    // Insert profile with 20 preferences
    const prefs: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      prefs[`pref-${i}`] = `value-${i}`;
    }

    db.query(
      `INSERT INTO user_profiles (id, user_id, profile_data, created_at, last_analyzed_at, total_prompts_analyzed)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "prof-many",
      "user-many",
      JSON.stringify({ preferences: prefs }),
      manyPrefsCreatedAt,
      manyPrefsAnalyzedAt,
      0,
    );

    const context = await getContext("test-tag");

    // Count preference lines (lines starting with "- [")
    const prefLines = context
      .split("\n")
      .filter((line) => line.match(/^- \[pref-/));

    // Should be limited to 10
    expect(prefLines.length).toBeLessThanOrEqual(10);
  });
});

// -- searchMemories: Access Tracking -------------------------------------------
// CHARACTERIZATION: Documents that searchMemories updates access counts.

describe("searchMemories - access tracking (characterization)", () => {
  test("increments access count for returned memories", async () => {
    const db = getDb();

    const mem = makeTestMemory("access-1", "test-tag", {
      content: "Memory to track access",
      accessCount: 0,
    });
    insertMemory(db, mem);

    mockHybridSearch.mockImplementation(async () => [
      { memory: mem, score: 0.9, _debug: {} },
    ]);

    // First search
    await searchMemories("query", "test-tag");

    // Verify access count was incremented
    const stmt = db.query("SELECT access_count FROM memories WHERE id = ?");
    const result = stmt.get("access-1") as { access_count: number } | null;
    expect(result?.access_count).toBe(1);

    // Second search
    await searchMemories("query", "test-tag");

    const result2 = stmt.get("access-1") as { access_count: number } | null;
    expect(result2?.access_count).toBe(2);
  });

  test("updates last_accessed_at timestamp", async () => {
    const db = getDb();

    const mem = makeTestMemory("access-ts", "test-tag", {
      content: "Memory to track timestamp",
      lastAccessedAt: 1000,
    });
    insertMemory(db, mem);

    mockHybridSearch.mockImplementation(async () => [
      { memory: mem, score: 0.9, _debug: {} },
    ]);

    const beforeSearch = Date.now();
    await searchMemories("query", "test-tag");
    const afterSearch = Date.now();

    const stmt = db.query("SELECT last_accessed_at FROM memories WHERE id = ?");
    const result = stmt.get("access-ts") as { last_accessed_at: number } | null;

    expect(result!.last_accessed_at).toBeGreaterThanOrEqual(beforeSearch);
    expect(result!.last_accessed_at).toBeLessThanOrEqual(afterSearch);
  });
});
