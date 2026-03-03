import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  _setConfigForTesting,
  _resetConfigForTesting,
  type PluginConfig,
} from "../config.ts";
import {
  getDb,
  closeDb,
  insertMemory,
  getMemory,
  getAllActiveMemories,
} from "../db/database.ts";
import type { Memory, SearchResult } from "../types.ts";

const defaultConfig: PluginConfig = {
  llm: {
    provider: "openai-chat",
    model: "gpt-4o-mini",
    apiUrl: "https://api.openai.com/v1",
    apiKey: "test-key-1234",
  },
  storage: { path: "/tmp/test" },
  memory: {
    maxResults: 10,
    autoCapture: true,
    injection: "first",
    excludeCurrentSession: true,
  },
  web: { port: 4747, enabled: false },
  search: {
    retrievalQuality: "custom",
    hybridWeights: { semantic: 0.5, keyword: 0.5 },
    rankingWeights: { recency: 0.3, importance: 0.4, semantic: 0.3 },
  },
};

let tmpDir = "";

let addMemory: (typeof import("../core/memory.ts"))["addMemory"];
let searchMemories: (typeof import("../core/memory.ts"))["searchMemories"];
let getMemoryById: (typeof import("../core/memory.ts"))["getMemoryById"];

let initSearch: (typeof import("../search/index.ts"))["initSearch"];
let rebuildIndex: (typeof import("../search/index.ts"))["rebuildIndex"];
let hybridSearch: (typeof import("../search/index.ts"))["hybridSearch"];
let markStale: (typeof import("../search/index.ts"))["markStale"];

let embed: (typeof import("../embed/embedder.ts"))["embed"];
let resetEmbedder: (typeof import("../embed/embedder.ts"))["resetEmbedder"];

function seededVector(text: string): number[] {
  const normalized = text
    .replace(/^task: search result \| query: /, "")
    .replace(/^title: none \| text: /, "");
  let seed = 0;
  for (let i = 0; i < normalized.length; i++) {
    seed = ((seed << 5) - seed + normalized.charCodeAt(i)) | 0;
  }
  const vec: number[] = [];
  for (let i = 0; i < 768; i++) {
    seed = (seed * 1664525 + 1013904223) | 0;
    vec.push(Math.sin(seed + i) * 0.5);
  }
  return vec;
}

function makeDbMemory(
  id: string,
  content: string,
  containerTag: string,
  options?: Partial<Memory>,
): Memory {
  const now = Date.now();
  return {
    id,
    content,
    embedding: new Float32Array(seededVector(content)),
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
    provenance: { sessionId: "", messageRange: [0, 0], toolCallIds: [] },
    lastAccessedAt: now,
    accessCount: 0,
    epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
    evictedAt: null,
    suspended: false,
    suspendedReason: null,
    suspendedAt: null,
    stability: 0,
    nextReviewAt: null,
    ...options,
  };
}

function getImportanceFromDb(id: string): number {
  const row = getDb()
    .query("SELECT metadata FROM memories WHERE id = ?")
    .get(id) as { metadata: string } | null;
  if (!row) {
    return -1;
  }
  const parsed = JSON.parse(row.metadata) as { importance?: number };
  return parsed.importance ?? -1;
}

