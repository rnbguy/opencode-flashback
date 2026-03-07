import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
  META_KEY_EMBEDDING_DIMENSION,
  META_KEY_EMBEDDING_MODEL,
  META_KEY_REEMBED_IN_PROGRESS,
  setMetaValue,
} from "../src/db/database.ts";
import { createLogger } from "../src/util/logger.ts";
import { makeTestConfig } from "./fixtures/config.ts";
import { seededVector } from "./fixtures/vectors.ts";

const DEFAULT_MODEL = "embeddinggemma:latest";

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

function float32FromBlob(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

function insertRawMemories(count: number): void {
  const db = getDb();
  const now = Date.now();
  const sentinel = new Float32Array(768).fill(0.123);

  for (let i = 0; i < count; i++) {
    db.query(
      `INSERT INTO memories (id, content, embedding, container_tag, created_at,
        updated_at, access_count, epistemic_confidence, epistemic_evidence_count,
        stability, difficulty, suspended)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `raw-${i}`,
      `raw content ${i}`,
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
}

describe("engine coverage paths", () => {
  let tmpDir = "";
  let createEngine: typeof import("../src/engine.ts")["createEngine"];
  let reembedAllMemories: typeof import("../src/engine.ts")["reembedAllMemories"];
  let embedManyCalls = 0;
  let throwOnEmbedCall: number | null = null;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-engine-cov-"));
    _setConfigForTesting(
      makeTestConfig({
        storage: { path: join(tmpDir, "engine.db") },
      }),
    );
    closeDb();
    getDb(join(tmpDir, "engine.db"));

    embedManyCalls = 0;
    throwOnEmbedCall = null;

    _setEmbedDepsForTesting({
      embedMany: (async ({ values }: { values: string[] }) => {
        embedManyCalls += 1;
        if (throwOnEmbedCall !== null && embedManyCalls === throwOnEmbedCall) {
          throw new Error("simulated embed failure");
        }
        return { embeddings: values.map((value) => seededVector(value)) };
      }) as unknown as typeof import("ai").embedMany,
      createEmbeddingProvider: (async () => ({
        embedding: (_id: string) => ({}),
      })) as unknown as typeof createEmbeddingProvider,
    });
    resetEmbedder();

    createLogger(join(tmpDir, "logs"), "engine-coverage", "debug");

    const mod = await import(`../src/engine.ts?eng=${Date.now()}`);
    createEngine = mod.createEngine;
    reembedAllMemories = mod.reembedAllMemories;
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetEmbedDepsForTesting();
    resetEmbedder();
    closeDb();
    mock.restore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("warmup stores embedding model and dimension on first run", async () => {
    const engine = createEngine(makeResolver());
    await engine.warmup();
    await Bun.sleep(200);

    const db = getDb();
    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBe(DEFAULT_MODEL);
    expect(getMetaValue(db, META_KEY_EMBEDDING_DIMENSION)).toBe("768");
    expect(embedManyCalls).toBe(1);
  });

  test("warmup returns early when embedding model is missing", async () => {
    _setConfigForTesting(
      makeTestConfig({
        embedding: { model: "" },
        storage: { path: join(tmpDir, "engine.db") },
      }),
    );

    const engine = createEngine(makeResolver());
    await engine.warmup();
    await Bun.sleep(200);

    const db = getDb();
    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBeNull();
    expect(getMetaValue(db, META_KEY_EMBEDDING_DIMENSION)).toBe("768");
  });

  test("warmup keeps stored model when it matches config", async () => {
    const db = getDb();
    setMetaValue(db, META_KEY_EMBEDDING_MODEL, DEFAULT_MODEL);

    const engine = createEngine(makeResolver());
    await engine.warmup();
    await Bun.sleep(200);

    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBe(DEFAULT_MODEL);
    expect(embedManyCalls).toBe(1);
  });

  test("warmup triggers background re-embed on model change", async () => {
    insertRawMemories(1);
    const db = getDb();
    setMetaValue(db, META_KEY_EMBEDDING_MODEL, "old-model");

    const before = db
      .query("SELECT embedding FROM memories WHERE id = ?")
      .get("raw-0") as { embedding: Uint8Array };
    const beforeEmbedding = Array.from(float32FromBlob(before.embedding));

    const engine = createEngine(makeResolver());
    await engine.warmup();
    await Bun.sleep(400);

    const after = db
      .query("SELECT embedding FROM memories WHERE id = ?")
      .get("raw-0") as { embedding: Uint8Array };
    const afterEmbedding = Array.from(float32FromBlob(after.embedding));

    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBe(DEFAULT_MODEL);
    expect(getMetaValue(db, META_KEY_REEMBED_IN_PROGRESS)).toBeNull();
    expect(embedManyCalls).toBeGreaterThanOrEqual(2);
    expect(afterEmbedding).not.toEqual(beforeEmbedding);
  });

  test("reembedAllMemories skips when another run is in progress", async () => {
    const db = getDb();
    const now = String(Date.now());
    setMetaValue(db, META_KEY_REEMBED_IN_PROGRESS, now);

    await reembedAllMemories(db, "new-model");

    expect(getMetaValue(db, META_KEY_REEMBED_IN_PROGRESS)).toBe(now);
    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBeNull();
    expect(embedManyCalls).toBe(0);
  });

  test("reembedAllMemories updates model when there are no memories", async () => {
    const db = getDb();

    await reembedAllMemories(db, "new-model");

    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBe("new-model");
    expect(getMetaValue(db, META_KEY_REEMBED_IN_PROGRESS)).toBeNull();
    expect(embedManyCalls).toBe(0);
  });

  test("reembedAllMemories processes memories in chunks of 50", async () => {
    insertRawMemories(120);
    const db = getDb();

    await reembedAllMemories(db, "chunk-model");

    const row = db
      .query("SELECT embedding FROM memories WHERE id = ?")
      .get("raw-119") as { embedding: Uint8Array };
    const sample = float32FromBlob(row.embedding);

    expect(embedManyCalls).toBe(3);
    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBe("chunk-model");
    expect(getMetaValue(db, META_KEY_REEMBED_IN_PROGRESS)).toBeNull();
    expect(sample[0]).not.toBe(0.123);
  });

  test("reembedAllMemories clears in-progress flag when chunking fails", async () => {
    insertRawMemories(80);
    throwOnEmbedCall = 2;
    const db = getDb();

    await expect(reembedAllMemories(db, "failed-model")).rejects.toThrow(
      "simulated embed failure",
    );

    expect(getMetaValue(db, META_KEY_REEMBED_IN_PROGRESS)).toBeNull();
    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBeNull();
  });

  test("engine diagnostics, clear, consolidate, and shutdown lifecycle", async () => {
    const engine = createEngine(makeResolver());
    await engine.addMemory({
      content: "coverage diagnostics",
      containerTag: "test-tag",
    });

    await engine.warmup();
    const db = getDb();
    setMetaValue(db, META_KEY_EMBEDDING_MODEL, "old-model");
    await engine.warmup();
    await Bun.sleep(300);

    setMetaValue(db, META_KEY_REEMBED_IN_PROGRESS, String(Date.now()));
    await reembedAllMemories(db, "skipped-model");
    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBe(DEFAULT_MODEL);

    const originalFile = Bun.file;
    (Bun as unknown as { file: typeof Bun.file }).file = () => {
      throw new Error("size read failed");
    };

    const diagnostics = await engine.getDiagnostics("test-tag");
    (Bun as unknown as { file: typeof Bun.file }).file = originalFile;
    expect(diagnostics.memoryCount).toBeGreaterThanOrEqual(1);
    expect(diagnostics.dbSizeBytes).toBe(0);
    expect(diagnostics.embeddingModel).toBe(DEFAULT_MODEL);

    engine.clearAllData(999_999);
    const kept = await engine.listMemories("test-tag", 10, 0);
    expect(kept.total).toBe(1);

    engine.clearAllData();
    const cleared = await engine.listMemories("test-tag", 10, 0);
    expect(cleared.total).toBe(0);

    const consolidation = await engine.consolidateMemories("test-tag", true);
    expect(Array.isArray(consolidation.candidates)).toBe(true);
    expect(typeof consolidation.merged).toBe("number");

    engine.shutdown();
    getDb(join(tmpDir, "reopened.db"));
    expect(getDb()).toBeDefined();
  });
});
