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
  cosineSimilarity,
  exportMemories,
  findRelatedMemories,
  getMemoriesForReview,
  getMemoryById,
  listMemoriesPage,
  rateMemory,
  starMemory,
  suspendMemory,
  unstarMemory,
} from "../src/core/memory";
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
    hybridSearch: (...args: unknown[]) =>
      mockHybridSearch(...(args as [string, number[], string, number])),
    markStale: () => {},
    rebuildIndex: async () => {},
    getSearchState: () => "ready" as const,
  });
  resetEmbedder();
  closeDb();
  tmpDir = mkdtempSync(join(tmpdir(), "flashback-mem-ext-"));
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

// -- getMemoryById ------------------------------------------------------------

describe("getMemoryById", () => {
  test("returns memory when it exists", async () => {
    const db = getDb();
    const mem = makeTestMemory("get-1", "test-tag", { content: "findable" });
    insertMemory(db, mem);

    const result = await getMemoryById("get-1");
    expect(result).not.toBeNull();
    expect(result!.content).toBe("findable");
  });

  test("returns null for nonexistent id", async () => {
    const result = await getMemoryById("nonexistent-id");
    expect(result).toBeNull();
  });
});

// -- listMemoriesPage ---------------------------------------------------------

describe("listMemoriesPage", () => {
  test("returns paginated memories with total count", async () => {
    const db = getDb();
    for (let i = 0; i < 7; i++) {
      insertMemory(db, makeTestMemory(`page-${i}`, "test-tag"));
    }

    const { memories, total } = await listMemoriesPage("test-tag", 3, 0);
    expect(memories.length).toBe(3);
    expect(total).toBe(7);
  });

  test("returns offset page", async () => {
    const db = getDb();
    for (let i = 0; i < 7; i++) {
      insertMemory(db, makeTestMemory(`page-${i}`, "test-tag"));
    }

    const { memories, total } = await listMemoriesPage("test-tag", 3, 6);
    expect(memories.length).toBe(1);
    expect(total).toBe(7);
  });

  test("returns empty for unknown tag", async () => {
    const { memories, total } = await listMemoriesPage("ghost-tag", 10, 0);
    expect(memories).toEqual([]);
    expect(total).toBe(0);
  });
});

// -- exportMemories -----------------------------------------------------------

describe("exportMemories", () => {
  test("exports memories as JSON", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("exp-1", "test-tag", {
        content: "exported content",
        type: "note",
        tags: ["rust"],
      }),
    );

    const { data, count } = await exportMemories("test-tag", "json");
    expect(count).toBe(1);
    const parsed = JSON.parse(data);
    expect(parsed).toBeArray();
    expect(parsed[0].id).toBe("exp-1");
    expect(parsed[0].content).toBe("exported content");
    expect(parsed[0].tags).toEqual(["rust"]);
  });

  test("exports memories as markdown", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("exp-md-1", "test-tag", {
        content: "markdown content",
        type: "feature",
        tags: ["wasm", "rust"],
      }),
    );

    const { data, count } = await exportMemories("test-tag", "markdown");
    expect(count).toBe(1);
    expect(data).toContain("## feature");
    expect(data).toContain("markdown content");
    expect(data).toContain("Tags: wasm, rust");
    expect(data).toContain("Created:");
  });

  test("exports empty when no memories match", async () => {
    const { data, count } = await exportMemories("empty-tag", "json");
    expect(count).toBe(0);
    expect(JSON.parse(data)).toEqual([]);
  });

  test("excludes evicted memories from export", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("exp-evict", "test-tag", {
        content: "evicted",
        evictedAt: Date.now(),
      }),
    );
    insertMemory(
      db,
      makeTestMemory("exp-active", "test-tag", {
        content: "active",
      }),
    );

    const { count } = await exportMemories("test-tag", "json");
    expect(count).toBe(1);
  });

  test("markdown export with no tags omits tag line", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("exp-notag", "test-tag", {
        content: "no tags here",
        tags: [],
      }),
    );

    const { data } = await exportMemories("test-tag", "markdown");
    expect(data).not.toContain("Tags:");
  });
});

// -- findRelatedMemories ------------------------------------------------------

