import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  countMemories,
  deleteMemory,
  getAllActiveMemories,
  getMemory,
  getProfile,
  getRevision,
  incrementRevision,
  insertMemory,
  insertProfile,
  insertPrompt,
  listMemories,
  markPromptCaptured,
  searchMemoriesByText,
  updateProfile,
} from "../src/db/database";
import type { Memory, UserProfile, UserPrompt } from "../src/types";

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
    CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      profile_data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_analyzed_at INTEGER NOT NULL,
      total_prompts_analyzed INTEGER NOT NULL DEFAULT 0
    );
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

// -- Memory CRUD --------------------------------------------------------------

describe("memory CRUD", () => {
  let db: Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  test("insert and retrieve memory", () => {
    const mem = makeMemory({ id: "mem_test1", content: "hello world" });
    insertMemory(db, mem);

    const retrieved = getMemory(db, "mem_test1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("mem_test1");
    expect(retrieved!.content).toBe("hello world");
    expect(retrieved!.containerTag).toBe("mem_project_abc123");
    expect(retrieved!.tags).toEqual(["test"]);
    expect(retrieved!.isStarred).toBe(false);
    expect(retrieved!.userName).toBe("tester");
    expect(retrieved!.userEmail).toBe("test@example.com");
  });

  test("embedding round-trips correctly", () => {
    const embedding = new Float32Array([1.5, -2.3, 0.0, 42.0]);
    const mem = makeMemory({ id: "mem_embed", embedding });
    insertMemory(db, mem);

    const retrieved = getMemory(db, "mem_embed");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.embedding.length).toBe(4);
    expect(retrieved!.embedding[0]).toBeCloseTo(1.5);
    expect(retrieved!.embedding[1]).toBeCloseTo(-2.3);
    expect(retrieved!.embedding[2]).toBeCloseTo(0.0);
    expect(retrieved!.embedding[3]).toBeCloseTo(42.0);
  });

  test("getMemory returns null for missing id", () => {
    expect(getMemory(db, "nonexistent")).toBeNull();
  });

  test("deleteMemory removes the record", () => {
    const mem = makeMemory({ id: "mem_del" });
    insertMemory(db, mem);
    expect(getMemory(db, "mem_del")).not.toBeNull();

    deleteMemory(db, "mem_del");
    expect(getMemory(db, "mem_del")).toBeNull();
  });

  test("deleteMemory is a no-op for missing id", () => {
    // Should not throw
    deleteMemory(db, "nonexistent");
  });

  test("insertMemory upserts on same id", () => {
    const mem = makeMemory({ id: "mem_upsert", content: "v1" });
    insertMemory(db, mem);
    expect(getMemory(db, "mem_upsert")!.content).toBe("v1");

    const updated = makeMemory({ id: "mem_upsert", content: "v2" });
    insertMemory(db, updated);
    expect(getMemory(db, "mem_upsert")!.content).toBe("v2");
    expect(countMemories(db, "mem_project_abc123")).toBe(1);
  });

  test("provenance fields round-trip", () => {
    const mem = makeMemory({
      id: "mem_prov",
      provenance: {
        sessionId: "ses_abc",
        messageRange: [10, 20],
        toolCallIds: ["tc_a", "tc_b"],
      },
    });
    insertMemory(db, mem);

    const retrieved = getMemory(db, "mem_prov")!;
    expect(retrieved.provenance.sessionId).toBe("ses_abc");
    expect(retrieved.provenance.messageRange).toEqual([10, 20]);
    expect(retrieved.provenance.toolCallIds).toEqual(["tc_a", "tc_b"]);
  });

  test("metadata round-trips", () => {
    const mem = makeMemory({
      id: "mem_meta",
      metadata: { key: "value", num: 42, flag: true, nil: null },
    });
    insertMemory(db, mem);

    const retrieved = getMemory(db, "mem_meta")!;
    expect(retrieved.metadata).toEqual({
      key: "value",
      num: 42,
      flag: true,
      nil: null,
    });
  });

  test("boolean fields round-trip", () => {
    const mem = makeMemory({
      id: "mem_bool",
      isStarred: true,
      suspended: true,
    });
    insertMemory(db, mem);

    const retrieved = getMemory(db, "mem_bool")!;
    expect(retrieved.isStarred).toBe(true);
    expect(retrieved.suspended).toBe(true);
  });

  test("optional fields default correctly", () => {
    const mem = makeMemory({
      id: "mem_opt",
      sourceFile: undefined,
      sourceLine: undefined,
    });
    insertMemory(db, mem);

    const retrieved = getMemory(db, "mem_opt")!;
    expect(retrieved.sourceFile).toBeUndefined();
    expect(retrieved.sourceLine).toBeUndefined();
  });
});

// -- List / search / count ----------------------------------------------------

