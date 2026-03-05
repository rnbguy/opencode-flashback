import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { _resetConfigForTesting, _setConfigForTesting } from "../src/config";
import {
  _resetEmbedDepsForTesting,
  _setEmbedDepsForTesting,
  resetEmbedder,
} from "../src/core/ai/embed";
import type { createEmbeddingProvider } from "../src/core/ai/providers";
import {
  applyConsolidation,
  consolidateMemories,
} from "../src/core/consolidate";
import { closeDb, getDb, getMemory, insertMemory } from "../src/db/database";
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

function makeVectorWithSimilarity(
  base: number[],
  targetSimilarity: number,
): number[] {
  const arb = base.map((v, i) => (i === 0 ? v + 1 : v));
  const dot = base.reduce((s, v, i) => s + v * arb[i], 0);
  const perp = arb.map((v, i) => v - dot * base[i]);
  const pNorm = Math.sqrt(perp.reduce((s, v) => s + v * v, 0));
  const perpUnit = perp.map((v) => v / pNorm);
  const s = targetSimilarity;
  const p = Math.sqrt(1 - s * s);
  const result = base.map((v, i) => s * v + p * perpUnit[i]);
  const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
  return result.map((v) => v / norm);
}

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
    hybridSearch: async () => [],
    markStale: () => {},
    rebuildIndex: async () => {},
    getSearchState: () => "ready" as const,
  });
  resetEmbedder();
  closeDb();
  tmpDir = mkdtempSync(join(tmpdir(), "flashback-consolidate-"));
  getDb(join(tmpDir, "test.db"));
});