describe("findRelatedMemories", () => {
  test("delegates to searchMemories and returns results", async () => {
    const db = getDb();
    const mem = makeTestMemory("rel-1", "test-tag", {
      content: "related content",
    });
    insertMemory(db, mem);

    mockHybridSearch.mockImplementation(async () => [
      { memory: mem, score: 0.9, _debug: {} },
    ]);

    const results = await findRelatedMemories("related", "test-tag");
    expect(results.length).toBe(1);
    expect(results[0].memory.id).toBe("rel-1");
  });

  test("respects limit parameter", async () => {
    const db = getDb();
    const mem1 = makeTestMemory("rel-2", "test-tag");
    const mem2 = makeTestMemory("rel-3", "test-tag");
    insertMemory(db, mem1);
    insertMemory(db, mem2);

    mockHybridSearch.mockImplementation(async () => [
      { memory: mem1, score: 0.9, _debug: {} },
      { memory: mem2, score: 0.8, _debug: {} },
    ]);

    const results = await findRelatedMemories("topic", "test-tag", 5);
    expect(results.length).toBe(2);
  });

  test("returns empty when no matches", async () => {
    mockHybridSearch.mockImplementation(async () => []);
    const results = await findRelatedMemories("nothing", "test-tag");
    expect(results).toEqual([]);
  });
});

// -- suspendMemory ------------------------------------------------------------

describe("suspendMemory", () => {
  test("suspends an existing memory", async () => {
    const db = getDb();
    insertMemory(db, makeTestMemory("susp-1", "test-tag"));

    const result = await suspendMemory("susp-1", "too noisy");
    expect(result).toBe(true);

    const mem = await getMemoryById("susp-1");
    expect(mem).not.toBeNull();
    expect(mem!.suspended).toBe(true);
    expect(mem!.suspendedReason).toBe("too noisy");
    expect(mem!.suspendedAt).toBeGreaterThan(0);
  });

  test("suspends with null reason", async () => {
    const db = getDb();
    insertMemory(db, makeTestMemory("susp-2", "test-tag"));

    const result = await suspendMemory("susp-2", null);
    expect(result).toBe(true);

    const mem = await getMemoryById("susp-2");
    expect(mem!.suspended).toBe(true);
    expect(mem!.suspendedReason).toBeNull();
  });

  test("returns false for nonexistent memory", async () => {
    const result = await suspendMemory("no-such-id", "reason");
    expect(result).toBe(false);
  });
});

// -- starMemory ----------------------------------------------------------------

describe("starMemory", () => {
  test("pins an existing memory", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("star-1", "test-tag", { isStarred: false }),
    );

    const result = await starMemory("star-1");
    expect(result).toBe(true);

    const mem = await getMemoryById("star-1");
    expect(mem!.isStarred).toBe(true);
  });

  test("returns false for nonexistent memory", async () => {
    const result = await starMemory("no-such-star");
    expect(result).toBe(false);
  });
});

// -- unstarMemory --------------------------------------------------------------

describe("unstarMemory", () => {
  test("unpins an existing memory", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("unstar-1", "test-tag", { isStarred: true }),
    );

    const result = await unstarMemory("unstar-1");
    expect(result).toBe(true);

    const mem = await getMemoryById("unstar-1");
    expect(mem!.isStarred).toBe(false);
  });

  test("returns false for nonexistent memory", async () => {
    const result = await unstarMemory("no-such-unstar");
    expect(result).toBe(false);
  });
});

// -- rateMemory ---------------------------------------------------------------

describe("rateMemory", () => {
  test("rates memory and updates FSRS schedule", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("rate-1", "test-tag", {
        stability: 1.0,
        difficulty: 5.0,
      }),
    );

    const result = await rateMemory("rate-1", 4);
    expect(result.success).toBe(true);
    expect(result.nextReviewAt).toBeGreaterThan(Date.now());

    const mem = await getMemoryById("rate-1");
    expect(mem!.stability).not.toBe(1.0);
    expect(mem!.nextReviewAt).toBe(result.nextReviewAt);
  });

  test("low rating decreases stability", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("rate-low", "test-tag", {
        stability: 2.0,
        difficulty: 5.0,
      }),
    );

    const result = await rateMemory("rate-low", 1);
    expect(result.success).toBe(true);

    const mem = await getMemoryById("rate-low");
    expect(mem!.stability).toBeLessThan(2.0);
  });

  test("returns failure for nonexistent memory", async () => {
    const result = await rateMemory("no-such-rate", 3);
    expect(result.success).toBe(false);
    expect(result.nextReviewAt).toBeNull();
  });
});