describe("listMemories / searchMemoriesByText / countMemories", () => {
  let db: Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  test("listMemories returns by container tag", () => {
    insertMemory(db, makeMemory({ id: "m1", containerTag: "tag_a" }));
    insertMemory(db, makeMemory({ id: "m2", containerTag: "tag_a" }));
    insertMemory(db, makeMemory({ id: "m3", containerTag: "tag_b" }));

    expect(listMemories(db, "tag_a", 100, 0)).toHaveLength(2);
    expect(listMemories(db, "tag_b", 100, 0)).toHaveLength(1);
    expect(listMemories(db, "tag_c", 100, 0)).toHaveLength(0);
  });

  test("listMemories respects limit and offset", () => {
    for (let i = 0; i < 5; i++) {
      insertMemory(
        db,
        makeMemory({
          id: `m_${i}`,
          containerTag: "tag_x",
          createdAt: Date.now() + i,
        }),
      );
    }

    const page1 = listMemories(db, "tag_x", 2, 0);
    expect(page1).toHaveLength(2);

    const page2 = listMemories(db, "tag_x", 2, 2);
    expect(page2).toHaveLength(2);

    const page3 = listMemories(db, "tag_x", 2, 4);
    expect(page3).toHaveLength(1);
  });

  test("searchMemoriesByText matches substring", () => {
    insertMemory(
      db,
      makeMemory({
        id: "s1",
        content: "Rust is great",
        containerTag: "tag_s",
      }),
    );
    insertMemory(
      db,
      makeMemory({
        id: "s2",
        content: "Python is fine",
        containerTag: "tag_s",
      }),
    );

    const results = searchMemoriesByText(db, "Rust", "tag_s", 10);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s1");
  });

  test("searchMemoriesByText is case-sensitive in LIKE", () => {
    insertMemory(
      db,
      makeMemory({
        id: "cs1",
        content: "Hello World",
        containerTag: "tag_cs",
      }),
    );

    // SQLite LIKE is case-insensitive for ASCII by default
    const results = searchMemoriesByText(db, "hello", "tag_cs", 10);
    expect(results).toHaveLength(1);
  });

  test("searchMemoriesByText returns empty for no match", () => {
    insertMemory(
      db,
      makeMemory({ id: "nm1", content: "abc", containerTag: "tag_nm" }),
    );
    expect(searchMemoriesByText(db, "xyz", "tag_nm", 10)).toHaveLength(0);
  });

  test("countMemories counts per container tag", () => {
    insertMemory(db, makeMemory({ id: "c1", containerTag: "tag_cnt" }));
    insertMemory(db, makeMemory({ id: "c2", containerTag: "tag_cnt" }));
    insertMemory(db, makeMemory({ id: "c3", containerTag: "other" }));

    expect(countMemories(db, "tag_cnt")).toBe(2);
    expect(countMemories(db, "other")).toBe(1);
    expect(countMemories(db, "empty")).toBe(0);
  });
});

// -- getAllActiveMemories ------------------------------------------------------

describe("getAllActiveMemories", () => {
  let db: Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  test("excludes evicted memories", () => {
    insertMemory(db, makeMemory({ id: "active1" }));
    insertMemory(db, makeMemory({ id: "evicted1", evictedAt: Date.now() }));

    const active = getAllActiveMemories(db);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("active1");
  });

  test("excludes suspended memories", () => {
    insertMemory(db, makeMemory({ id: "active2" }));
    insertMemory(db, makeMemory({ id: "susp1", suspended: true }));

    const active = getAllActiveMemories(db);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("active2");
  });

  test("returns empty when no active memories", () => {
    insertMemory(db, makeMemory({ id: "e1", evictedAt: Date.now() }));
    insertMemory(db, makeMemory({ id: "s1", suspended: true }));
    expect(getAllActiveMemories(db)).toHaveLength(0);
  });
});

// -- Profile CRUD -------------------------------------------------------------

describe("profile CRUD", () => {
  let db: Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  test("insert and retrieve profile", () => {
    const prof = makeProfile({
      profileData: {
        preferences: [{ category: "lang", description: "en", confidence: 0.7 }],
        patterns: [],
        workflows: [],
      },
    });
    insertProfile(db, prof);

    const retrieved = getProfile(db, "user_001");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.userId).toBe("user_001");
    expect(retrieved!.profileData.preferences).toEqual([
      { category: "lang", description: "en", confidence: 0.7 },
    ]);
  });

  test("getProfile returns null for missing user", () => {
    expect(getProfile(db, "nonexistent")).toBeNull();
  });

  test("updateProfile modifies fields", () => {
    const prof = makeProfile();
    insertProfile(db, prof);

    const updated: UserProfile = {
      ...prof,
      totalPromptsAnalyzed: 5,
      profileData: {
        preferences: [
          { category: "theme", description: "dark", confidence: 0.8 },
        ],
        patterns: [{ category: "freq", description: "daily" }],
        workflows: [],
      },
    };
    updateProfile(db, updated);

    const retrieved = getProfile(db, "user_001")!;
    expect(retrieved.totalPromptsAnalyzed).toBe(5);
    expect(retrieved.profileData.preferences).toEqual([
      { category: "theme", description: "dark", confidence: 0.8 },
    ]);
  });

  test("insertProfile upserts on same id", () => {
    const prof = makeProfile({ id: "prof_upsert" });
    insertProfile(db, prof);

    const updated = makeProfile({
      id: "prof_upsert",
      totalPromptsAnalyzed: 99,
    });
    insertProfile(db, updated);

    const retrieved = getProfile(db, "user_001")!;
    expect(retrieved.totalPromptsAnalyzed).toBe(99);
  });
});