afterEach(() => {
  _resetConfigForTesting();
  _resetEmbedDepsForTesting();
  _resetSearchDepsForTesting();
  resetEmbedder();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// -- consolidateMemories ------------------------------------------------------

describe("consolidateMemories", () => {
  test("returns empty when no memories exist", async () => {
    const result = await consolidateMemories({
      containerTag: "test-tag",
      dryRun: false,
    });
    expect(result.candidates).toEqual([]);
    expect(result.merged).toBe(0);
  });

  test("returns empty when only one memory exists", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("single-1", "test-tag", {
        embedding: new Float32Array(seededVector("single content")),
      }),
    );

    const result = await consolidateMemories({
      containerTag: "test-tag",
      dryRun: false,
    });
    expect(result.candidates).toEqual([]);
    expect(result.merged).toBe(0);
  });

  test("returns no candidates for dissimilar memories", async () => {
    const db = getDb();
    const vecA = new Float32Array(768);
    vecA[0] = 1.0;
    const vecB = new Float32Array(768);
    vecB[1] = 1.0;
    insertMemory(
      db,
      makeTestMemory("dissim-1", "test-tag", { embedding: vecA }),
    );
    insertMemory(
      db,
      makeTestMemory("dissim-2", "test-tag", { embedding: vecB }),
    );

    const result = await consolidateMemories({
      containerTag: "test-tag",
      dryRun: false,
    });
    expect(result.candidates).toEqual([]);
    expect(result.merged).toBe(0);
  });

  test("identifies exact duplicates in dry-run mode", async () => {
    const db = getDb();
    const vec = seededVector("exact duplicate content");
    insertMemory(
      db,
      makeTestMemory("dup-1", "test-tag", {
        embedding: new Float32Array(vec),
        content: "exact duplicate content",
        tags: ["alpha"],
        epistemicStatus: { confidence: 0.9, evidenceCount: 2 },
      }),
    );
    insertMemory(
      db,
      makeTestMemory("dup-2", "test-tag", {
        embedding: new Float32Array(vec),
        content: "exact duplicate content",
        tags: ["beta"],
        epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
      }),
    );

    const result = await consolidateMemories({
      containerTag: "test-tag",
      dryRun: true,
    });
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].reason).toBe("duplicate");
    expect(result.candidates[0].similarity).toBe(1);
    expect(result.candidates[0].memoryIds.sort()).toEqual(["dup-1", "dup-2"]);
    expect(result.candidates[0].suggestion).toContain("Keep dup-1");
    expect(result.candidates[0].suggestion).toContain("0.90");
    expect(result.candidates[0].suggestion).toContain("alpha");
    expect(result.candidates[0].suggestion).toContain("beta");
    expect(result.merged).toBe(0);
  });

  test("merges exact duplicates when not dry-run", async () => {
    const db = getDb();
    const vec = seededVector("merge test content");
    insertMemory(
      db,
      makeTestMemory("merge-1", "test-tag", {
        embedding: new Float32Array(vec),
        content: "merge test content",
        epistemicStatus: { confidence: 0.9, evidenceCount: 3 },
        accessCount: 10,
        createdAt: 1000000,
      }),
    );
    insertMemory(
      db,
      makeTestMemory("merge-2", "test-tag", {
        embedding: new Float32Array(vec),
        content: "merge test content",
        epistemicStatus: { confidence: 0.8, evidenceCount: 1 },
        accessCount: 5,
        createdAt: 2000000,
      }),
    );

    const result = await consolidateMemories({
      containerTag: "test-tag",
      dryRun: false,
    });
    expect(result.candidates.length).toBe(1);
    expect(result.merged).toBe(1);

    const survivor = getMemory(db, "merge-1");
    expect(survivor).not.toBeNull();
    expect(survivor!.evictedAt).toBeNull();

    const loser = getMemory(db, "merge-2");
    expect(loser).not.toBeNull();
    expect(loser!.evictedAt).not.toBeNull();
  });

  test("identifies near-duplicates", async () => {
    const db = getDb();
    const baseVec = seededVector("near duplicate base");
    const nearVec = makeVectorWithSimilarity(baseVec, 0.88);
    insertMemory(
      db,
      makeTestMemory("near-1", "test-tag", {
        embedding: new Float32Array(baseVec),
      }),
    );
    insertMemory(
      db,
      makeTestMemory("near-2", "test-tag", {
        embedding: new Float32Array(nearVec),
      }),
    );

    const result = await consolidateMemories({
      containerTag: "test-tag",
      dryRun: true,
    });
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].reason).toBe("near-duplicate");
    expect(result.candidates[0].similarity).toBeGreaterThanOrEqual(0.85);
    expect(result.candidates[0].similarity).toBeLessThan(0.92);
  });

  test("only considers memories with matching containerTag", async () => {
    const db = getDb();
    const vec = seededVector("cross tag content");
    insertMemory(
      db,
      makeTestMemory("tag-a", "alpha", {
        embedding: new Float32Array(vec),
      }),
    );
    insertMemory(
      db,
      makeTestMemory("tag-b", "beta", {
        embedding: new Float32Array(vec),
      }),
    );

    const result = await consolidateMemories({
      containerTag: "alpha",
      dryRun: true,
    });
    expect(result.candidates).toEqual([]);
  });

  test("ignores evicted memories", async () => {
    const db = getDb();
    const vec = seededVector("evicted ignore test");
    insertMemory(
      db,
      makeTestMemory("active-1", "test-tag", {
        embedding: new Float32Array(vec),
      }),
    );
    insertMemory(
      db,
      makeTestMemory("evicted-1", "test-tag", {
        embedding: new Float32Array(vec),
        evictedAt: Date.now(),
      }),
    );

    const result = await consolidateMemories({
      containerTag: "test-tag",
      dryRun: true,
    });
    expect(result.candidates).toEqual([]);
  });

  test("handles multiple groups of duplicates", async () => {
    const db = getDb();
    const vecA = new Float32Array(768);
    vecA[0] = 1.0;
    const vecB = new Float32Array(768);
    vecB[1] = 1.0;
    insertMemory(
      db,
      makeTestMemory("a-1", "test-tag", {
        embedding: new Float32Array(vecA),
      }),
    );
    insertMemory(
      db,
      makeTestMemory("a-2", "test-tag", {
        embedding: new Float32Array(vecA),
      }),
    );
    insertMemory(
      db,
      makeTestMemory("b-1", "test-tag", {
        embedding: new Float32Array(vecB),
      }),
    );
    insertMemory(
      db,
      makeTestMemory("b-2", "test-tag", {
        embedding: new Float32Array(vecB),
      }),
    );

    const result = await consolidateMemories({
      containerTag: "test-tag",
      dryRun: true,
    });
    expect(result.candidates.length).toBe(2);
  });

  test("groups three or more duplicates together", async () => {
    const db = getDb();
    const vec = seededVector("triple content");
    insertMemory(
      db,
      makeTestMemory("tri-1", "test-tag", {
        embedding: new Float32Array(vec),
        epistemicStatus: { confidence: 0.9, evidenceCount: 1 },
      }),
    );
    insertMemory(
      db,
      makeTestMemory("tri-2", "test-tag", {
        embedding: new Float32Array(vec),
        epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
      }),
    );
    insertMemory(
      db,
      makeTestMemory("tri-3", "test-tag", {
        embedding: new Float32Array(vec),
        epistemicStatus: { confidence: 0.5, evidenceCount: 1 },
      }),
    );

    const result = await consolidateMemories({
      containerTag: "test-tag",
      dryRun: false,
    });
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].memoryIds.sort()).toEqual([
      "tri-1",
      "tri-2",
      "tri-3",
    ]);
    expect(result.merged).toBe(2);

    const survivor = getMemory(db, "tri-1");
    expect(survivor!.evictedAt).toBeNull();

    const loser1 = getMemory(db, "tri-2");
    expect(loser1!.evictedAt).not.toBeNull();

    const loser2 = getMemory(db, "tri-3");
    expect(loser2!.evictedAt).not.toBeNull();
  });
});

