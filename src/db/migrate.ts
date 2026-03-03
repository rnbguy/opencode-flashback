import { Database } from "bun:sqlite";
import { existsSync, copyFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { getDb, insertMemory } from "./database.ts";
import { embed } from "../embed/embedder.ts";
import type { Memory } from "../types.ts";

interface MigrationCheckpoint {
  phase: "backup" | "copy" | "reembed" | "verify" | "switchover" | "done";
  lastId: string;
  count: number;
  total: number;
}

type MigrationStatus =
  | { status: "not_needed" }
  | { status: "in_progress"; checkpoint: MigrationCheckpoint }
  | { status: "completed"; migratedCount: number }
  | { status: "failed"; error: string };

interface OldMemoryRow {
  id: string;
  content: string;
  vector: Uint8Array | null;
  tags_vector: Uint8Array | null;
  container_tag: string;
  tags: string | null;
  type: string | null;
  created_at: number;
  updated_at: number;
  metadata: string | null;
  user_name: string | null;
  user_email: string | null;
  project_path: string | null;
  project_name: string | null;
  git_repo_url: string | null;
  is_pinned: number;
}

const BATCH_SIZE = 50;

function findOldDb(): string | null {
  const candidates = [
    join(homedir(), ".opencode-mem", "data", "memories.db"),
    join(homedir(), ".opencode-mem", "memories.db"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function saveCheckpoint(db: Database, checkpoint: MigrationCheckpoint): void {
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    "migration_checkpoint",
    JSON.stringify(checkpoint),
  );
}

function loadCheckpoint(db: Database): MigrationCheckpoint | null {
  const row = db
    .query("SELECT value FROM meta WHERE key = 'migration_checkpoint'")
    .get() as { value: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as MigrationCheckpoint;
  } catch {
    // checkpoint JSON is corrupt -- treat as no checkpoint
    return null;
  }
}

function oldRowToNewMemory(
  row: OldMemoryRow,
  newEmbedding: Float32Array,
): Memory {
  return {
    id: row.id,
    content: row.content,
    embedding: newEmbedding,
    containerTag: row.container_tag,
    tags: row.tags
      ? row.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0)
      : [],
    type: row.type ?? "note",
    isPinned: row.is_pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseMetadata(row.metadata),
    userName: row.user_name ?? "",
    userEmail: row.user_email ?? "",
    projectPath: row.project_path ?? "",
    projectName: row.project_name ?? "",
    gitRepoUrl: row.git_repo_url ?? "",
    provenance: { sessionId: "", messageRange: [0, 0], toolCallIds: [] },
    lastAccessedAt: row.updated_at,
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

function parseMetadata(
  value: string | null,
): Record<string, string | number | boolean | null> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }

    const result: Record<string, string | number | boolean | null> = {};
    for (const [key, item] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean" ||
        item === null
      ) {
        result[key] = item;
      }
    }
    return result;
  } catch {
    // legacy JSON parse failed -- return empty object for safe migration
    return {};
  }
}

function getMarker(db: Database): { value: string } | null {
  return db
    .query("SELECT value FROM meta WHERE key = 'migration_completed'")
    .get() as { value: string } | null;
}

function getOldTotal(oldDb: Database): number {
  const row = oldDb.query("SELECT COUNT(*) as count FROM memories").get() as {
    count: number;
  };
  return row.count;
}

function backupOldDb(oldPath: string): void {
  const backupPath = `${oldPath}.backup-${Date.now()}`;
  const tempPath = join(dirname(oldPath), `${Date.now()}-backup.tmp`);
  copyFileSync(oldPath, tempPath);
  renameSync(tempPath, backupPath);
}

function getMainDbPath(db: Database): string | null {
  const rows = db.query("PRAGMA database_list").all() as Array<{
    name: string;
    file: string;
  }>;
  const main = rows.find((row) => row.name === "main");
  if (!main) return null;
  return main.file.length > 0 ? main.file : null;
}

function verifyMigratedRows(oldDb: Database, newDb: Database): number {
  const total = getOldTotal(oldDb);
  let offset = 0;
  let migratedCount = 0;

  while (offset < total) {
    const idRows = oldDb
      .query(
        "SELECT id FROM memories ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
      )
      .all(BATCH_SIZE, offset) as Array<{ id: string }>;
    if (idRows.length === 0) break;

    const ids = idRows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    const countRow = newDb
      .query(
        `SELECT COUNT(*) as count FROM memories WHERE id IN (${placeholders})`,
      )
      .get(...ids) as { count: number };
    migratedCount += countRow.count;
    offset += idRows.length;
  }

  return migratedCount;
}