// -- getMemoriesForReview -----------------------------------------------------

describe("getMemoriesForReview", () => {
  test("returns memories due for review", async () => {
    const db = getDb();
    const pastReview = Date.now() - 86_400_000;
    insertMemory(
      db,
      makeTestMemory("review-1", "test-tag", {
        nextReviewAt: pastReview,
        suspended: false,
      }),
    );

    const results = await getMemoriesForReview("test-tag");
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("review-1");
  });

  test("excludes suspended memories", async () => {
    const db = getDb();
    const pastReview = Date.now() - 86_400_000;
    insertMemory(
      db,
      makeTestMemory("review-susp", "test-tag", {
        nextReviewAt: pastReview,
        suspended: true,
        suspendedAt: Date.now(),
      }),
    );

    const results = await getMemoriesForReview("test-tag");
    expect(results).toEqual([]);
  });

  test("excludes evicted memories", async () => {
    const db = getDb();
    const pastReview = Date.now() - 86_400_000;
    insertMemory(
      db,
      makeTestMemory("review-evict", "test-tag", {
        nextReviewAt: pastReview,
        evictedAt: Date.now(),
      }),
    );

    const results = await getMemoriesForReview("test-tag");
    expect(results).toEqual([]);
  });

  test("excludes memories not yet due", async () => {
    const db = getDb();
    const futureReview = Date.now() + 86_400_000 * 30;
    insertMemory(
      db,
      makeTestMemory("review-future", "test-tag", {
        nextReviewAt: futureReview,
      }),
    );

    const results = await getMemoriesForReview("test-tag");
    expect(results).toEqual([]);
  });

  test("excludes memories with null nextReviewAt", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("review-null", "test-tag", {
        nextReviewAt: null,
      }),
    );

    const results = await getMemoriesForReview("test-tag");
    expect(results).toEqual([]);
  });

  test("respects limit parameter", async () => {
    const db = getDb();
    const pastReview = Date.now() - 86_400_000;
    for (let i = 0; i < 5; i++) {
      insertMemory(
        db,
        makeTestMemory(`review-lim-${i}`, "test-tag", {
          nextReviewAt: pastReview - i * 1000,
        }),
      );
    }

    const results = await getMemoriesForReview("test-tag", 2);
    expect(results.length).toBe(2);
  });

  test("sorts by nextReviewAt ascending (oldest first)", async () => {
    const db = getDb();
    const now = Date.now();
    insertMemory(
      db,
      makeTestMemory("review-new", "test-tag", {
        nextReviewAt: now - 1000,
      }),
    );
    insertMemory(
      db,
      makeTestMemory("review-old", "test-tag", {
        nextReviewAt: now - 86_400_000,
      }),
    );

    const results = await getMemoriesForReview("test-tag");
    expect(results[0].id).toBe("review-old");
    expect(results[1].id).toBe("review-new");
  });

  test("filters by container tag", async () => {
    const db = getDb();
    const pastReview = Date.now() - 86_400_000;
    insertMemory(
      db,
      makeTestMemory("review-a", "tag-a", { nextReviewAt: pastReview }),
    );
    insertMemory(
      db,
      makeTestMemory("review-b", "tag-b", { nextReviewAt: pastReview }),
    );

    const results = await getMemoriesForReview("tag-a");
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("review-a");
  });
});

// -- cosineSimilarity ---------------------------------------------------------

describe("cosineSimilarity", () => {
  test("returns similarity between identical vectors", () => {
    const vec = seededVector("test");
    const sim = cosineSimilarity(vec, vec);
    expect(sim).toBeCloseTo(1.0, 4);
  });

  test("returns 0 for empty vectors", () => {
    const sim = cosineSimilarity([], []);
    expect(sim).toBe(0);
  });

  test("returns 0 for mismatched lengths", () => {
    const sim = cosineSimilarity([1, 2, 3], [1, 2]);
    expect(sim).toBe(0);
  });

  test("returns lower similarity for different vectors", () => {
    const a = seededVector("alpha");
    const b = seededVector("completely different text");
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeLessThan(1.0);
    expect(sim).toBeGreaterThan(-1.0);
  });
});
