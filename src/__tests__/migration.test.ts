import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getDb, closeDb } from "../db/database.ts";

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
  display_name TEXT,
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

let runMigration: (typeof import("../db/migrate.ts"))["runMigration"];
let getMigrationStatus: (typeof import("../db/migrate.ts"))["getMigrationStatus"];

function oldDbPath(): string {
  return join(tmpHome, ".opencode-mem", "data", "memories.db");
}

function newDbPath(): string {
  return join(tmpHome, "new", "flashback.db");
}

function createOldDb(path: string, rowCount: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.exec(OLD_SCHEMA_SQL);

  const stmt = db.query(
    `INSERT INTO memories (
      id, content, vector, tags_vector, container_tag, tags, type,
      created_at, updated_at, metadata, display_name, user_name, user_email,
      project_path, project_name, git_repo_url, is_pinned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      "display",
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

    mock.module("@huggingface/transformers", () => ({
      pipeline: mock(async () => async (inputs: string[]) => {
        embedCalls += 1;
        if (embedCalls === failEmbedOnCall) {
          throw new Error("simulated migration interruption");
        }

        const output: Record<string | number, unknown> = {
          dispose: () => {},
        };
        for (let i = 0; i < inputs.length; i++) {
          output[i] = {
            data: Array.from(
              { length: 768 },
              (_, j) => Math.sin(j + inputs[i].length) * 0.5,
            ),
          };
        }
        return output;
      }),
    }));

    const migrate = await import(
      `../db/migrate.ts?migration-test=${Date.now()}`
    );
    runMigration = migrate.runMigration;
    getMigrationStatus = migrate.getMigrationStatus;

    getDb(newDbPath());
  });

  afterEach(() => {
    closeDb();
    mockedHome = "";
    mock.restore();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("returns not_needed when no old database exists", async () => {
    const result = await runMigration();
    expect(result).toEqual({ status: "not_needed" });
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
        "SELECT content, container_tag, tags, type, display_name, user_email FROM memories WHERE id = ?",
      )
      .get("old-0003") as {
      content: string;
      container_tag: string;
      tags: string;
      type: string;
      display_name: string;
      user_email: string;
    };

    expect(row.content).toBe("old-content-3");
    expect(row.container_tag).toBe("test-container");
    expect(JSON.parse(row.tags)).toEqual(["rust", "sqlite"]);
    expect(row.type).toBe("note");
    expect(row.display_name).toBe("display");
    expect(row.user_email).toBe("user@example.com");
  });

  test("resumes from checkpoint after interruption", async () => {
    createOldDb(oldDbPath(), 120);
    failEmbedOnCall = 6;

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
});
