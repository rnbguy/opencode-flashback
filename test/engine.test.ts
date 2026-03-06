import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
import { closeDb, getDb } from "../src/db/database.ts";
import { makeTestConfig } from "./fixtures/config.ts";
import { seededVector } from "./fixtures/vectors.ts";

const defaultConfig = makeTestConfig({ llm: { apiKey: "test-key-1234" } });

let tmpDir = "";
let createEngine: typeof import("../src/engine.ts")["createEngine"];

describe("engine facade", () => {
  beforeEach(async () => {
    _setConfigForTesting(defaultConfig);
    closeDb();
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-engine-"));
    getDb(join(tmpDir, "engine.db"));

    _setEmbedDepsForTesting({
      embedMany: (async ({ values }: { values: string[] }) => ({
        embeddings: values.map((value) => seededVector(value)),
      })) as unknown as typeof import("ai").embedMany,
      createEmbeddingProvider: (async () => ({
        embedding: (_id: string) => ({}),
      })) as unknown as typeof createEmbeddingProvider,
    });
    resetEmbedder();

    const engineModule = await import(`../src/engine.ts?eng=${Date.now()}`);
    createEngine = engineModule.createEngine;
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetEmbedDepsForTesting();
    resetEmbedder();
    closeDb();
    mock.restore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("createEngine exposes expected methods", () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    expect(typeof engine.addMemory).toBe("function");
    expect(typeof engine.searchMemories).toBe("function");
    expect(typeof engine.recallMemories).toBe("function");
    expect(typeof engine.forgetMemory).toBe("function");
    expect(typeof engine.listMemories).toBe("function");
    expect(typeof engine.getContext).toBe("function");
    expect(typeof engine.getMemoryById).toBe("function");
    expect(typeof engine.getOrCreateProfile).toBe("function");
    expect(typeof engine.enqueueCapture).toBe("function");
    expect(typeof engine.resolveTag).toBe("function");
    expect(typeof engine.getDiagnostics).toBe("function");
    expect(typeof engine.warmup).toBe("function");
    expect(typeof engine.shutdown).toBe("function");
  });

  test("resolveTag delegates to resolver", () => {
    const resolver = {
      resolve: mock((directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      })),
    };
    const engine = createEngine(resolver);

    const result = engine.resolveTag("/tmp/project");
    expect(result.tag).toBe("test:/tmp/project");
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(resolver.resolve).toHaveBeenCalledWith("/tmp/project");
  });

  test("addMemory stores and returns id", async () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    const result = await engine.addMemory({
      content: "engine add memory",
      containerTag: "engine-tag",
    });

    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);
    expect(typeof result.deduplicated).toBe("boolean");
  });

  test("searchMemories returns paged results", async () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    await engine.addMemory({
      content: "searchable engine content",
      containerTag: "engine-tag",
    });

    const page = await engine.searchMemories("searchable", "engine-tag", 5);
    expect(Array.isArray(page.results)).toBe(true);
    expect(typeof page.totalCount).toBe("number");
  });

  test("recallMemories returns results array", async () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    await engine.addMemory({
      content: "recallable engine memory",
      containerTag: "engine-tag",
    });

    const results = await engine.recallMemories(
      ["recallable", "engine memory"],
      "engine-tag",
      5,
    );
    expect(Array.isArray(results)).toBe(true);
  });

  test("forgetMemory removes stored memory", async () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    const created = await engine.addMemory({
      content: "forget this memory",
      containerTag: "engine-tag",
    });
    await engine.forgetMemory(created.id);

    const loaded = await engine.getMemoryById(created.id);
    expect(loaded).toBeNull();
  });

  test("listMemories returns memories and total", async () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    await engine.addMemory({
      content: "first list memory",
      containerTag: "engine-tag",
    });
    await engine.addMemory({
      content: "second list memory",
      containerTag: "engine-tag",
    });

    const page = await engine.listMemories("engine-tag", 10, 0);
    expect(Array.isArray(page.memories)).toBe(true);
    expect(page.total).toBeGreaterThanOrEqual(2);
  });

  test("getMemoryById returns memory when present", async () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    const created = await engine.addMemory({
      content: "memory lookup",
      containerTag: "engine-tag",
    });

    const loaded = await engine.getMemoryById(created.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(created.id);
  });

  test("getMemoryById returns null for unknown id", async () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    const loaded = await engine.getMemoryById("missing-id");
    expect(loaded).toBeNull();
  });

  test("getOrCreateProfile returns profile", () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    const profile = engine.getOrCreateProfile("engine-user@test.com");
    expect(profile).not.toBeNull();
    expect(profile?.userId).toBe("engine-user@test.com");
  });

  test("getContext returns string", async () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    await engine.addMemory({
      content: "context memory",
      containerTag: "engine-tag",
    });

    const context = await engine.getContext("engine-tag", "session-1");
    expect(typeof context).toBe("string");
  });

  test("getDiagnostics returns expected shape", async () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    await engine.addMemory({
      content: "diagnostics memory",
      containerTag: "engine-tag",
    });

    const stats = await engine.getDiagnostics("engine-tag");
    expect(typeof stats.memoryCount).toBe("number");
    expect(typeof stats.dbSizeBytes).toBe("number");
    expect(typeof stats.dbPath).toBe("string");
    expect(typeof stats.embeddingModel).toBe("string");
    expect(typeof stats.version).toBe("string");
    expect(typeof stats.subsystems.embedder).toBe("string");
    expect(typeof stats.subsystems.search).toBe("string");
    expect(typeof stats.subsystems.capture).toBe("string");
  });

  test("warmup does not crash", async () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    await expect(engine.warmup()).resolves.toBeUndefined();
  });

  test("shutdown does not crash", () => {
    const engine = createEngine({
      resolve: (directory: string) => ({
        tag: `test:${directory}`,
        userName: "test",
        userEmail: "test@test.com",
        projectPath: directory,
        projectName: "test",
        gitRepoUrl: "",
      }),
    });

    expect(() => {
      for (let i = 0; i < 2; i++) {
        engine.shutdown();
      }
    }).not.toThrow();
  });
});
