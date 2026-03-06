import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTesting, _setConfigForTesting } from "../src/config.ts";
import { closeDb, getDb, insertMemory } from "../src/db/database.ts";
import {
  _resetSearchDepsForTesting,
  _setSearchDepsForTesting,
  hybridSearch,
  markStale,
  rebuildIndex,
} from "../src/search.ts";
import type { Memory } from "../src/types.ts";
import { makeTestConfig } from "./fixtures/config.ts";
import { seededVector } from "./fixtures/vectors.ts";

const defaultConfig = makeTestConfig();

function makeMemory(
  id: string,
  content: string,
  containerTag: string,
  vectorText: string,
): Memory {
  const now = Date.now();
  return {
    id,
    content,
    embedding: new Float32Array(seededVector(vectorText)),
    containerTag,
    tags: ["test"],
    type: "knowledge",
    isStarred: false,
    createdAt: now,
    updatedAt: now,
    metadata: {},
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
    difficulty: 5.0,
    nextReviewAt: null,
  };
}

describe("search-observability", () => {
  let tmpDir: string;

  beforeEach(() => {
    closeDb();
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-search-observability-"));
    getDb(join(tmpDir, "test.db"));
    _setConfigForTesting(defaultConfig);
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    _resetConfigForTesting();
    _resetSearchDepsForTesting();
  });

  // (1) hybridSearch fallback includes _debug.reason when rebuildIndex fails
  test("hybridSearch fallback includes _debug.reason when rebuildIndex fails", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("obs-1", "fallback test content", "proj", "fallback"),
    );
    await rebuildIndex();
    markStale();

    // Mock rebuildIndex to throw an error to trigger fallback
    _setSearchDepsForTesting({
      rebuildIndex: async () => {
        throw new Error("Orama rebuild failed");
      },
    });

    const results = await hybridSearch(
      "fallback test",
      seededVector("fallback"),
      "proj",
      10,
    );

    // Should have fallback results
    expect(results.length).toBeGreaterThan(0);
    // All results should have fallback flag
    for (const result of results) {
      expect(result._debug?.fallback).toBe(true);
    }
    // All results should have reason field
    for (const result of results) {
      expect(result._debug?.reason).toBeDefined();
      expect(typeof result._debug?.reason).toBe("string");
    }
  });

  // (2) hybridSearch fallback reason contains error message
  test("hybridSearch fallback reason contains error message", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("obs-2", "error message test", "proj", "error"),
    );
    await rebuildIndex();
    markStale();

    const errorMsg = "Vector database connection timeout";
    _setSearchDepsForTesting({
      rebuildIndex: async () => {
        throw new Error(errorMsg);
      },
    });

    const results = await hybridSearch(
      "error message test",
      seededVector("error"),
      "proj",
      10,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]._debug?.reason).toContain(errorMsg);
  });

  // (3) hybridSearch fallback reason is "unknown error" when error is not Error instance
  test("hybridSearch fallback reason is 'unknown error' when error is not Error instance", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("obs-3", "unknown error test", "proj", "unknown"),
    );
    await rebuildIndex();
    markStale();

    _setSearchDepsForTesting({
      rebuildIndex: async () => {
        // eslint-disable-next-line no-throw-literal
        throw "string error";
      },
    });

    const results = await hybridSearch(
      "unknown error test",
      seededVector("unknown"),
      "proj",
      10,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]._debug?.reason).toBe("unknown error");
  });

  // (4) hybridSearch fallback results have oramaScore of 0
  test("hybridSearch fallback results have oramaScore of 0", async () => {
    const db = getDb();
    insertMemory(db, makeMemory("obs-4", "orama score test", "proj", "orama"));
    await rebuildIndex();
    markStale();

    _setSearchDepsForTesting({
      rebuildIndex: async () => {
        throw new Error("Orama failed");
      },
    });

    const results = await hybridSearch(
      "orama score test",
      seededVector("orama"),
      "proj",
      10,
    );

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result._debug?.oramaScore).toBe(0);
    }
  });

  // (5) hybridSearch fallback respects limit parameter
  test("hybridSearch fallback respects limit parameter", async () => {
    const db = getDb();
    insertMemory(db, makeMemory("obs-5a", "limit test one", "proj", "limit"));
    insertMemory(db, makeMemory("obs-5b", "limit test two", "proj", "limit"));
    insertMemory(db, makeMemory("obs-5c", "limit test three", "proj", "limit"));
    await rebuildIndex();
    markStale();

    _setSearchDepsForTesting({
      rebuildIndex: async () => {
        throw new Error("Orama failed");
      },
    });

    const results = await hybridSearch(
      "limit test",
      seededVector("limit"),
      "proj",
      2,
    );

    expect(results.length).toBeLessThanOrEqual(2);
    for (const result of results) {
      expect(result._debug?.fallback).toBe(true);
    }
  });

  // (6) hybridSearch fallback filters by containerTag
  test("hybridSearch fallback filters by containerTag", async () => {
    const db = getDb();
    insertMemory(db, makeMemory("obs-6a", "tag filter test", "proj-a", "tag"));
    insertMemory(db, makeMemory("obs-6b", "tag filter test", "proj-b", "tag"));
    await rebuildIndex();
    markStale();

    _setSearchDepsForTesting({
      rebuildIndex: async () => {
        throw new Error("Orama failed");
      },
    });

    const resultsA = await hybridSearch(
      "tag filter test",
      seededVector("tag"),
      "proj-a",
      10,
    );

    expect(resultsA.length).toBeGreaterThan(0);
    for (const result of resultsA) {
      expect(result.memory.containerTag).toBe("proj-a");
      expect(result._debug?.fallback).toBe(true);
    }
  });

  // (7) hybridSearch fallback returns empty when no text matches
  test("hybridSearch fallback returns empty when no text matches", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("obs-7", "unrelated content", "proj", "unrelated"),
    );
    await rebuildIndex();
    markStale();

    _setSearchDepsForTesting({
      rebuildIndex: async () => {
        throw new Error("Orama failed");
      },
    });

    const results = await hybridSearch(
      "nonexistent query xyz",
      seededVector("nonexistent"),
      "proj",
      10,
    );

    expect(results).toEqual([]);
  });

  // (8) hybridSearch fallback score is always 0
  test("hybridSearch fallback score is always 0", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("obs-8", "score test content", "proj", "score"),
    );
    await rebuildIndex();
    markStale();

    _setSearchDepsForTesting({
      rebuildIndex: async () => {
        throw new Error("Orama failed");
      },
    });

    const results = await hybridSearch(
      "score test",
      seededVector("score"),
      "proj",
      10,
    );

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.score).toBe(0);
    }
  });
});