// -- Prompt CRUD --------------------------------------------------------------

describe("prompt CRUD", () => {
  let db: Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  test("insert prompt", () => {
    const prompt = makePrompt({ id: "p1", content: "how do I X?" });
    insertPrompt(db, prompt);

    const row = db
      .query("SELECT * FROM user_prompts WHERE id = ?")
      .get("p1") as Record<string, unknown> | null;
    expect(row).not.toBeNull();
    expect(row!.content).toBe("how do I X?");
    expect(row!.is_captured).toBe(0);
  });

  test("markPromptCaptured sets is_captured = 1", () => {
    const prompt = makePrompt({ id: "p2" });
    insertPrompt(db, prompt);

    markPromptCaptured(db, "p2");

    const row = db
      .query("SELECT is_captured FROM user_prompts WHERE id = ?")
      .get("p2") as { is_captured: number };
    expect(row.is_captured).toBe(1);
  });

  test("markPromptCaptured is idempotent", () => {
    const prompt = makePrompt({ id: "p3" });
    insertPrompt(db, prompt);

    for (let i = 0; i < 2; i++) {
      markPromptCaptured(db, "p3");
    }

    const row = db
      .query("SELECT is_captured FROM user_prompts WHERE id = ?")
      .get("p3") as { is_captured: number };
    expect(row.is_captured).toBe(1);
  });

  test("prompt with linkedMemoryId", () => {
    const prompt = makePrompt({ id: "p4", linkedMemoryId: "mem_linked" });
    insertPrompt(db, prompt);

    const row = db
      .query("SELECT linked_memory_id FROM user_prompts WHERE id = ?")
      .get("p4") as { linked_memory_id: string | null };
    expect(row.linked_memory_id).toBe("mem_linked");
  });

  test("prompt without linkedMemoryId stores null", () => {
    const prompt = makePrompt({ id: "p5" });
    insertPrompt(db, prompt);

    const row = db
      .query("SELECT linked_memory_id FROM user_prompts WHERE id = ?")
      .get("p5") as { linked_memory_id: string | null };
    expect(row.linked_memory_id).toBeNull();
  });
});

// -- WAL mode -----------------------------------------------------------------

describe("WAL mode", () => {
  test(":memory: db with WAL pragma", () => {
    const db = createInMemoryDb();
    // In :memory: databases, WAL may not apply but the pragma should not error
    const result = db.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    // :memory: databases return "memory" for journal_mode
    expect(["wal", "memory"]).toContain(result.journal_mode);
    db.close();
  });
});

// -- Schema / migrations ------------------------------------------------------

describe("schema", () => {
  test("meta table tracks schema version", () => {
    const db = createInMemoryDb();
    const row = db
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(row.value).toBe("2");
    db.close();
  });

  test("all expected tables exist", () => {
    const db = createInMemoryDb();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("memories");
    expect(names).toContain("user_profiles");
    expect(names).toContain("user_prompts");
    expect(names).toContain("meta");
    db.close();
  });
});

describe("migration atomicity", () => {
  test("failed migration rolls back without advancing schema_version", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)",
    );
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '0')");

    db.exec("BEGIN");
    try {
      db.exec("CREATE TABLE test_success (id TEXT PRIMARY KEY)");
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        "schema_version",
        "1",
      );
      db.exec("COMMIT");
    } catch {
      db.exec("ROLLBACK");
      throw new Error("Migration 1 should not fail");
    }

    db.exec("BEGIN");
    try {
      db.exec("CREATE TABLE meta (key TEXT)");
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        "schema_version",
        "2",
      );
      db.exec("COMMIT");
    } catch {
      db.exec("ROLLBACK");
    }

    const row = db
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as {
      value: string;
    };
    expect(row.value).toBe("1");

    const tables = db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'test_%'",
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("test_success");
    expect(tables.map((t) => t.name)).not.toContain("test_fail");

    db.close();
  });
});

// -- db_revision meta key -------------------------------------------------------

describe("db_revision meta key", () => {
  let db: Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  test("getRevision returns 0 when not set", () => {
    expect(getRevision(db)).toBe(0);
  });

  test("incrementRevision increments the revision", () => {
    expect(getRevision(db)).toBe(0);
    incrementRevision(db);
    expect(getRevision(db)).toBe(1);
    incrementRevision(db);
    expect(getRevision(db)).toBe(2);
  });

  test("insertMemory increments revision", () => {
    const initialRevision = getRevision(db);
    const mem = makeMemory({ id: "mem_rev1" });
    insertMemory(db, mem);
    expect(getRevision(db)).toBe(initialRevision + 1);
  });

  test("deleteMemory increments revision", () => {
    const mem = makeMemory({ id: "mem_rev2" });
    insertMemory(db, mem);
    const revisionAfterInsert = getRevision(db);
    deleteMemory(db, "mem_rev2");
    expect(getRevision(db)).toBe(revisionAfterInsert + 1);
  });
});