// -- applyConsolidation -------------------------------------------------------

describe("applyConsolidation", () => {
  test("returns 0 for empty candidates", async () => {
    const merged = await applyConsolidation([]);
    expect(merged).toBe(0);
  });

  test("skips candidates where memory IDs are missing", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("exists-1", "test-tag", {
        embedding: new Float32Array(seededVector("exists")),
      }),
    );

    const merged = await applyConsolidation([
      {
        memoryIds: ["exists-1", "nonexistent"],
        reason: "duplicate",
        similarity: 1.0,
        suggestion: "test",
      },
    ]);
    expect(merged).toBe(0);
  });

  test("skips candidates where all memories are evicted", async () => {
    const db = getDb();
    const vec = seededVector("evicted pair");
    insertMemory(
      db,
      makeTestMemory("ev-1", "test-tag", {
        embedding: new Float32Array(vec),
        evictedAt: Date.now(),
      }),
    );
    insertMemory(
      db,
      makeTestMemory("ev-2", "test-tag", {
        embedding: new Float32Array(vec),
        evictedAt: Date.now(),
      }),
    );

    const merged = await applyConsolidation([
      {
        memoryIds: ["ev-1", "ev-2"],
        reason: "duplicate",
        similarity: 1.0,
        suggestion: "test",
      },
    ]);
    expect(merged).toBe(0);
  });

  test("merges tags, confidence, accessCount, and createdAt", async () => {
    const db = getDb();
    const vec = seededVector("apply merge content");
    insertMemory(
      db,
      makeTestMemory("apply-1", "test-tag", {
        embedding: new Float32Array(vec),
        content: "apply merge content",
        tags: ["tag-a", "shared"],
        epistemicStatus: { confidence: 0.95, evidenceCount: 5 },
        accessCount: 20,
        createdAt: 1000000,
      }),
    );
    insertMemory(
      db,
      makeTestMemory("apply-2", "test-tag", {
        embedding: new Float32Array(vec),
        content: "apply merge content",
        tags: ["tag-b", "shared"],
        epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
        accessCount: 5,
        createdAt: 2000000,
      }),
    );

    const merged = await applyConsolidation([
      {
        memoryIds: ["apply-1", "apply-2"],
        reason: "duplicate",
        similarity: 1.0,
        suggestion: "test",
      },
    ]);
    expect(merged).toBe(1);

    const survivor = getMemory(db, "apply-1");
    expect(survivor).not.toBeNull();
    expect(survivor!.tags.sort()).toEqual(["shared", "tag-a", "tag-b"]);
    expect(survivor!.epistemicStatus.confidence).toBe(0.95);
    expect(survivor!.accessCount).toBe(20);
    expect(survivor!.createdAt).toBe(1000000);
    expect(survivor!.metadata.mergedFromCount).toBe(1);
    expect(survivor!.evictedAt).toBeNull();

    const loser = getMemory(db, "apply-2");
    expect(loser!.evictedAt).not.toBeNull();
  });

  test("handles multiple candidates", async () => {
    const db = getDb();
    const vecA = seededVector("multi candidate a");
    const vecB = seededVector("multi candidate b");
    insertMemory(
      db,
      makeTestMemory("mc-a1", "test-tag", {
        embedding: new Float32Array(vecA),
        content: "multi candidate a",
      }),
    );
    insertMemory(
      db,
      makeTestMemory("mc-a2", "test-tag", {
        embedding: new Float32Array(vecA),
        content: "multi candidate a",
      }),
    );
    insertMemory(
      db,
      makeTestMemory("mc-b1", "test-tag", {
        embedding: new Float32Array(vecB),
        content: "multi candidate b",
      }),
    );
    insertMemory(
      db,
      makeTestMemory("mc-b2", "test-tag", {
        embedding: new Float32Array(vecB),
        content: "multi candidate b",
      }),
    );

    const merged = await applyConsolidation([
      {
        memoryIds: ["mc-a1", "mc-a2"],
        reason: "duplicate",
        similarity: 1.0,
        suggestion: "test",
      },
      {
        memoryIds: ["mc-b1", "mc-b2"],
        reason: "duplicate",
        similarity: 1.0,
        suggestion: "test",
      },
    ]);
    expect(merged).toBe(2);
  });
});

