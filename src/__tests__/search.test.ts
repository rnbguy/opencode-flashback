import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { insertMemory, getDb, closeDb } from "../db/database.ts";
import {
  _setConfigForTesting,
  _resetConfigForTesting,
  type PluginConfig,
} from "../config.ts";
import type { Memory } from "../types.ts";
import {
  initSearch,
  hybridSearch,
  rebuildIndex,
  markStale,
  getSearchState,
} from "../search.ts";

const defaultConfig: PluginConfig = {
  llm: {
    provider: "ollama",
    model: "kimi-k2.5:cloud",
    apiUrl: "http://127.0.0.1:11434",
    apiKey: "",
  },
  embedding: {
    provider: "ollama",
    model: "embeddinggemma:latest",
    apiUrl: "http://127.0.0.1:11434",
    apiKey: "",
  },
  storage: { path: "/tmp/test" },
  memory: {
    maxResults: 10,
    autoCapture: true,
    injection: "first",
    excludeCurrentSession: true,
  },
  web: { port: 4747, enabled: false },
  search: { retrievalQuality: "balanced" },
  toasts: {
    autoCapture: true,
    userProfile: true,
    errors: true,
  },
  compaction: {
    enabled: true,
    memoryLimit: 10,
  },
};

function makeVector(seed: number): number[] {
  const vec = new Array(768);
  for (let i = 0; i < 768; i++) {
    vec[i] = Math.sin(seed + i * 0.1) * 0.5;
  }
  return vec;
}

function makeMemory(
  id: string,
  content: string,
  containerTag: string,
  vectorSeed: number,
): Memory {
  const now = Date.now();
  return {
    id,
    content,
    embedding: new Float32Array(makeVector(vectorSeed)),
    containerTag,
    tags: [],
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

function addMemory(
  id: string,
  content: string,
  containerTag: string,
  vectorSeed: number,
): void {
  const db = getDb();
  insertMemory(db, makeMemory(id, content, containerTag, vectorSeed));
}

describe("search", () => {
  let testDir: string;

  beforeEach(() => {
    closeDb();
    testDir = mkdtempSync(join(tmpdir(), "flashback-search-"));
    getDb(join(testDir, "test.db"));
    _setConfigForTesting(defaultConfig);
  });

  afterEach(() => {
    closeDb();
    rmSync(testDir, { recursive: true, force: true });
    _resetConfigForTesting();
  });

  test("initSearch sets state to ready", async () => {
    await initSearch();
    expect(getSearchState()).not.toBe("error");
  });

  test("hybridSearch returns matching results", async () => {
    addMemory("mem1", "Rust programming language", "project-1", 42);
    await rebuildIndex();

    const results = await hybridSearch(
      "Rust programming",
      makeVector(42),
      "project-1",
      10,
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].memory.id).toBe("mem1");
    expect(results[0].score).toBeGreaterThan(0);
  });

  test("filters by containerTag", async () => {
    addMemory("mem-a", "TypeScript tips and tricks", "project-a", 10);
    addMemory("mem-b", "TypeScript tips and tricks", "project-b", 10);
    await rebuildIndex();

    const results = await hybridSearch(
      "TypeScript",
      makeVector(10),
      "project-a",
      10,
    );
    expect(results.every((r) => r.memory.containerTag === "project-a")).toBe(
      true,
    );
  });

  test("returns empty array for no matches", async () => {
    await rebuildIndex();
    const results = await hybridSearch(
      "nonexistent",
      makeVector(99),
      "project-x",
      10,
    );
    expect(results).toEqual([]);
  });

  test("does not increment access_count (pure read operation)", async () => {
    addMemory("mem-access", "Node.js best practices", "project-1", 50);
    await rebuildIndex();

    await hybridSearch("Node.js", makeVector(50), "project-1", 10);

    const row = getDb()
      .query("SELECT access_count FROM memories WHERE id = ?")
      .get("mem-access") as { access_count: number } | null;
    expect(row).not.toBeNull();
    expect(row!.access_count).toBe(0);
  });

  test("markStale triggers rebuild on next search", async () => {
    addMemory("old", "Old content here", "proj", 1);
    await rebuildIndex();

    addMemory("new", "New fresh content added", "proj", 2);
    markStale();

    const results = await hybridSearch(
      "New fresh content",
      makeVector(2),
      "proj",
      10,
    );
    expect(results.some((r) => r.memory.id === "new")).toBe(true);
  });

  test("falls back to SQLite text search on error", async () => {
    addMemory("fallback-mem", "Python data science guide", "proj", 5);
    await rebuildIndex();

    const results = await hybridSearch(
      "Python data science",
      [1, 2, 3],
      "proj",
      10,
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].score).toBe(0);
    expect(results[0]._debug?.fallback).toBe(true);
    expect(getSearchState()).toBe("degraded");
  });
});
