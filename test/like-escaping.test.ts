import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  countSearchMemoriesByText,
  insertMemory,
  searchMemoriesByText,
} from "../src/db/database";
import type { Memory } from "../src/types";

// -- Helpers ------------------------------------------------------------------

function createInMemoryDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  // Run migration v1 inline
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      container_tag TEXT NOT NULL,
      tags TEXT,
      type TEXT,
      is_starred INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
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
      difficulty REAL NOT NULL DEFAULT 5.0,
      next_review_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_memories_container_tag ON memories(container_tag);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2');
  `);
  return db;
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: `mem_${Math.random().toString(36).slice(2, 10)}`,
    content: "test memory",
    embedding: new Float32Array([0.1, 0.2, 0.3]),
    containerTag: "tag_test",
    tags: ["test"],
    type: "knowledge",
    isStarred: false,
    createdAt: now,
    updatedAt: now,
    metadata: {},
    userName: "tester",
    userEmail: "test@example.com",
    projectPath: "/tmp/test",
    projectName: "test",
    gitRepoUrl: "",
    provenance: {
      sessionId: "ses_001",
      messageRange: [1, 5],
      toolCallIds: ["tc_1"],
    },
    lastAccessedAt: now,
    accessCount: 0,
    epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
    evictedAt: null,
    suspended: false,
    suspendedReason: null,
    suspendedAt: null,
    stability: 0.0,
    difficulty: 5.0,
    nextReviewAt: null,
    ...overrides,
  };
}

// -- Tests --------------------------------------------------------------------

describe("LIKE query escaping", () => {
  let db: Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  test("percent wildcard is escaped: searching for '100%' matches only exact content", () => {
    const tag = "tag_percent";
    insertMemory(
      db,
      makeMemory({ content: "100% complete", containerTag: tag }),
    );
    insertMemory(db, makeMemory({ content: "50 items", containerTag: tag }));

    const results = searchMemoriesByText(db, "100%", tag, 10);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("100% complete");
  });

  test("underscore wildcard is escaped: searching for 'my_var' matches only exact content", () => {
    const tag = "tag_underscore";
    insertMemory(
      db,
      makeMemory({ content: "my_var is a variable", containerTag: tag }),
    );
    insertMemory(
      db,
      makeMemory({ content: "myXvar is different", containerTag: tag }),
    );

    const results = searchMemoriesByText(db, "my_var", tag, 10);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("my_var is a variable");
  });

  test("backslash escape character is escaped: searching for backslash works correctly", () => {
    const tag = "tag_backslash";
    insertMemory(
      db,
      makeMemory({ content: "path\\to\\file", containerTag: tag }),
    );
    insertMemory(
      db,
      makeMemory({ content: "path/to/file", containerTag: tag }),
    );

    const results = searchMemoriesByText(db, "path\\to", tag, 10);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("path\\to\\file");
  });

  test("countSearchMemoriesByText respects LIKE escaping for percent", () => {
    const tag = "tag_count_percent";
    insertMemory(
      db,
      makeMemory({ content: "100% complete", containerTag: tag }),
    );
    insertMemory(db, makeMemory({ content: "50 items", containerTag: tag }));

    const count = countSearchMemoriesByText(db, "100%", tag);
    expect(count).toBe(1);
  });

  test("countSearchMemoriesByText respects LIKE escaping for underscore", () => {
    const tag = "tag_count_underscore";
    insertMemory(
      db,
      makeMemory({ content: "my_var is a variable", containerTag: tag }),
    );
    insertMemory(
      db,
      makeMemory({ content: "myXvar is different", containerTag: tag }),
    );

    const count = countSearchMemoriesByText(db, "my_var", tag);
    expect(count).toBe(1);
  });

  test("normal substring search still works after escaping", () => {
    const tag = "tag_normal";
    insertMemory(db, makeMemory({ content: "hello world", containerTag: tag }));
    insertMemory(
      db,
      makeMemory({ content: "goodbye world", containerTag: tag }),
    );

    const results = searchMemoriesByText(db, "world", tag, 10);
    expect(results).toHaveLength(2);
  });
});