// -- chooseSurvivor (via applyConsolidation) ----------------------------------

describe("chooseSurvivor", () => {
  test("picks memory with highest confidence", async () => {
    const db = getDb();
    const vec = seededVector("confidence test");
    insertMemory(
      db,
      makeTestMemory("low-conf", "test-tag", {
        embedding: new Float32Array(vec),
        content: "confidence test",
        epistemicStatus: { confidence: 0.5, evidenceCount: 1 },
      }),
    );
    insertMemory(
      db,
      makeTestMemory("high-conf", "test-tag", {
        embedding: new Float32Array(vec),
        content: "confidence test",
        epistemicStatus: { confidence: 0.95, evidenceCount: 1 },
      }),
    );

    await applyConsolidation([
      {
        memoryIds: ["low-conf", "high-conf"],
        reason: "duplicate",
        similarity: 1.0,
        suggestion: "test",
      },
    ]);

    const survivor = getMemory(db, "high-conf");
    expect(survivor!.evictedAt).toBeNull();
    const loser = getMemory(db, "low-conf");
    expect(loser!.evictedAt).not.toBeNull();
  });

  test("breaks ties with higher accessCount", async () => {
    const db = getDb();
    const vec = seededVector("access count test");
    insertMemory(
      db,
      makeTestMemory("low-access", "test-tag", {
        embedding: new Float32Array(vec),
        content: "access count test",
        epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
        accessCount: 2,
      }),
    );
    insertMemory(
      db,
      makeTestMemory("high-access", "test-tag", {
        embedding: new Float32Array(vec),
        content: "access count test",
        epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
        accessCount: 50,
      }),
    );

    await applyConsolidation([
      {
        memoryIds: ["low-access", "high-access"],
        reason: "duplicate",
        similarity: 1.0,
        suggestion: "test",
      },
    ]);

    const survivor = getMemory(db, "high-access");
    expect(survivor!.evictedAt).toBeNull();
    const loser = getMemory(db, "low-access");
    expect(loser!.evictedAt).not.toBeNull();
  });

  test("breaks ties with earlier createdAt", async () => {
    const db = getDb();
    const vec = seededVector("created at test");
    insertMemory(
      db,
      makeTestMemory("newer", "test-tag", {
        embedding: new Float32Array(vec),
        content: "created at test",
        epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
        accessCount: 5,
        createdAt: 2000000,
      }),
    );
    insertMemory(
      db,
      makeTestMemory("older", "test-tag", {
        embedding: new Float32Array(vec),
        content: "created at test",
        epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
        accessCount: 5,
        createdAt: 1000000,
      }),
    );

    await applyConsolidation([
      {
        memoryIds: ["newer", "older"],
        reason: "duplicate",
        similarity: 1.0,
        suggestion: "test",
      },
    ]);

    const survivor = getMemory(db, "older");
    expect(survivor!.evictedAt).toBeNull();
    const loser = getMemory(db, "newer");
    expect(loser!.evictedAt).not.toBeNull();
  });

  test("breaks ties with lexical id order", async () => {
    const db = getDb();
    const vec = seededVector("lexical id test");
    const now = 5000000;
    insertMemory(
      db,
      makeTestMemory("zzz-id", "test-tag", {
        embedding: new Float32Array(vec),
        content: "lexical id test",
        epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
        accessCount: 5,
        createdAt: now,
      }),
    );
    insertMemory(
      db,
      makeTestMemory("aaa-id", "test-tag", {
        embedding: new Float32Array(vec),
        content: "lexical id test",
        epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
        accessCount: 5,
        createdAt: now,
      }),
    );

    await applyConsolidation([
      {
        memoryIds: ["zzz-id", "aaa-id"],
        reason: "duplicate",
        similarity: 1.0,
        suggestion: "test",
      },
    ]);

    const survivor = getMemory(db, "aaa-id");
    expect(survivor!.evictedAt).toBeNull();
    const loser = getMemory(db, "zzz-id");
    expect(loser!.evictedAt).not.toBeNull();
  });
});
