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
  addMemory,
  rateMemory,
  starMemory,
  suspendMemory,
  unstarMemory,
} from "../src/core/memory.ts";
import {
  _setDbForTesting,
  closeDb,
  getAllActiveMemories,
  getDb,
  getRevision,
  insertMemory,
} from "../src/db/database.ts";
import { makeTestConfig } from "./fixtures/config.ts";
import { makeTestMemory } from "./fixtures/memory.ts";
import { seededVector } from "./fixtures/vectors.ts";

describe("memory mutation revision tracking", () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-mem-rev-"));
    getDb(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetEmbedDepsForTesting();
    resetEmbedder();
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("starMemory increments db revision", async () => {
    const db = getDb();
    insertMemory(db, makeTestMemory("star-rev", "test-tag"));
    const revisionBefore = getRevision(db);

    const success = await starMemory("star-rev");

    expect(success).toBe(true);
    expect(getRevision(db)).toBe(revisionBefore + 1);
  });

  test("unstarMemory increments db revision", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("unstar-rev", "test-tag", { isStarred: true }),
    );
    const revisionBefore = getRevision(db);

    const success = await unstarMemory("unstar-rev");

    expect(success).toBe(true);
    expect(getRevision(db)).toBe(revisionBefore + 1);
  });

  test("suspendMemory increments db revision", async () => {
    const db = getDb();
    insertMemory(db, makeTestMemory("suspend-rev", "test-tag"));
    const revisionBefore = getRevision(db);

    const success = await suspendMemory("suspend-rev", "outdated");

    expect(success).toBe(true);
    expect(getRevision(db)).toBe(revisionBefore + 1);
  });

  test("rateMemory increments db revision", async () => {
    const db = getDb();
    insertMemory(
      db,
      makeTestMemory("rate-rev", "test-tag", { stability: 1.2 }),
    );
    const revisionBefore = getRevision(db);

    const result = await rateMemory("rate-rev", 4);

    expect(result.success).toBe(true);
    expect(getRevision(db)).toBe(revisionBefore + 1);
  });

  test("enforceTagBudget increments revision when eviction runs", async () => {
    const db = getDb();
    const tag = "budget-rev";
    const eightDaysAgo = Date.now() - 8 * 86_400_000;
    for (let i = 0; i < 500; i++) {
      insertMemory(
        db,
        makeTestMemory(`budget-seed-${i}`, tag, {
          createdAt: eightDaysAgo,
          lastAccessedAt: eightDaysAgo,
          accessCount: 0,
        }),
      );
    }
    const revisionBefore = getRevision(db);

    await addMemory({ content: "trigger budget eviction", containerTag: tag });

    expect(getRevision(db)).toBe(revisionBefore + 2);
  });

  test("enforceTagBudget rolls back all evictions on failure", async () => {
    const db = getDb();
    const tag = "budget-tx";
    const eightDaysAgo = Date.now() - 8 * 86_400_000;
    for (let i = 0; i < 501; i++) {
      insertMemory(
        db,
        makeTestMemory(`budget-tx-seed-${i}`, tag, {
          createdAt: eightDaysAgo,
          lastAccessedAt: eightDaysAgo,
          accessCount: 0,
        }),
      );
    }

    const dbWithFailure = getDb();
    const originalQuery = dbWithFailure.query.bind(dbWithFailure);
    let evictionUpdates = 0;
    const patchedDb = dbWithFailure as any;
    patchedDb.query = ((sql: string) => {
      const stmt = originalQuery(sql) as any;
      if (sql === "UPDATE memories SET evicted_at = ? WHERE id = ?") {
        return {
          run: (...args: unknown[]) => {
            evictionUpdates += 1;
            if (evictionUpdates === 2) {
              throw new Error("forced eviction failure");
            }
            return stmt.run(...args);
          },
        };
      }
      return stmt;
    }) as typeof dbWithFailure.query;
    _setDbForTesting(dbWithFailure);

    await addMemory({ content: "trigger rollback", containerTag: tag });

    patchedDb.query = originalQuery;
    _setDbForTesting(dbWithFailure);

    const evicted = getAllActiveMemories(db).filter(
      (memory) => memory.containerTag === tag && memory.evictedAt !== null,
    );
    expect(evicted.length).toBe(0);
  });
});
