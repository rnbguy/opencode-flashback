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
import {
  closeDb,
  getDb,
  getRevision,
  insertMemory,
} from "../src/db/database.ts";
import { reembedAllMemories } from "../src/engine.ts";
import { makeTestConfig } from "./fixtures/config.ts";
import { makeTestMemory } from "./fixtures/memory.ts";
import { seededVector } from "./fixtures/vectors.ts";

describe("reembedAllMemories revision tracking", () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-reembed-rev-"));
    getDb(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetEmbedDepsForTesting();
    resetEmbedder();
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reembedAllMemories increments db revision", async () => {
    const db = getDb();
    insertMemory(db, makeTestMemory("reembed-test-1", "test-tag"));
    const revisionBefore = getRevision(db);

    await reembedAllMemories(db, "new-model");

    expect(getRevision(db)).toBe(revisionBefore + 1);
  });

  test("reembedAllMemories increments revision with multiple memories", async () => {
    const db = getDb();
    insertMemory(db, makeTestMemory("reembed-test-2a", "test-tag"));
    insertMemory(db, makeTestMemory("reembed-test-2b", "test-tag"));
    insertMemory(db, makeTestMemory("reembed-test-2c", "test-tag"));
    const revisionBefore = getRevision(db);

    await reembedAllMemories(db, "new-model");

    expect(getRevision(db)).toBe(revisionBefore + 1);
  });
});
