import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DB_FILENAME } from "../consts.ts";
import {
  _resetEmbedDepsForTesting,
  _setEmbedDepsForTesting,
  resetEmbedder,
} from "../core/ai/embed.ts";
import type { createEmbeddingProvider } from "../core/ai/providers.ts";
import { closeDb, getDb } from "../db/database.ts";

const OLD_SCHEMA_SQL = `
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  vector BLOB,
  tags_vector BLOB,
  container_tag TEXT NOT NULL,
  tags TEXT,
  type TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT,
  user_name TEXT,
  user_email TEXT,
  project_path TEXT,
  project_name TEXT,
  git_repo_url TEXT,
  is_pinned INTEGER DEFAULT 0
);
`;

let mockedHome = "";
let embedCalls = 0;
let failEmbedOnCall = Number.POSITIVE_INFINITY;
let tmpHome = "";

let runMigration: typeof import("../db/migrate.ts")["runMigration"];
let getMigrationStatus: typeof import("../db/migrate.ts")["getMigrationStatus"];

function seededVector(text: string): number[] {
  const vector = Array.from(
    { length: 768 },
    (_, j) => Math.sin(j + text.length) * 0.5,
  );
  return vector;
}

function oldDbPath(): string {
  return join(tmpHome, ".opencode-mem", "data", "memories.db");
}

function newDbPath(): string {
  return join(tmpHome, "new", DB_FILENAME);
}

