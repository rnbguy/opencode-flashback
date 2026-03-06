import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTesting, _setConfigForTesting } from "../src/config.ts";
import {
  closeDb,
  deleteMemory,
  getDb,
  insertMemory,
} from "../src/db/database.ts";
import {
  _resetSearchDepsForTesting,
  getSearchState,
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

describe("chartest-search", () => {
  let tmpDir: string;

  beforeEach(() => {
    closeDb();
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-chartest-search-"));
    getDb(join(tmpDir, "test.db"));
    _setConfigForTesting(defaultConfig);
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    _resetConfigForTesting();
    _resetSearchDepsForTesting();
  });

  // (1) hybridSearch returns ranked results with scores
  test("hybridSearch returns ranked results with scores", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("mem-1", "typescript async patterns", "proj", "typescript"),
    );
    insertMemory(
      db,
      makeMemory("mem-2", "rust ownership rules", "proj", "rust"),
    );
    await rebuildIndex();

    const results = await hybridSearch(
      "typescript",
      seededVector("typescript"),
      "proj",
      10,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].memory.id).toBe("mem-1");
    expect(typeof results[0].score).toBe("number");
  });

  // (2) hybridSearch respects limit parameter
  test("hybridSearch respects limit parameter", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("lim-1", "search result one", "proj", "search"),
    );
    insertMemory(
      db,
      makeMemory("lim-2", "search result two", "proj", "search"),
    );
    insertMemory(
      db,
      makeMemory("lim-3", "search result three", "proj", "search"),
    );
    await rebuildIndex();

    const results = await hybridSearch(
      "search result",
      seededVector("search"),
      "proj",
      2,
    );

    expect(results.length).toBeLessThanOrEqual(2);
  });

  // (3) hybridSearch filters by containerTag
  test("hybridSearch filters by containerTag", async () => {
    const db = getDb();
    insertMemory(db, makeMemory("tag-1", "shared content", "proj-a", "shared"));
    insertMemory(db, makeMemory("tag-2", "shared content", "proj-b", "shared"));
    await rebuildIndex();

    const resultsA = await hybridSearch(
      "shared content",
      seededVector("shared"),
      "proj-a",
      10,
    );
    const resultsB = await hybridSearch(
      "shared content",
      seededVector("shared"),
      "proj-b",
      10,
    );

    expect(resultsA.length).toBeGreaterThan(0);
    expect(resultsB.length).toBeGreaterThan(0);
    for (const r of resultsA) {
      expect(r.memory.containerTag).toBe("proj-a");
    }
    for (const r of resultsB) {
      expect(r.memory.containerTag).toBe("proj-b");
    }
  });

  // (4) hybridSearch returns empty results when no matches
  test("hybridSearch returns empty results when no matches", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("empty-1", "unrelated content", "proj", "unrelated"),
    );
    await rebuildIndex();

    const results = await hybridSearch(
      "nonexistent query",
      seededVector("nonexistent"),
      "proj",
      10,
    );

    expect(results).toEqual([]);
  });

  // (5) hybridSearch includes _debug.oramaScore in results
  test("hybridSearch includes _debug.oramaScore in results", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("dbg-1", "debug test content", "proj", "debug"),
    );
    await rebuildIndex();

    const results = await hybridSearch(
      "debug test",
      seededVector("debug"),
      "proj",
      10,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]._debug).toBeDefined();
    expect(typeof results[0]._debug?.oramaScore).toBe("number");
  });

  // (6) rebuildIndex indexes all active memories
  test("rebuildIndex indexes all active memories", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("rebuild-1", "indexed memory one", "proj", "indexed"),
    );
    insertMemory(
      db,
      makeMemory("rebuild-2", "indexed memory two", "proj", "indexed"),
    );
    await rebuildIndex();

    const results = await hybridSearch(
      "indexed memory",
      seededVector("indexed"),
      "proj",
      10,
    );

    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  // (7) markStale triggers rebuild on next search
  test("markStale triggers rebuild on next search", async () => {
    const db = getDb();
    insertMemory(db, makeMemory("stale-1", "stale content", "proj", "stale"));
    await rebuildIndex();

    markStale();

    // Add new memory after marking stale
    insertMemory(db, makeMemory("stale-2", "stale content", "proj", "stale"));

    const results = await hybridSearch(
      "stale content",
      seededVector("stale"),
      "proj",
      10,
    );

    // Should find both memories after rebuild
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  // (8) hybridSearch skips deleted memories
  test("hybridSearch skips deleted memories", async () => {
    const db = getDb();
    insertMemory(db, makeMemory("del-1", "deleted memory", "proj", "deleted"));
    insertMemory(db, makeMemory("del-2", "deleted memory", "proj", "deleted"));
    await rebuildIndex();

    deleteMemory(db, "del-1");

    const results = await hybridSearch(
      "deleted memory",
      seededVector("deleted"),
      "proj",
      10,
    );

    for (const r of results) {
      expect(r.memory.id).not.toBe("del-1");
    }
  });

  // (9) getSearchState returns a string
  test("getSearchState returns a string", () => {
    const state = getSearchState();
    expect(typeof state).toBe("string");
  });

  // (10) hybridSearch with zero limit returns empty
  test("hybridSearch with zero limit returns empty", async () => {
    const db = getDb();
    insertMemory(db, makeMemory("zero-1", "zero limit test", "proj", "zero"));
    await rebuildIndex();

    const results = await hybridSearch(
      "zero limit",
      seededVector("zero"),
      "proj",
      0,
    );

    expect(results.length).toBe(0);
  });

  // (11) hybridSearch with large limit returns all matches
  test("hybridSearch with large limit returns all matches", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("large-1", "large limit test", "proj", "large"),
    );
    insertMemory(
      db,
      makeMemory("large-2", "large limit test", "proj", "large"),
    );
    insertMemory(
      db,
      makeMemory("large-3", "large limit test", "proj", "large"),
    );
    await rebuildIndex();

    const results = await hybridSearch(
      "large limit",
      seededVector("large"),
      "proj",
      1000,
    );

    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  // (12) hybridSearch returns results with memory objects
  test("hybridSearch returns results with memory objects", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("obj-1", "object test content", "proj", "object"),
    );
    await rebuildIndex();

    const results = await hybridSearch(
      "object test",
      seededVector("object"),
      "proj",
      10,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].memory).toBeDefined();
    expect(results[0].memory.id).toBe("obj-1");
    expect(results[0].memory.content).toBe("object test content");
    expect(results[0].memory.containerTag).toBe("proj");
  });
});
