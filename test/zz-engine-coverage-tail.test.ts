import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  getMetaValue,
  META_KEY_EMBEDDING_MODEL,
  META_KEY_REEMBED_IN_PROGRESS,
  setMetaValue,
} from "../src/db/database.ts";
import { makeTestConfig } from "./fixtures/config.ts";
import { seededVector } from "./fixtures/vectors.ts";

function makeResolver() {
  return {
    resolve: (directory: string) => ({
      tag: `test:${directory}`,
      userName: "test",
      userEmail: "test@test.com",
      projectPath: directory,
      projectName: "test",
      gitRepoUrl: "",
    }),
  };
}

describe("engine coverage tail", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-engine-tail-"));
    _setConfigForTesting(
      makeTestConfig({
        storage: { path: join(tmpDir, "tail.db") },
      }),
    );
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
    getDb(join(tmpDir, "tail.db"));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetEmbedDepsForTesting();
    resetEmbedder();
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("covers model-change, reembed, diagnostics, and lifecycle in one query module", async () => {
    const mod = await import(`../src/engine.ts?tail=${Date.now()}`);
    const engine = mod.createEngine(makeResolver());

    await engine.warmup();
    const db = getDb();

    const now = Date.now();
    const sentinel = new Float32Array(768).fill(0.321);
    for (let i = 0; i < 55; i++) {
      db.query(
        `INSERT INTO memories (id, content, embedding, container_tag, created_at,
          updated_at, access_count, epistemic_confidence, epistemic_evidence_count,
          stability, difficulty, suspended)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `tail-${i}`,
        `tail content ${i}`,
        Buffer.from(sentinel.buffer),
        "test-tag",
        now,
        now,
        0,
        0.7,
        1,
        0.5,
        5.0,
        0,
      );
    }

    setMetaValue(db, META_KEY_EMBEDDING_MODEL, "old-model");
    await engine.warmup();
    await Bun.sleep(300);

    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBe(
      "embeddinggemma:latest",
    );
    expect(getMetaValue(db, META_KEY_REEMBED_IN_PROGRESS)).toBeNull();

    await mod.reembedAllMemories(db, "tail-model");
    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBe("tail-model");

    setMetaValue(db, META_KEY_REEMBED_IN_PROGRESS, String(Date.now()));
    await mod.reembedAllMemories(db, "skipped-model");
    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBe("tail-model");

    await engine.getDiagnostics("test-tag");
    engine.clearAllData(999_999);
    engine.clearAllData();
    await engine.consolidateMemories("test-tag", true);
    engine.shutdown();
  });
});