function createOldDb(path: string, rowCount: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.exec(OLD_SCHEMA_SQL);

  const stmt = db.query(
    `INSERT INTO memories (
      id, content, vector, tags_vector, container_tag, tags, type,
      created_at, updated_at, metadata, user_name, user_email,
      project_path, project_name, git_repo_url, is_pinned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const base = Date.now() - rowCount * 1000;
  for (let i = 0; i < rowCount; i++) {
    const id = `old-${i.toString().padStart(4, "0")}`;
    stmt.run(
      id,
      `old-content-${i}`,
      null,
      null,
      "test-container",
      "rust,sqlite",
      "note",
      base + i,
      base + i,
      JSON.stringify({ source: "old" }),
      "user",
      "user@example.com",
      "/tmp/project",
      "project",
      "https://example.com/repo.git",
      i % 2,
    );
  }

  db.close();
}

describe("migration", () => {
  beforeEach(async () => {
    closeDb();
    embedCalls = 0;
    failEmbedOnCall = Number.POSITIVE_INFINITY;
    tmpHome = mkdtempSync(join(tmpdir(), "flashback-migrate-"));
    mockedHome = tmpHome;

    mock.module("node:os", () => ({
      homedir: () => mockedHome,
    }));

    const mockEmbedMany = mock((_opts: { values: string[] }) => {
      embedCalls += 1;
      if (embedCalls === failEmbedOnCall) {
        throw new Error("simulated migration interruption");
      }
      return Promise.resolve({
        embeddings: _opts.values.map((value) => seededVector(value)),
      });
    });
    const mockCreateEmbeddingProvider = mock(() =>
      Promise.resolve({ embedding: (_id: string) => ({}) }),
    );
    _setEmbedDepsForTesting({
      embedMany: mockEmbedMany as unknown as typeof import("ai").embedMany,
      createEmbeddingProvider:
        mockCreateEmbeddingProvider as unknown as typeof createEmbeddingProvider,
    });
    resetEmbedder();

    const migrate = await import("../db/migrate.ts");
    runMigration = migrate.runMigration;
    getMigrationStatus = migrate.getMigrationStatus;

    getDb(newDbPath());
  });

  afterEach(() => {
    closeDb();
    resetEmbedder();
    _resetEmbedDepsForTesting();
    mockedHome = "";
    mock.restore();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("returns not_needed when no old database exists", async () => {
    const result = await runMigration();
    expect(result).toEqual({ status: "not_needed" });
  });

  test("completes with zero migrated rows when old database is empty", async () => {
    createOldDb(oldDbPath(), 0);

    const result = await runMigration();
    expect(result).toEqual({ status: "completed", migratedCount: 0 });

    const status = getMigrationStatus();
    expect(status).toEqual({ status: "completed", migratedCount: 0 });
  });

  test("migrates all rows and preserves content", async () => {
    createOldDb(oldDbPath(), 12);

    const result = await runMigration();
    expect(result).toEqual({ status: "completed", migratedCount: 12 });

    const db = getDb();
    const countRow = db
      .query("SELECT COUNT(*) as count FROM memories")
      .get() as {
      count: number;
    };
    expect(countRow.count).toBe(12);

    const row = db
      .query(
        "SELECT content, container_tag, tags, type, user_email FROM memories WHERE id = ?",
      )
      .get("old-0003") as {
      content: string;
      container_tag: string;
      tags: string;
      type: string;
      user_email: string;
    };

    expect(row.content).toBe("old-content-3");
    expect(row.container_tag).toBe("test-container");
    expect(JSON.parse(row.tags)).toEqual(["rust", "sqlite"]);
    expect(row.type).toBe("note");
    expect(row.user_email).toBe("user@example.com");
  });

  test("resumes from checkpoint after interruption", async () => {
    createOldDb(oldDbPath(), 120);
    failEmbedOnCall = 2;

    const first = await runMigration();
    expect(first.status).toBe("failed");

    const statusAfterFailure = getMigrationStatus();
    expect(statusAfterFailure.status).toBe("in_progress");
    if (statusAfterFailure.status === "in_progress") {
      expect(statusAfterFailure.checkpoint.phase).toBe("reembed");
      expect(statusAfterFailure.checkpoint.count).toBe(50);
      expect(statusAfterFailure.checkpoint.total).toBe(120);
    }

    failEmbedOnCall = Number.POSITIVE_INFINITY;
    const resumed = await runMigration();
    expect(resumed).toEqual({ status: "completed", migratedCount: 120 });

    const db = getDb();
    const countRow = db
      .query("SELECT COUNT(*) as count FROM memories")
      .get() as {
      count: number;
    };
    expect(countRow.count).toBe(120);
  });

  test("keeps old database file untouched after migration", async () => {
    createOldDb(oldDbPath(), 7);
    const before = statSync(oldDbPath());
    const oldDb = new Database(oldDbPath(), { readonly: true });
    const beforeCount = oldDb
      .query("SELECT COUNT(*) as count FROM memories")
      .get() as {
      count: number;
    };
    oldDb.close();

    const result = await runMigration();
    expect(result).toEqual({ status: "completed", migratedCount: 7 });

    const after = statSync(oldDbPath());
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);

    const oldDbAfter = new Database(oldDbPath(), { readonly: true });
    const afterCount = oldDbAfter
      .query("SELECT COUNT(*) as count FROM memories")
      .get() as {
      count: number;
    };
    oldDbAfter.close();

    expect(afterCount.count).toBe(beforeCount.count);
  });

  test("reports completed migration status when completion marker exists", async () => {
    createOldDb(oldDbPath(), 5);
    const result = await runMigration();
    expect(result).toEqual({ status: "completed", migratedCount: 5 });

    const status = getMigrationStatus();
    expect(status).toEqual({ status: "completed", migratedCount: 5 });
  });

  test("reports failed status when failed marker exists", () => {
    createOldDb(oldDbPath(), 1);

    const db = getDb();
    db.query("DELETE FROM meta WHERE key = 'migration_checkpoint'").run();
    db.query("DELETE FROM meta WHERE key = 'migration_completed'").run();
    db.query("DELETE FROM meta WHERE key = 'migration_migrated_count'").run();
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "migration_failed_error",
      "manual failure",
    );

    const status = getMigrationStatus();
    expect(status).toEqual({ status: "failed", error: "manual failure" });
  });

  test("returns failed when verification count does not match", async () => {
    createOldDb(oldDbPath(), 3);

    const result = await runMigration((msg) => {
      if (msg.includes("Migrated 3/3")) {
        getDb().query("DELETE FROM memories WHERE id = ?").run("old-0002");
      }
    });

    expect(result).toEqual({ status: "failed", error: "Row count mismatch" });

    const status = getMigrationStatus();
    expect(status.status).toBe("in_progress");
    if (status.status === "in_progress") {
      expect(status.checkpoint.phase).toBe("verify");
      expect(status.checkpoint.count).toBe(3);
      expect(status.checkpoint.total).toBe(3);
    }

    const failedRow = getDb()
      .query("SELECT value FROM meta WHERE key = 'migration_failed_error'")
      .get() as { value: string } | null;
    expect(failedRow).toEqual({ value: "Row count mismatch" });
  });

  test("normalizes metadata edge cases during migration", async () => {
    createOldDb(oldDbPath(), 4);

    const oldDb = new Database(oldDbPath());
    oldDb
      .query("UPDATE memories SET metadata = ? WHERE id = ?")
      .run(null, "old-0000");
    oldDb
      .query("UPDATE memories SET metadata = ? WHERE id = ?")
      .run("{not-json", "old-0001");
    oldDb
      .query("UPDATE memories SET metadata = ? WHERE id = ?")
      .run('["a","b"]', "old-0002");
    oldDb.query("UPDATE memories SET metadata = ? WHERE id = ?").run(
      JSON.stringify({
        score: 7,
        ok: true,
        nested: { keep: false },
        list: [1, 2],
        maybe: null,
      }),
      "old-0003",
    );
    oldDb.close();

    const result = await runMigration();
    expect(result).toEqual({ status: "completed", migratedCount: 4 });

    const db = getDb();
    const rows = db
      .query("SELECT id, metadata FROM memories ORDER BY id ASC")
      .all() as Array<{ id: string; metadata: string }>;

    expect(rows).toEqual([
      { id: "old-0000", metadata: "{}" },
      { id: "old-0001", metadata: "{}" },
      { id: "old-0002", metadata: "{}" },
      {
        id: "old-0003",
        metadata: JSON.stringify({ score: 7, ok: true, maybe: null }),
      },
    ]);
  });

  test("migrates from fallback old db path", async () => {
    const fallbackPath = join(tmpHome, ".opencode-mem", "memories.db");
    createOldDb(fallbackPath, 2);

    const result = await runMigration();
    expect(result).toEqual({ status: "completed", migratedCount: 2 });

    const status = getMigrationStatus();
    expect(status).toEqual({ status: "completed", migratedCount: 2 });
  });

  test("ignores invalid checkpoint json and restarts from backup", async () => {
    createOldDb(oldDbPath(), 3);

    const db = getDb();
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "migration_checkpoint",
      "{not-valid-json",
    );

    const result = await runMigration();
    expect(result).toEqual({ status: "completed", migratedCount: 3 });
  });

  test("returns failed status when old database schema is invalid", async () => {
    const path = oldDbPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not-a-valid-sqlite-db");

    const result = await runMigration();
    expect(result.status).toBe("failed");

    const failedRow = getDb()
      .query("SELECT value FROM meta WHERE key = 'migration_failed_error'")
      .get() as { value: string } | null;
    expect(failedRow).not.toBeNull();
    expect((failedRow?.value ?? "").length).toBeGreaterThan(0);
  });

  test("reports default in_progress status when migration is pending", () => {
    createOldDb(oldDbPath(), 1);

    const status = getMigrationStatus();
    expect(status.status).toBe("in_progress");
    if (status.status === "in_progress") {
      expect(status.checkpoint).toEqual({
        phase: "backup",
        lastId: "",
        count: 0,
        total: 0,
      });
    }
  });

  test("reports in_progress status from existing checkpoint", () => {
    createOldDb(oldDbPath(), 4);
    const db = getDb();
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "migration_checkpoint",
      JSON.stringify({
        phase: "reembed",
        lastId: "old-0001",
        count: 2,
        total: 4,
      }),
    );

    const status = getMigrationStatus();
    expect(status).toEqual({
      status: "in_progress",
      checkpoint: {
        phase: "reembed",
        lastId: "old-0001",
        count: 2,
        total: 4,
      },
    });
  });

  test("static import coverage: migrates rows and reports completed status", async () => {
    createOldDb(oldDbPath(), 6);
    const migrate = await import("../db/migrate.ts");

    const result = await migrate.runMigration();
    expect(result).toEqual({ status: "completed", migratedCount: 6 });

    const status = migrate.getMigrationStatus();
    expect(status).toEqual({ status: "completed", migratedCount: 6 });
  });

  test("static import coverage: records migration failure on invalid old db", async () => {
    const path = oldDbPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not-a-valid-sqlite-db");

    const migrate = await import("../db/migrate.ts");
    const result = await migrate.runMigration();
    expect(result.status).toBe("failed");

    const status = migrate.getMigrationStatus();
    expect(status.status).toBe("in_progress");
  });

  test("static import coverage: reports failed status marker", async () => {
    createOldDb(oldDbPath(), 1);
    const migrate = await import("../db/migrate.ts");

    const db = getDb();
    db.query("DELETE FROM meta WHERE key = 'migration_checkpoint'").run();
    db.query("DELETE FROM meta WHERE key = 'migration_completed'").run();
    db.query("DELETE FROM meta WHERE key = 'migration_migrated_count'").run();
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "migration_failed_error",
      "static-import-failure",
    );

    const status = migrate.getMigrationStatus();
    expect(status).toEqual({
      status: "failed",
      error: "static-import-failure",
    });
  });
});
