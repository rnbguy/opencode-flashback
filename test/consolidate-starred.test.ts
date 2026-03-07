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
import { applyConsolidation } from "../src/core/consolidate";
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
    hybridSearch: async () => ({ results: [], totalCount: 0 }),
    markStale: () => {},
    rebuildIndex: async () => {},
    getSearchState: () => "ready" as const,
  });
  resetEmbedder();
  closeDb();
  tmpDir = mkdtempSync(join(tmpdir(), "flashback-consolidate-starred-"));
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

// -- chooseSurvivor with starred preference --------------------------------

describe("chooseSurvivor with starred preference", () => {
  test("prefers starred memory over higher confidence unstarred", async () => {
    const db = getDb();
    const vec = seededVector("starred preference test");
    insertMemory(
      db,
      makeTestMemory("starred-low-conf", "test-tag", {
        embedding: new Float32Array(vec),
        content: "starred preference test",
        isStarred: true,
        epistemicStatus: { confidence: 0.5, evidenceCount: 1 },
      }),
    );
    insertMemory(
      db,
      makeTestMemory("unstarred-high-conf", "test-tag", {
        embedding: new Float32Array(vec),
        content: "starred preference test",
        isStarred: false,
        epistemicStatus: { confidence: 0.95, evidenceCount: 5 },
      }),
    );

    await applyConsolidation([
      {
        memoryIds: ["starred-low-conf", "unstarred-high-conf"],
        reason: "duplicate",
        similarity: 1.0,
        suggestion: "test",
      },
    ]);

    const survivor = getMemory(db, "starred-low-conf");
    expect(survivor).not.toBeNull();
    expect(survivor!.evictedAt).toBeNull();
    expect(survivor!.isStarred).toBe(true);

    const loser = getMemory(db, "unstarred-high-conf");
    expect(loser).not.toBeNull();
    expect(loser!.evictedAt).not.toBeNull();
  });

  test("guards starred loser from eviction in multi-memory group", async () => {
    const db = getDb();
    const vec = seededVector("starred multi guard test");
    insertMemory(
      db,
      makeTestMemory("starred-survivor", "test-tag", {
        embedding: new Float32Array(vec),
        content: "starred multi guard test",
        isStarred: true,
        epistemicStatus: { confidence: 0.5, evidenceCount: 1 },
      }),
    );
    insertMemory(
      db,
      makeTestMemory("starred-loser", "test-tag", {
        embedding: new Float32Array(vec),
        content: "starred multi guard test",
        isStarred: true,
        epistemicStatus: { confidence: 0.7, evidenceCount: 2 },
      }),
    );
    insertMemory(
      db,
      makeTestMemory("unstarred-loser", "test-tag", {
        embedding: new Float32Array(vec),
        content: "starred multi guard test",
        isStarred: false,
        epistemicStatus: { confidence: 0.95, evidenceCount: 10 },
      }),
    );

    await applyConsolidation([
      {
        memoryIds: ["starred-survivor", "starred-loser", "unstarred-loser"],
        reason: "duplicate",
        similarity: 1.0,
        suggestion: "test",
      },
    ]);

    // First starred should be survivor
    const survivor = getMemory(db, "starred-survivor");
    expect(survivor).not.toBeNull();
    expect(survivor!.evictedAt).toBeNull();
    expect(survivor!.isStarred).toBe(true);

    // Second starred should be guarded from eviction
    const starredLoser = getMemory(db, "starred-loser");
    expect(starredLoser).not.toBeNull();
    expect(starredLoser!.evictedAt).toBeNull();
    expect(starredLoser!.isStarred).toBe(true);

    // Unstarred should be evicted
    const unstarredLoser = getMemory(db, "unstarred-loser");
    expect(unstarredLoser).not.toBeNull();
    expect(unstarredLoser!.evictedAt).not.toBeNull();
  });

  test("picks first starred when multiple starred in group", async () => {
    const db = getDb();
    const vec = seededVector("multiple starred test");
    insertMemory(
      db,
      makeTestMemory("starred-first", "test-tag", {
        embedding: new Float32Array(vec),
        content: "multiple starred test",
        isStarred: true,
        epistemicStatus: { confidence: 0.5, evidenceCount: 1 },
        createdAt: 1000000,
      }),
    );
    insertMemory(
      db,
      makeTestMemory("starred-second", "test-tag", {
        embedding: new Float32Array(vec),
        content: "multiple starred test",
        isStarred: true,
        epistemicStatus: { confidence: 0.9, evidenceCount: 5 },
        createdAt: 2000000,
      }),
    );
    insertMemory(
      db,
      makeTestMemory("unstarred", "test-tag", {
        embedding: new Float32Array(vec),
        content: "multiple starred test",
        isStarred: false,
        epistemicStatus: { confidence: 0.95, evidenceCount: 10 },
        createdAt: 3000000,
      }),
    );

    await applyConsolidation([
      {
        memoryIds: ["starred-first", "starred-second", "unstarred"],
        reason: "duplicate",
        similarity: 1.0,
        suggestion: "test",
      },
    ]);

    // First starred should be survivor
    const survivor = getMemory(db, "starred-first");
    expect(survivor).not.toBeNull();
    expect(survivor!.evictedAt).toBeNull();
    expect(survivor!.isStarred).toBe(true);

    // Second starred should be guarded from eviction
    const starredLoser = getMemory(db, "starred-second");
    expect(starredLoser).not.toBeNull();
    expect(starredLoser!.evictedAt).toBeNull();
    expect(starredLoser!.isStarred).toBe(true);

    // Unstarred should be evicted
    const unstarredLoser = getMemory(db, "unstarred");
    expect(unstarredLoser).not.toBeNull();
    expect(unstarredLoser!.evictedAt).not.toBeNull();
  });
});
