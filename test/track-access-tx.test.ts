import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { _resetConfigForTesting, _setConfigForTesting } from "../src/config.ts";
import {
  _resetEmbedDepsForTesting,
  _setEmbedDepsForTesting,
  resetEmbedder,
} from "../src/core/ai/embed.ts";
import type { createEmbeddingProvider } from "../src/core/ai/providers.ts";
import { trackAccess } from "../src/core/memory.ts";
import { closeDb, getDb, getMemory, insertMemory } from "../src/db/database.ts";
import type { SearchResult } from "../src/types.ts";
import { makeTestConfig } from "./fixtures/config.ts";
import { makeTestMemory } from "./fixtures/memory.ts";
import { seededVector } from "./fixtures/vectors.ts";

describe("trackAccess transaction", () => {
  let tmpDir: string;

  beforeEach(() => {
    _setConfigForTesting(makeTestConfig({ storage: { path: "/tmp" } }));
    _setEmbedDepsForTesting({
      embedMany: (async ({ values }: { values: string[] }) => ({
        embeddings: values.map((value) => seededVector(value)),
      })) as unknown as typeof import("ai").embedMany,
      createEmbeddingProvider: (async () => ({
        embedding: (_id: string) => ({}),
      })) as unknown as typeof createEmbeddingProvider,
    });

    resetEmbedder();
    closeDb();
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-track-access-"));
    getDb(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetEmbedDepsForTesting();
    resetEmbedder();
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("trackAccess updates access_count and last_accessed_at for all results", () => {
    const db = getDb();

    // Insert 3 test memories
    const mem1 = makeTestMemory("track-1", "test-tag");
    const mem2 = makeTestMemory("track-2", "test-tag");
    const mem3 = makeTestMemory("track-3", "test-tag");

    insertMemory(db, mem1);
    insertMemory(db, mem2);
    insertMemory(db, mem3);

    // Build SearchResult array
    const results: SearchResult[] = [
      { memory: mem1, score: 0.9 },
      { memory: mem2, score: 0.8 },
      { memory: mem3, score: 0.7 },
    ];

    // Call trackAccess
    trackAccess(results);

    // Verify all 3 memories were updated
    const updated1 = getMemory(db, "track-1");
    const updated2 = getMemory(db, "track-2");
    const updated3 = getMemory(db, "track-3");

    expect(updated1).not.toBeNull();
    expect(updated2).not.toBeNull();
    expect(updated3).not.toBeNull();

    if (updated1) {
      expect(updated1.accessCount).toBe(1);
      expect(updated1.lastAccessedAt).toBeGreaterThan(0);
    }

    if (updated2) {
      expect(updated2.accessCount).toBe(1);
      expect(updated2.lastAccessedAt).toBeGreaterThan(0);
    }

    if (updated3) {
      expect(updated3.accessCount).toBe(1);
      expect(updated3.lastAccessedAt).toBeGreaterThan(0);
    }
  });

  test("trackAccess with empty results does nothing", () => {
    const db = getDb();

    // Insert a memory
    const mem = makeTestMemory("track-empty", "test-tag");
    insertMemory(db, mem);

    // Call trackAccess with empty array
    trackAccess([]);

    // Verify memory was not modified
    const unchanged = getMemory(db, "track-empty");
    expect(unchanged).not.toBeNull();
    if (unchanged) {
      expect(unchanged.accessCount).toBe(0);
    }
  });
});