export async function runMigration(
  onProgress?: (msg: string) => void,
): Promise<MigrationStatus> {
  const oldPath = findOldDb();
  if (!oldPath) return { status: "not_needed" };

  const db = getDb();
  if (getMarker(db)) return { status: "not_needed" };

  let checkpoint = loadCheckpoint(db);

  try {
    if (!checkpoint || checkpoint.phase === "backup") {
      backupOldDb(oldPath);
      onProgress?.("Backed up old database");
      checkpoint = { phase: "copy", lastId: "", count: 0, total: 0 };
      saveCheckpoint(db, checkpoint);
    }

    const oldDb = new Database(oldPath, { readonly: true });
    try {
      const total = getOldTotal(oldDb);
      if (total === 0) {
        db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
          "migration_completed",
          String(Date.now()),
        );
        db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
          "migration_migrated_count",
          "0",
        );
        db.query("DELETE FROM meta WHERE key = 'migration_checkpoint'").run();
        return { status: "completed", migratedCount: 0 };
      }

      if (checkpoint.phase !== "reembed") {
        checkpoint = { phase: "reembed", lastId: "", count: 0, total };
        saveCheckpoint(db, checkpoint);
      } else {
        checkpoint.total = total;
      }

      while (checkpoint.count < checkpoint.total) {
        const rows = oldDb
          .query(
            "SELECT id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at, metadata, user_name, user_email, project_path, project_name, git_repo_url, is_pinned FROM memories ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
          )
          .all(BATCH_SIZE, checkpoint.count) as OldMemoryRow[];

        if (rows.length === 0) break;

        const vectors = await embed(
          rows.map((row) => row.content),
          "document",
        );

        for (let i = 0; i < rows.length; i++) {
          const memory = oldRowToNewMemory(
            rows[i],
            new Float32Array(vectors[i]),
          );
          insertMemory(db, memory);
          checkpoint.count += 1;
          checkpoint.lastId = rows[i].id;
        }

        saveCheckpoint(db, checkpoint);
        const pct = Math.floor((checkpoint.count / checkpoint.total) * 100);
        onProgress?.(
          `Migrated ${checkpoint.count}/${checkpoint.total} memories (${pct}%)`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      checkpoint.phase = "verify";
      saveCheckpoint(db, checkpoint);

      const migratedCount = verifyMigratedRows(oldDb, db);
      if (migratedCount !== checkpoint.total) {
        const error = "Row count mismatch";
        db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
          "migration_failed_error",
          error,
        );
        return { status: "failed", error };
      }

      checkpoint.phase = "switchover";
      saveCheckpoint(db, checkpoint);

      const mainDbPath = getMainDbPath(db);
      if (mainDbPath && existsSync(mainDbPath)) {
        const switchoverTemp = `${mainDbPath}.switchover.tmp`;
        const switchoverDone = `${mainDbPath}.switchover-${Date.now()}`;
        copyFileSync(mainDbPath, switchoverTemp);
        renameSync(switchoverTemp, switchoverDone);
      }

      checkpoint.phase = "done";
      saveCheckpoint(db, checkpoint);

      const now = String(Date.now());
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        "migration_completed",
        now,
      );
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        "migration_migrated_count",
        String(migratedCount),
      );
      db.query("DELETE FROM meta WHERE key = 'migration_checkpoint'").run();
      db.query("DELETE FROM meta WHERE key = 'migration_failed_error'").run();

      return { status: "completed", migratedCount };
    } finally {
      oldDb.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "migration_failed_error",
      message,
    );
    return { status: "failed", error: message };
  }
}

export function getMigrationStatus(): MigrationStatus {
  const oldPath = findOldDb();
  if (!oldPath) return { status: "not_needed" };

  const db = getDb();
  const marker = getMarker(db);
  if (marker) {
    const countRow = db
      .query("SELECT value FROM meta WHERE key = 'migration_migrated_count'")
      .get() as { value: string } | null;
    const migratedCount = countRow
      ? Number.parseInt(countRow.value, 10) || 0
      : 0;
    return { status: "completed", migratedCount };
  }

  const checkpoint = loadCheckpoint(db);
  if (checkpoint) {
    return { status: "in_progress", checkpoint };
  }

  const failedRow = db
    .query("SELECT value FROM meta WHERE key = 'migration_failed_error'")
    .get() as { value: string } | null;
  if (failedRow) {
    return { status: "failed", error: failedRow.value };
  }

  return {
    status: "in_progress",
    checkpoint: { phase: "backup", lastId: "", count: 0, total: 0 },
  };
}
