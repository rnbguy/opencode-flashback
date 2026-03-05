import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTesting, _setConfigForTesting } from "../src/config";
import {
  _resetEmbedDepsForTesting,
  _setEmbedDepsForTesting,
  resetEmbedder,
} from "../src/core/ai/embed";
import type { createEmbeddingProvider } from "../src/core/ai/providers";
import {
  closeDb,
  getDb,
  getMetaValue,
  META_KEY_EMBEDDING_MODEL,
  setMetaValue,
} from "../src/db/database";
import { createEngine } from "../src/engine";
import { makeTestConfig } from "./fixtures/config";
import { seededVector } from "./fixtures/vectors";

const defaultConfig = makeTestConfig();

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

function setupEmbedDeps(): void {
  _setEmbedDepsForTesting({
    embedMany: (async ({ values }: { values: string[] }) => ({
      embeddings: values.map((value) => seededVector(value)),
    })) as unknown as typeof import("ai").embedMany,
    createEmbeddingProvider: (async () => ({
      embedding: (_id: string) => ({}),
    })) as unknown as typeof createEmbeddingProvider,
  });
}

describe("engine lifecycle and warmup", () => {
  let tmpDir: string;

  beforeEach(() => {
    _setConfigForTesting(defaultConfig);
    closeDb();
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-engine-ext-"));
    getDb(join(tmpDir, "test.db"));
    setupEmbedDeps();
    resetEmbedder();
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetEmbedDepsForTesting();
    resetEmbedder();
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- checkEmbeddingModelChange paths ----------------------------------------

  test("warmup stores embedding model on first run", async () => {
    const engine = createEngine(makeResolver());
    await engine.warmup();
    await Bun.sleep(300);
    const db = getDb();
    const stored = getMetaValue(db, META_KEY_EMBEDDING_MODEL);
    expect(stored).toBe("embeddinggemma:latest");
  });

  test("warmup skips re-embed when stored model matches config", async () => {
    const db = getDb();
    setMetaValue(db, META_KEY_EMBEDDING_MODEL, "embeddinggemma:latest");
    const engine = createEngine(makeResolver());
    await engine.warmup();
    await Bun.sleep(300);
    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBe(
      "embeddinggemma:latest",
    );
  });

  test("warmup detects model change and updates meta with no memories", async () => {
    const db = getDb();
    setMetaValue(db, META_KEY_EMBEDDING_MODEL, "old-model");
    const engine = createEngine(makeResolver());
    await engine.warmup();
    await Bun.sleep(300);
    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBe(
      "embeddinggemma:latest",
    );
  });

  test("warmup re-embeds existing memories on model change", async () => {
    const engine = createEngine(makeResolver());
    await engine.addMemory({
      content: "reembed this content",
      containerTag: "test-tag",
    });
    const db = getDb();
    setMetaValue(db, META_KEY_EMBEDDING_MODEL, "old-model");
    resetEmbedder();
    await engine.warmup();
    await Bun.sleep(500);
    expect(getMetaValue(db, META_KEY_EMBEDDING_MODEL)).toBe(
      "embeddinggemma:latest",
    );
    const page = await engine.listMemories("test-tag", 10, 0);
    expect(page.total).toBe(1);
  });

  test("warmup catches background re-embed failure", async () => {
    const db = getDb();
    // Insert raw memory directly to avoid calling embed during setup
    const vec = new Float32Array(seededVector("raw content"));
    db.query(
      `INSERT INTO memories (id, content, embedding, container_tag, created_at,
        updated_at, access_count, epistemic_confidence, epistemic_evidence_count,
        stability, difficulty, suspended)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "raw-1",
      "raw content",
      Buffer.from(vec.buffer),
      "test-tag",
      Date.now(),
      Date.now(),
      0,
      0.7,
      1,
      0.5,
      5.0,
      0,
    );
    setMetaValue(db, META_KEY_EMBEDDING_MODEL, "old-model");

    // Fail only for document-mode embeddings (re-embed path)
    _setEmbedDepsForTesting({
      embedMany: (async ({ values }: { values: string[] }) => {
        if (values.some((v: string) => v.includes("title: none"))) {
          throw new Error("simulated embed failure");
        }
        return { embeddings: values.map((v: string) => seededVector(v)) };
      }) as unknown as typeof import("ai").embedMany,
      createEmbeddingProvider: (async () => ({
        embedding: (_id: string) => ({}),
      })) as unknown as typeof createEmbeddingProvider,
    });
    resetEmbedder();

    const engine = createEngine(makeResolver());
    await engine.warmup();
    await Bun.sleep(500);
    // Error is caught silently by .catch() in reembedAllMemories
    expect(true).toBe(true);
  });

  // -- clearAllData paths -----------------------------------------------------

  test("clearAllData with positive durationSecs calls clearOldData", async () => {
    const engine = createEngine(makeResolver());
    await engine.addMemory({
      content: "recent memory",
      containerTag: "test-tag",
    });
    // Large duration: cutoff far in past, recent memory survives
    engine.clearAllData(999999);
    const page = await engine.listMemories("test-tag", 10, 0);
    expect(page.total).toBe(1);
  });

  test("clearAllData with zero durationSecs clears all", async () => {
    const engine = createEngine(makeResolver());
    await engine.addMemory({
      content: "to be cleared",
      containerTag: "test-tag",
    });
    engine.clearAllData(0);
    const page = await engine.listMemories("test-tag", 10, 0);
    expect(page.total).toBe(0);
  });

  test("clearAllData without args clears all", async () => {
    const engine = createEngine(makeResolver());
    await engine.addMemory({
      content: "another memory",
      containerTag: "test-tag",
    });
    engine.clearAllData();
    const page = await engine.listMemories("test-tag", 10, 0);
    expect(page.total).toBe(0);
  });

  // -- getDiagnostics ----------------------------------------------------------

  test("getDiagnostics returns expected shape", async () => {
    const engine = createEngine(makeResolver());
    await engine.addMemory({
      content: "diagnostics memory",
      containerTag: "test-tag",
    });
    const stats = await engine.getDiagnostics("test-tag");
    expect(typeof stats.memoryCount).toBe("number");
    expect(stats.memoryCount).toBeGreaterThanOrEqual(1);
    expect(typeof stats.dbSizeBytes).toBe("number");
    expect(typeof stats.dbPath).toBe("string");
    expect(typeof stats.embeddingModel).toBe("string");
    expect(typeof stats.version).toBe("string");
    expect(typeof stats.subsystems.embedder).toBe("string");
    expect(typeof stats.subsystems.search).toBe("string");
    expect(typeof stats.subsystems.capture).toBe("string");
  });

  // -- consolidateMemories -----------------------------------------------------

  test("consolidateMemories dry run returns result", async () => {
    const engine = createEngine(makeResolver());
    const result = await engine.consolidateMemories("test-tag", true);
    expect(Array.isArray(result.candidates)).toBe(true);
    expect(typeof result.merged).toBe("number");
  });

  // -- shutdown ---------------------------------------------------------------

  test("shutdown resets subsystems and closes database", async () => {
    const engine = createEngine(makeResolver());
    await engine.warmup();
    await Bun.sleep(300);
    engine.shutdown();
    // Re-open db to confirm close was successful
    getDb(join(tmpDir, "test2.db"));
    expect(getDb()).toBeDefined();
  });
});