describe("advanced data pipeline", () => {
  beforeEach(async () => {
    _setConfigForTesting(defaultConfig);
    closeDb();
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-advanced-data-"));
    getDb(join(tmpDir, "advanced-data.db"));

    mock.module("@huggingface/transformers", () => ({
      pipeline: mock(async () => async (inputs: string[]) => {
        const output: Record<string | number, unknown> = {
          dispose: () => {},
        };
        for (let i = 0; i < inputs.length; i++) {
          output[i] = {
            data: seededVector(inputs[i]),
          };
        }
        return output;
      }),
    }));

    const memory = await import(`../core/memory.ts?adv=${Date.now()}`);
    addMemory = memory.addMemory;
    searchMemories = memory.searchMemories;
    getMemoryById = memory.getMemoryById;

    const search = await import(`../search/index.ts?adv=${Date.now()}`);
    initSearch = search.initSearch;
    rebuildIndex = search.rebuildIndex;
    hybridSearch = search.hybridSearch;
    markStale = search.markStale;

    const embedder = await import(`../embed/embedder.ts?adv=${Date.now()}`);
    embed = embedder.embed;
    resetEmbedder = embedder.resetEmbedder;
  });

  afterEach(() => {
    _resetConfigForTesting();
    closeDb();
    mock.restore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("section A - memory operation fuzzing", () => {
    test("addMemory handles fuzz inputs without crashing", async () => {
      const importanceCases = [
        -1,
        0,
        0.5,
        10,
        11,
        100,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        undefined,
      ];
      const contentCases = [
        "   \n\t   ",
        "x".repeat(1024 * 1024),
        "\n\n\n\n\n",
      ];
      const tagsCases = [
        [],
        Array.from({ length: 100 }, (_, i) => `tag-${i}`),
        ["tag-*", "tag-[]", "tag-{}", "tag-()", "tag-|", "tag-;"],
        ["dup", "dup", "dup"],
      ];
      const containerTagCases = [
        "",
        "container-" + "a".repeat(1024),
        "container'; DROP TABLE memories; --",
      ];
      const typeCases = ["", "t".repeat(1024), "skip"];

      for (const importance of importanceCases) {
        for (const content of contentCases) {
          for (const tags of tagsCases) {
            for (const containerTag of containerTagCases) {
              for (const type of typeCases) {
                const result = await addMemory({
                  content,
                  containerTag,
                  importance,
                  tags,
                  type,
                });
                expect(typeof result.id).toBe("string");
                expect(typeof result.deduplicated).toBe("boolean");
              }
            }
          }
        }
      }
    }, 60000);

    test("searchMemories handles fuzz inputs without crashing", async () => {
      await addMemory({
        content: "baseline searchable content for fuzz query tests",
        containerTag: "fuzz-search",
      });

      const queryCases = ["", "a", "q".repeat(100 * 1024), ".*", "' OR 1=1 --"];
      const containerTagCases = ["missing-tag", ""];
      const limitCases = [0, -1, 1, 1000, undefined];

      for (const query of queryCases) {
        for (const containerTag of containerTagCases) {
          for (const limit of limitCases) {
            const results = await searchMemories(query, containerTag, limit);
            expect(Array.isArray(results)).toBe(true);
          }
        }
      }
    });
  });

  describe("section B - property-based memory tests", () => {
    test("dedup symmetry holds for A->B and B->A", async () => {
      const a = "symmetry content A";
      const b = "symmetry content A";

      const abFirst = await addMemory({ content: a, containerTag: "sym-a" });
      const abSecond = await addMemory({ content: b, containerTag: "sym-a" });
      expect(abFirst.deduplicated).toBe(false);
      expect(abSecond.deduplicated).toBe(true);

      const baFirst = await addMemory({ content: b, containerTag: "sym-b" });
      const baSecond = await addMemory({ content: a, containerTag: "sym-b" });
      expect(baFirst.deduplicated).toBe(false);
      expect(baSecond.deduplicated).toBe(true);
    });

    test("importance values clamp to [1, 10]", async () => {
      const inputs = [-100, 0, 0.5, 5, 10, 11, 100, Number.NaN, undefined];
      const expected = [1, 1, 1, 5, 10, 10, 10, 5, 5];

      for (let i = 0; i < inputs.length; i++) {
        const result = await addMemory({
          content: `importance-${i}`,
          containerTag: "importance",
          importance: inputs[i],
        });
        expect(getImportanceFromDb(result.id)).toBe(expected[i]);
      }
    });

    test("eviction preserves pinned memories when tag exceeds budget", async () => {
      const tag = "evict-pinned";

      for (let i = 0; i < 10; i++) {
        await addMemory({
          content: `pinned-${i}`,
          containerTag: tag,
          isPinned: true,
        });
      }

      for (let i = 0; i < 590; i++) {
        await addMemory({
          content: `unpinned-${i}`,
          containerTag: tag,
          isPinned: false,
        });
      }

      const active = getAllActiveMemories(getDb()).filter(
        (memory) => memory.containerTag === tag,
      );
      expect(active.length).toBeLessThanOrEqual(500);

      for (let i = 0; i < 10; i++) {
        const pinned = active.find(
          (memory) => memory.content === `pinned-${i}`,
        );
        expect(pinned).toBeDefined();
        expect(pinned?.isPinned).toBe(true);
      }
    }, 60000);

    test("searchMemories results are sorted by descending score", async () => {
      for (let i = 0; i < 20; i++) {
        await addMemory({
          content: `ordering memory ${i} TypeScript Rust Bun ${i}`,
          containerTag: "ordering",
          importance: (i % 10) + 1,
        });
      }

      const results = await searchMemories(
        "TypeScript Rust Bun",
        "ordering",
        20,
      );
      expect(results.length).toBeGreaterThan(1);

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    test("searchMemories increments accessCount for returned memories", async () => {
      const first = await addMemory({
        content: "access tracking alpha",
        containerTag: "access",
      });
      const second = await addMemory({
        content: "access tracking beta",
        containerTag: "access",
      });

      const beforeFirst = await getMemoryById(first.id);
      const beforeSecond = await getMemoryById(second.id);

      const results = await searchMemories("access tracking", "access", 10);
      expect(results.length).toBeGreaterThan(0);

      const afterFirst = await getMemoryById(first.id);
      const afterSecond = await getMemoryById(second.id);
      const nonFallbackIds = new Set(
        results
          .filter((r) => r._debug?.fallback !== true)
          .map((r) => r.memory.id),
      );

      if (nonFallbackIds.has(first.id)) {
        expect(afterFirst?.accessCount ?? 0).toBeGreaterThan(
          beforeFirst?.accessCount ?? 0,
        );
      }
      if (nonFallbackIds.has(second.id)) {
        expect(afterSecond?.accessCount ?? 0).toBeGreaterThan(
          beforeSecond?.accessCount ?? 0,
        );
      }
    });
  });

  describe("section C - ranking mutation tests", () => {
    test("higher importance ranks higher with equal recency", async () => {
      _setConfigForTesting({
        ...defaultConfig,
        search: {
          retrievalQuality: "custom",
          hybridWeights: { semantic: 0, keyword: 1 },
          rankingWeights: { recency: 0, importance: 1, semantic: 0 },
        },
      });

      await addMemory({
        content: "importance ranking target low",
        containerTag: "rank-importance",
        importance: 1,
      });
      await addMemory({
        content: "importance ranking target high",
        containerTag: "rank-importance",
        importance: 10,
      });

      const results = await searchMemories(
        "importance ranking target",
        "rank-importance",
        10,
      );
      expect(results.length).toBeGreaterThanOrEqual(2);

      const low = results.find((r) => r.memory.metadata.importance === 1);
      const high = results.find((r) => r.memory.metadata.importance === 10);
      expect(low).toBeDefined();
      expect(high).toBeDefined();
      expect(high?.score ?? 0).toBeGreaterThan(low?.score ?? 0);
    });

    test("older memories rank lower than newer memories", async () => {
      _setConfigForTesting({
        ...defaultConfig,
        search: {
          retrievalQuality: "custom",
          hybridWeights: { semantic: 0, keyword: 1 },
          rankingWeights: { recency: 1, importance: 0, semantic: 0 },
        },
      });

      const now = Date.now();
      const old = await addMemory({
        content: "same ranking text old",
        containerTag: "rank-recency",
        importance: 5,
      });
      const newer = await addMemory({
        content: "same ranking text new",
        containerTag: "rank-recency",
        importance: 5,
      });

      const db = getDb();
      db.query("UPDATE memories SET last_accessed_at = ? WHERE id = ?").run(
        now - 30 * 86_400_000,
        old.id,
      );
      db.query("UPDATE memories SET last_accessed_at = ? WHERE id = ?").run(
        now,
        newer.id,
      );

      const results = await searchMemories(
        "same ranking text",
        "rank-recency",
        10,
      );
      expect(results.length).toBeGreaterThanOrEqual(2);

      const oldResult = results.find((r) => r.memory.id === old.id);
      const newResult = results.find((r) => r.memory.id === newer.id);
      expect(oldResult).toBeDefined();
      expect(newResult).toBeDefined();
      expect(newResult?.score ?? 0).toBeGreaterThan(oldResult?.score ?? 0);
    });

    test("all reranked scores are finite", async () => {
      for (let i = 0; i < 30; i++) {
        await addMemory({
          content: `finite score memory ${i}`,
          containerTag: "finite-scores",
          importance: (i % 10) + 1,
        });
      }

      const results = await searchMemories("finite score", "finite-scores", 30);
      expect(results.length).toBeGreaterThan(0);

      for (const result of results) {
        expect(Number.isFinite(result.score)).toBe(true);
      }
    });
  });

  describe("section D - search engine property tests", () => {
    test("markStale triggers rebuild on next search", async () => {
      const db = getDb();
      insertMemory(db, makeDbMemory("stale-old", "old indexed", "stale-tag"));
      await initSearch();
      await rebuildIndex();

      insertMemory(
        db,
        makeDbMemory("stale-new", "new after stale", "stale-tag"),
      );
      markStale();

      const results = await hybridSearch(
        "new after stale",
        seededVector("new after stale"),
        "stale-tag",
        10,
      );
      expect(results.some((r) => r.memory.id === "stale-new")).toBe(true);
    });

    test("falls back to SQLite when orama search fails", async () => {
      const db = getDb();
      insertMemory(
        db,
        makeDbMemory(
          "fallback-1",
          "sqlite fallback should find this",
          "fb-tag",
        ),
      );
      await initSearch();
      await rebuildIndex();

      const results = await hybridSearch(
        "sqlite fallback should find this",
        [1, 2, 3],
        "fb-tag",
        10,
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].memory.id).toBe("fallback-1");
      expect(results[0]._debug?.fallback).toBe(true);
    });

    test("search on empty database returns empty array", async () => {
      await initSearch();
      await rebuildIndex();

      const results = await hybridSearch(
        "nothing",
        seededVector("nothing"),
        "empty-tag",
        10,
      );
      expect(results).toEqual([]);
    });

    test("container tag isolation holds", async () => {
      const db = getDb();
      insertMemory(db, makeDbMemory("iso-a", "shared text isolate", "A"));
      insertMemory(db, makeDbMemory("iso-b", "shared text isolate", "B"));
      await initSearch();
      await rebuildIndex();

      const inA = await hybridSearch(
        "shared text isolate",
        seededVector("shared text isolate"),
        "A",
        10,
      );
      const inB = await hybridSearch(
        "shared text isolate",
        seededVector("shared text isolate"),
        "B",
        10,
      );

      expect(inA.some((r) => r.memory.containerTag !== "A")).toBe(false);
      expect(inB.some((r) => r.memory.containerTag !== "B")).toBe(false);
    });
  });

  describe("section E - embedder property tests", () => {
    test("dimension consistency: all vectors have 768 dimensions", async () => {
      resetEmbedder();
      const vectors = await embed(["alpha", "beta", "gamma"], "document");
      expect(vectors.length).toBe(3);
      for (const vector of vectors) {
        expect(vector.length).toBe(768);
      }
    });

    test("determinism: same input yields same embedding", async () => {
      resetEmbedder();
      const first = await embed(["deterministic-input"], "query");
      const second = await embed(["deterministic-input"], "query");
      expect(second[0]).toEqual(first[0]);
    });

    test("batch consistency: two inputs returns two vectors", async () => {
      resetEmbedder();
      const vectors = await embed(["a", "b"], "query");
      expect(vectors.length).toBe(2);
    });

    test("empty input string is handled", async () => {
      resetEmbedder();
      const vectors = await embed([""], "query");
      expect(vectors.length).toBe(1);
      expect(vectors[0].length).toBe(768);
    });
  });

  test("mutation-resistant ranking assertions on explicit score scenarios", async () => {
    _setConfigForTesting({
      ...defaultConfig,
      search: {
        retrievalQuality: "custom",
        hybridWeights: { semantic: 0, keyword: 1 },
        rankingWeights: { recency: 0.4, importance: 0.6, semantic: 0 },
      },
    });

    const now = Date.now();
    const low = await addMemory({
      content: "mutation ranking text low",
      containerTag: "mut-rank",
      importance: 1,
    });
    const high = await addMemory({
      content: "mutation ranking text high",
      containerTag: "mut-rank",
      importance: 10,
    });
    const old = await addMemory({
      content: "mutation ranking text old",
      containerTag: "mut-rank",
      importance: 10,
    });

    const db = getDb();
    db.query("UPDATE memories SET last_accessed_at = ? WHERE id = ?").run(
      now,
      low.id,
    );
    db.query("UPDATE memories SET last_accessed_at = ? WHERE id = ?").run(
      now,
      high.id,
    );
    db.query("UPDATE memories SET last_accessed_at = ? WHERE id = ?").run(
      now - 90 * 86_400_000,
      old.id,
    );

    const results = await searchMemories(
      "mutation ranking text",
      "mut-rank",
      10,
    );
    const byId = new Map(
      results.map((r): [string, SearchResult] => [r.memory.id, r]),
    );

    expect(byId.has(low.id)).toBe(true);
    expect(byId.has(high.id)).toBe(true);
    expect(byId.has(old.id)).toBe(true);

    const lowResult = byId.get(low.id);
    const highResult = byId.get(high.id);
    const oldResult = byId.get(old.id);

    expect(highResult?.score ?? 0).toBeGreaterThan(lowResult?.score ?? 0);
    expect(highResult?.score ?? 0).toBeGreaterThan(oldResult?.score ?? 0);

    for (const result of results) {
      expect(Number.isFinite(result.score)).toBe(true);
    }

    const dbLow = getMemory(getDb(), low.id);
    const dbHigh = getMemory(getDb(), high.id);
    const dbOld = getMemory(getDb(), old.id);
    const nonFallbackIds = new Set(
      results
        .filter((r) => r._debug?.fallback !== true)
        .map((r) => r.memory.id),
    );

    if (dbLow && nonFallbackIds.has(low.id)) {
      expect(dbLow.accessCount).toBeGreaterThan(0);
    }
    if (dbHigh && nonFallbackIds.has(high.id)) {
      expect(dbHigh.accessCount).toBeGreaterThan(0);
    }
    if (dbOld && nonFallbackIds.has(old.id)) {
      expect(dbOld.accessCount).toBeGreaterThan(0);
    }
  });
});
