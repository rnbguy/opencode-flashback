import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";

let testDb: Database;

mock.module("../db/database.ts", () => ({
  getDb: () => testDb,
}));

import {
  storePrompt,
  getLastUncapturedPrompt,
  markCaptured,
  markAnalyzed,
  getUnanalyzedPrompts,
} from "../core/prompts.ts";

function createInMemoryDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_prompts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      content TEXT NOT NULL,
      directory TEXT,
      is_captured INTEGER DEFAULT 0,
      is_user_learning_captured INTEGER DEFAULT 0,
      linked_memory_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertPromptRow(
  overrides: Partial<Record<string, unknown>> = {},
): void {
  const row = {
    id: "prompt_seed",
    session_id: "ses_1",
    message_id: "msg_1",
    content: "how do i do x",
    directory: "/tmp",
    is_captured: 0,
    is_user_learning_captured: 0,
    linked_memory_id: null,
    created_at: Date.now(),
    ...overrides,
  };

  testDb
    .query(
      `INSERT INTO user_prompts (
        id, session_id, message_id, content, directory,
        is_captured, is_user_learning_captured, linked_memory_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.session_id,
      row.message_id,
      row.content,
      row.directory,
      row.is_captured,
      row.is_user_learning_captured,
      row.linked_memory_id,
      row.created_at,
    );
}

describe("prompts", () => {
  beforeEach(() => {
    testDb = createInMemoryDb();
  });

  afterEach(() => {
    testDb.close();
  });

  test("storePrompt inserts a new uncaptured prompt", () => {
    const id = storePrompt("ses_abc", "msg_abc", "remember this", "/workspace");

    expect(id.startsWith("prompt_")).toBe(true);

    const row = testDb
      .query("SELECT * FROM user_prompts WHERE id = ?")
      .get(id) as Record<string, unknown> | null;

    expect(row).not.toBeNull();
    expect(row!.session_id).toBe("ses_abc");
    expect(row!.message_id).toBe("msg_abc");
    expect(row!.content).toBe("remember this");
    expect(row!.directory).toBe("/workspace");
    expect(row!.is_captured).toBe(0);
    expect(row!.is_user_learning_captured).toBe(0);
  });

  test("getLastUncapturedPrompt returns null when no uncaptured prompts exist", () => {
    insertPromptRow({ id: "p1", session_id: "ses_a", is_captured: 1 });

    const result = getLastUncapturedPrompt("ses_a");
    expect(result).toBeNull();
  });

  test("getLastUncapturedPrompt returns newest uncaptured prompt in session", () => {
    insertPromptRow({
      id: "old",
      session_id: "ses_a",
      message_id: "msg_old",
      content: "old",
      created_at: 100,
      is_captured: 0,
    });
    insertPromptRow({
      id: "new",
      session_id: "ses_a",
      message_id: "msg_new",
      content: "new",
      created_at: 200,
      is_captured: 0,
    });
    insertPromptRow({
      id: "other-session",
      session_id: "ses_b",
      created_at: 999,
      is_captured: 0,
    });

    const result = getLastUncapturedPrompt("ses_a");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("new");
    expect(result!.content).toBe("new");
  });

  test("markCaptured sets capture flag and linked memory id", () => {
    insertPromptRow({ id: "mark_cap", linked_memory_id: null, is_captured: 0 });

    markCaptured("mark_cap", "mem_123");

    const row = testDb
      .query(
        "SELECT is_captured, linked_memory_id FROM user_prompts WHERE id = ?",
      )
      .get("mark_cap") as {
      is_captured: number;
      linked_memory_id: string | null;
    };

    expect(row.is_captured).toBe(1);
    expect(row.linked_memory_id).toBe("mem_123");
  });

  test("markAnalyzed sets user learning captured flag", () => {
    insertPromptRow({ id: "mark_an", is_user_learning_captured: 0 });

    markAnalyzed("mark_an");

    const row = testDb
      .query("SELECT is_user_learning_captured FROM user_prompts WHERE id = ?")
      .get("mark_an") as { is_user_learning_captured: number };

    expect(row.is_user_learning_captured).toBe(1);
  });

  test("getUnanalyzedPrompts returns only unanalyzed rows", () => {
    insertPromptRow({ id: "u1", is_user_learning_captured: 0, created_at: 10 });
    insertPromptRow({ id: "a1", is_user_learning_captured: 1, created_at: 20 });
    insertPromptRow({ id: "u2", is_user_learning_captured: 0, created_at: 30 });

    const rows = getUnanalyzedPrompts(10);

    expect(rows.map((r) => r.id)).toEqual(["u1", "u2"]);
  });

  test("getUnanalyzedPrompts respects ascending created_at order and limit", () => {
    insertPromptRow({
      id: "p3",
      created_at: 300,
      is_user_learning_captured: 0,
    });
    insertPromptRow({
      id: "p1",
      created_at: 100,
      is_user_learning_captured: 0,
    });
    insertPromptRow({
      id: "p2",
      created_at: 200,
      is_user_learning_captured: 0,
    });

    const rows = getUnanalyzedPrompts(2);
    expect(rows.map((r) => r.id)).toEqual(["p1", "p2"]);
  });
});
