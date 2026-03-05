import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAllData,
  clearOldData,
  closeDb,
  getDb,
  getMetaValue,
  insertMemory,
  insertProfile,
  insertPrompt,
  setMetaValue,
} from "../src/db/database";
import type { Memory, UserProfile, UserPrompt } from "../src/types";

// -- Helpers ------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "test-db-ext-"));
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: `mem_${Math.random().toString(36).slice(2, 10)}`,
    content: "test memory content",
    embedding: new Float32Array([0.1, 0.2, 0.3]),
    containerTag: "mem_project_abc123",
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

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  const now = Date.now();
  return {
    id: "prof_001",
    userId: "user_001",
    profileData: { preferences: [], patterns: [], workflows: [] },
    createdAt: now,
    lastAnalyzedAt: now,
    totalPromptsAnalyzed: 0,
    ...overrides,
  };
}

function makePrompt(overrides: Partial<UserPrompt> = {}): UserPrompt {
  return {
    id: `prompt_${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "ses_001",
    messageId: "msg_001",
    content: "test prompt",
    directory: "/tmp",
    isCaptured: false,
    isUserLearningCaptured: false,
    ...overrides,
  };
}

// -- getMetaValue / setMetaValue (lines 244-256) -------------------------

describe("meta value operations", () => {
  test("setMetaValue and getMetaValue round-trip", () => {
    const db = getDb(join(tmpDir, "test.db"));

    setMetaValue(db, "test_key", "test_value");
    const value = getMetaValue(db, "test_key");

    expect(value).toBe("test_value");
    closeDb();
  });

  test("getMetaValue returns null for missing key", () => {
    const db = getDb(join(tmpDir, "test.db"));

    const value = getMetaValue(db, "nonexistent_key");
    expect(value).toBeNull();

    closeDb();
  });

  test("setMetaValue overwrites existing value", () => {
    const db = getDb(join(tmpDir, "test.db"));

    setMetaValue(db, "key", "value1");
    expect(getMetaValue(db, "key")).toBe("value1");

    setMetaValue(db, "key", "value2");
    expect(getMetaValue(db, "key")).toBe("value2");

    closeDb();
  });
});

// -- clearAllData (lines 486-497) -----------------------------------------

describe("clearAllData", () => {
  test("clears all data from all tables", () => {
    const db = getDb(join(tmpDir, "test.db"));

    // Insert test data
    const mem = makeMemory({ id: "mem_clear_test" });
    insertMemory(db, mem);

    const prof = makeProfile({ id: "prof_clear_test" });
    insertProfile(db, prof);

    const prompt = makePrompt({ id: "p_clear_test" });
    insertPrompt(db, prompt);

    // Verify data exists
    expect(
      db.query("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number },
    ).toEqual({ cnt: 1 });

    clearAllData(db);

    // Verify all data is cleared
    expect(
      db.query("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number },
    ).toEqual({ cnt: 0 });
    expect(
      db.query("SELECT COUNT(*) as cnt FROM user_profiles").get() as {
        cnt: number;
      },
    ).toEqual({ cnt: 0 });
    expect(
      db.query("SELECT COUNT(*) as cnt FROM user_prompts").get() as {
        cnt: number;
      },
    ).toEqual({ cnt: 0 });

    closeDb();
  });
});

// -- clearOldData (lines 499-512) -----------------------------------------

describe("clearOldData", () => {
  test("clears old data and returns change count", () => {
    const db = getDb(join(tmpDir, "test.db"));

    const now = Date.now();
    const oldTime = now - 100000; // 100 seconds ago

    // Insert old and new memories
    insertMemory(db, makeMemory({ id: "mem_old", createdAt: oldTime }));
    insertMemory(db, makeMemory({ id: "mem_new", createdAt: now }));

    // Insert old and new prompts
    insertPrompt(db, makePrompt({ id: "p_old" }));
    db.query("UPDATE user_prompts SET created_at = ? WHERE id = ?").run(
      oldTime,
      "p_old",
    );

    insertPrompt(db, makePrompt({ id: "p_new" }));

    // Clear data older than 50 seconds ago
    const cutoff = now - 50000;
    const changes = clearOldData(db, cutoff);

    // Should have deleted 1 memory and 1 prompt
    expect(changes).toBe(1);

    // Verify old data is gone
    expect(
      db.query("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number },
    ).toEqual({ cnt: 1 });
    expect(
      db.query("SELECT COUNT(*) as cnt FROM user_prompts").get() as {
        cnt: number;
      },
    ).toEqual({ cnt: 1 });

    // Verify new data remains
    const mem = db.query("SELECT id FROM memories").get() as {
      id: string;
    } | null;
    expect(mem!.id).toBe("mem_new");

    closeDb();
  });

  test("clearOldData returns 0 when no old data exists", () => {
    const db = getDb(join(tmpDir, "test.db"));

    const now = Date.now();
    insertMemory(db, makeMemory({ id: "mem_new", createdAt: now }));
    insertPrompt(db, makePrompt({ id: "p_new" }));

    // Clear data older than 1 second ago (nothing should match)
    const changes = clearOldData(db, now - 1000);

    expect(changes).toBe(0);

    closeDb();
  });
});
