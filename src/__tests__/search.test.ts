import { describe, test, expect, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import type { Memory } from "../types.ts";

// ── Test state ──────────────────────────────────────────────────────────────

let testDb: Database;
let testMemories: Memory[] = [];
let shouldConfigThrow = false;

// ── Mocks (hoisted before imports) ──────────────────────────────────────────

const defaultConfig = {
  llm: {
    provider: "openai-chat" as const,
    model: "gpt-4o-mini",
    apiUrl: "https://api.openai.com/v1",
    apiKey: "",
  },
  storage: { path: "/tmp/test" },
  memory: {
    maxResults: 10,
    autoCapture: true,
    injection: "first" as const,
    excludeCurrentSession: true,
  },
  web: { port: 4747, enabled: false },
  search: { retrievalQuality: "balanced" as const },
};

mock.module("../config.ts", () => ({
  getConfig: () => {
    if (shouldConfigThrow) throw new Error("Config error for test");
    return defaultConfig;
  },
  getHybridWeights: () => ({ semantic: 0.5, keyword: 0.5 }),
}));

mock.module("../db/database.ts", () => ({
  getDb: () => testDb,
  getAllActiveMemories: () => testMemories,
  getMemory: (_db: unknown, id: string) =>
    testMemories.find((m) => m.id === id) ?? null,
  searchMemoriesByText: (
    _db: unknown,
    query: string,
    containerTag: string,
    limit: number,
  ) =>
    testMemories
      .filter(
        (m) =>
          m.content.toLowerCase().includes(query.toLowerCase()) &&
          m.containerTag === containerTag,
      )
      .slice(0, limit),
}));

import {
  initSearch,
  hybridSearch,
  rebuildIndex,
  markStale,
  getSearchState,
} from "../search/index.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

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
    displayName: "",
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
    nextReviewAt: null,
  };
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL,
    container_tag TEXT NOT NULL,
    tags TEXT,
    type TEXT,
    is_pinned INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata TEXT,
    display_name TEXT,
    user_name TEXT,
    user_email TEXT,
    project_path TEXT,
    project_name TEXT,
    git_repo_url TEXT,
    source_file TEXT,
    source_line INTEGER,
    provenance_session_id TEXT,
    provenance_message_range TEXT,
    provenance_tool_call_ids TEXT,
    last_accessed_at INTEGER,
    access_count INTEGER DEFAULT 0,
    epistemic_confidence REAL DEFAULT 0.7,
    epistemic_evidence_count INTEGER DEFAULT 1,
    evicted_at INTEGER DEFAULT NULL,
    suspended INTEGER DEFAULT 0,
    suspended_reason TEXT,
    suspended_at INTEGER,
    stability REAL DEFAULT 0.0,
    next_review_at INTEGER
  )`);
  return db;
}

function insertIntoTestDb(memory: Memory): void {
  testDb
    .query(
      `INSERT INTO memories (
      id, content, embedding, container_tag, tags, type, is_pinned,
      created_at, updated_at, access_count, last_accessed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      memory.id,
      memory.content,
      Buffer.from(
        memory.embedding.buffer,
        memory.embedding.byteOffset,
        memory.embedding.byteLength,
      ),
      memory.containerTag,
      JSON.stringify(memory.tags),
      memory.type,
      memory.isPinned ? 1 : 0,
      memory.createdAt,
      memory.updatedAt,
      memory.accessCount,
      memory.lastAccessedAt,
    );
}

function addMemory(
  id: string,
  content: string,
  containerTag: string,
  vectorSeed: number,
): Memory {
  const mem = makeMemory(id, content, containerTag, vectorSeed);
  testMemories.push(mem);
  insertIntoTestDb(mem);
  return mem;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("search", () => {
  beforeEach(() => {
    testMemories = [];
    shouldConfigThrow = false;
    testDb = createTestDb();
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

  test("increments access_count in database", async () => {
    addMemory("mem-access", "Node.js best practices", "project-1", 50);
    await rebuildIndex();

    await hybridSearch("Node.js", makeVector(50), "project-1", 10);

    const row = testDb
      .query("SELECT access_count FROM memories WHERE id = ?")
      .get("mem-access") as { access_count: number } | null;
    expect(row).not.toBeNull();
    expect(row!.access_count).toBe(1);
  });

  test("markStale triggers rebuild on next search", async () => {
    addMemory("old", "Old content here", "proj", 1);
    await rebuildIndex();

    // Add new memory after initial build
    addMemory("new", "New fresh content added", "proj", 2);
    markStale();

    // hybridSearch should rebuild and find the new memory
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

    // Make getConfig throw to trigger catch block in hybridSearch
    shouldConfigThrow = true;

    const results = await hybridSearch(
      "Python data science",
      makeVector(5),
      "proj",
      10,
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].score).toBe(0);
    expect(results[0]._debug?.fallback).toBe(true);
    expect(getSearchState()).toBe("degraded");
  });
});
