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
  _setSearchDepsForTesting,
  getSearchState,
  hybridSearch,
  initSearch,
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
    isPinned: false,
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

// IMPORTANT: Tests are ordered to account for module-level state persistence.
// oramaDb, state, isStale, rebuildPromise persist across tests within this file.
// Only `deps` is reset via _resetSearchDepsForTesting() in afterEach.

describe("search-extended", () => {
  let tmpDir: string;

  beforeEach(() => {
    closeDb();
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-search-ext-"));
    getDb(join(tmpDir, "test.db"));
    _setConfigForTesting(defaultConfig);
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    _resetConfigForTesting();
    _resetSearchDepsForTesting();
  });

  // (1) DI-based auto-init test: override both initSearch and hybridSearch
  // to verify the wrapper delegation works correctly.
  test("hybridSearch delegates to DI override", async () => {
    let hybridCalled = false;
    _setSearchDepsForTesting({
      hybridSearch: async (_q, _v, _tag, _limit) => {
        hybridCalled = true;
        return [];
      },
    });
    const results = await hybridSearch(
      "test",
      seededVector("test"),
      "proj",
      10,
    );
    expect(hybridCalled).toBe(true);
    expect(results).toEqual([]);
  });

  // (2) initSearch error path via DI: override initSearch to throw,
  // verifying the wrapper propagates errors correctly.
  test("initSearch propagates errors from DI override", async () => {
    _setSearchDepsForTesting({
      initSearch: async () => {
        throw new Error("init fail");
      },
    });
    let caught = false;
    try {
      await initSearch();
    } catch {
      caught = true;
    }
    expect(caught).toBe(true);
  });

  // (3) initSearch is idempotent: second call returns early (oramaDb set).
  test("initSearch is idempotent", async () => {
    await initSearch();
    const stateAfterFirst = getSearchState();
    // Second call is a no-op because oramaDb is already set
    await initSearch();
    expect(getSearchState()).toBe(stateAfterFirst);
  });

  // (4) Recovery: rebuildIndex + markStale + hybridSearch sets state="ready"
  test("markStale causes rebuild on next hybridSearch", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("stale-1", "stale search content", "proj", "stale"),
    );
    await rebuildIndex();
    markStale();
    const results = await hybridSearch(
      "stale search content",
      seededVector("stale"),
      "proj",
      10,
    );
    expect(getSearchState()).toBe("ready");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  // (5) getSearchState returns current state
  test("getSearchState returns ready after recovery", () => {
    expect(getSearchState()).toBe("ready");
  });

  // (6) rebuildIndex with data
  test("rebuildIndex indexes current memories", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("idx-1", "indexed content here", "proj", "idx"),
    );
    await rebuildIndex();
    const results = await hybridSearch(
      "indexed content",
      seededVector("idx"),
      "proj",
      10,
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].memory.id).toBe("idx-1");
  });

  // (7) Concurrent rebuildIndex calls are serialized via promise chain
  test("concurrent rebuildIndex calls are serialized", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("ser-1", "serialized rebuild content", "proj", "serial"),
    );
    const p1 = rebuildIndex();
    const p2 = rebuildIndex();
    await Promise.all([p1, p2]);
    const results = await hybridSearch(
      "serialized rebuild",
      seededVector("serial"),
      "proj",
      10,
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  // (8) hybridSearch skips memories deleted from DB but still in Orama index
  test("hybridSearch skips memories removed from DB", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("keep", "shared content phrase", "proj", "shared"),
    );
    insertMemory(
      db,
      makeMemory("gone", "shared content phrase", "proj", "shared"),
    );
    await rebuildIndex();
    deleteMemory(db, "gone");
    const results = await hybridSearch(
      "shared content phrase",
      seededVector("shared"),
      "proj",
      10,
    );
    for (const r of results) {
      expect(r.memory.id).not.toBe("gone");
    }
  });

  // (9) hybridSearch returns _debug with oramaScore
  test("hybridSearch includes _debug with oramaScore", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeMemory("dbg", "debug score test content", "proj", "dbg"),
    );
    await rebuildIndex();
    const results = await hybridSearch(
      "debug score test",
      seededVector("dbg"),
      "proj",
      10,
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]._debug).toBeDefined();
    expect(typeof results[0]._debug?.oramaScore).toBe("number");
  });

  // (10) _setSearchDepsForTesting overrides specific deps
  test("_setSearchDepsForTesting overrides specific deps", () => {
    let called = false;
    _setSearchDepsForTesting({
      markStale: () => {
        called = true;
      },
    });
    markStale();
    expect(called).toBe(true);
  });

  // (11) _resetSearchDepsForTesting restores defaults
  test("_resetSearchDepsForTesting restores defaults", () => {
    _setSearchDepsForTesting({
      getSearchState: () => "degraded" as const,
    });
    expect(getSearchState()).toBe("degraded");
    _resetSearchDepsForTesting();
    expect(getSearchState()).not.toBe("degraded");
  });

  // (12) Partial DI override preserves other deps
  test("partial DI override preserves other deps", () => {
    let markCalled = false;
    _setSearchDepsForTesting({
      markStale: () => {
        markCalled = true;
      },
    });
    const state = getSearchState();
    expect(typeof state).toBe("string");
    markStale();
    expect(markCalled).toBe(true);
  });

  // (13) doRebuild error path: close DB and set impossible config path so
  // getDb() throws inside doRebuild. The error is caught by doRebuild's catch
  // (state="error") and then by rebuildIndexImpl's serialization catch.
  test("doRebuild error sets state to error", async () => {
    closeDb();
    _setConfigForTesting(
      makeTestConfig({ storage: { path: "/dev/null/impossible" } }),
    );
    await rebuildIndex();
    expect(getSearchState()).toBe("error");
  });
});
