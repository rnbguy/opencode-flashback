import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Memory, UserProfile, UserPrompt } from "../types.ts";
import { getLogger } from "../util/logger.ts";

// -- DB row shapes (internal) ------------------------------------------------

interface MemoryRow {
  id: string;
  content: string;
  embedding: Uint8Array;
  container_tag: string;
  tags: string | null;
  type: string | null;
  is_pinned: number;
  created_at: number;
  updated_at: number;
  metadata: string | null;
  display_name: string | null;
  user_name: string | null;
  user_email: string | null;
  project_path: string | null;
  project_name: string | null;
  git_repo_url: string | null;
  source_file: string | null;
  source_line: number | null;
  provenance_session_id: string | null;
  provenance_message_range: string | null;
  provenance_tool_call_ids: string | null;
  last_accessed_at: number | null;
  access_count: number;
  epistemic_confidence: number;
  epistemic_evidence_count: number;
  evicted_at: number | null;
  suspended: number;
  suspended_reason: string | null;
  suspended_at: number | null;
  stability: number;
  next_review_at: number | null;
}

interface ProfileRow {
  id: string;
  user_id: string;
  profile_data: string;
  version: number;
  created_at: number;
  last_analyzed_at: number;
  total_prompts_analyzed: number;
}

interface PromptRow {
  id: string;
  session_id: string;
  message_id: string;
  content: string;
  directory: string | null;
  is_captured: number;
  is_user_learning_captured: number;
  linked_memory_id: string | null;
  created_at: number;
}

// -- Singleton ---------------------------------------------------------------

let _db: Database | null = null;

const DEFAULT_DB_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode-flashback",
  "flashback.db",
);

export function getDb(dbPath?: string): Database {
  const logger = getLogger();
  if (_db) return _db;

  const path = dbPath ?? DEFAULT_DB_PATH;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const isNew = !existsSync(path);
  const db = new Database(path);

  if (isNew) {
    chmodSync(path, 0o600);
  }

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");

  runMigrations(db);

  logger.debug("getDb initialized", { path });
  _db = db;
  return db;
}

// -- Migrations --------------------------------------------------------------

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS memories (
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
);
CREATE INDEX IF NOT EXISTS idx_memories_container_tag ON memories(container_tag);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_is_pinned ON memories(is_pinned);
CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_evicted ON memories(evicted_at);
CREATE INDEX IF NOT EXISTS idx_memories_suspended ON memories(suspended);
CREATE INDEX IF NOT EXISTS idx_memories_next_review ON memories(next_review_at);
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  profile_data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_analyzed_at INTEGER NOT NULL,
  total_prompts_analyzed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_profile_changelogs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  change_summary TEXT NOT NULL,
  profile_data_snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE
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
CREATE INDEX IF NOT EXISTS idx_prompts_session ON user_prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_prompts_captured ON user_prompts(is_captured);
CREATE INDEX IF NOT EXISTS idx_prompts_created ON user_prompts(created_at DESC);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`,
  },
];

function runMigrations(db: Database): void {
  let currentVersion = 0;
  try {
    const row = db
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | null;
    if (row) currentVersion = parseInt(row.value, 10);
  } catch {
    // meta table doesn't exist yet -- version is 0
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    db.exec(migration.sql);
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(migration.version),
    );
  }
}

// -- Helpers -----------------------------------------------------------------

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToMemory(row: MemoryRow): Memory {
  const bytes = new Uint8Array(row.embedding);
  return {
    id: row.id,
    content: row.content,
    embedding: new Float32Array(bytes.buffer),
    containerTag: row.container_tag,
    tags: parseJson<string[]>(row.tags, []),
    type: row.type ?? "",
    isPinned: row.is_pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, string | number | boolean | null>>(
      row.metadata,
      {},
    ),
    displayName: row.display_name ?? "",
    userName: row.user_name ?? "",
    userEmail: row.user_email ?? "",
    projectPath: row.project_path ?? "",
    projectName: row.project_name ?? "",
    gitRepoUrl: row.git_repo_url ?? "",
    sourceFile: row.source_file ?? undefined,
    sourceLine: row.source_line ?? undefined,
    provenance: {
      sessionId: row.provenance_session_id ?? "",
      messageRange: parseJson<[number, number]>(
        row.provenance_message_range,
        [0, 0],
      ),
      toolCallIds: parseJson<string[]>(row.provenance_tool_call_ids, []),
    },
    lastAccessedAt: row.last_accessed_at ?? row.created_at,
    accessCount: row.access_count,
    epistemicStatus: {
      confidence: row.epistemic_confidence,
      evidenceCount: row.epistemic_evidence_count,
    },
    evictedAt: row.evicted_at,
    suspended: row.suspended === 1,
    suspendedReason: row.suspended_reason,
    suspendedAt: row.suspended_at,
    stability: row.stability,
    nextReviewAt: row.next_review_at,
  };
}

function rowToProfile(row: ProfileRow): UserProfile {
  return {
    id: row.id,
    userId: row.user_id,
    profileData: parseJson<UserProfile["profileData"]>(row.profile_data, {
      preferences: {},
      patterns: {},
      workflows: {},
    }),
    version: row.version,
    createdAt: row.created_at,
    lastAnalyzedAt: row.last_analyzed_at,
    totalPromptsAnalyzed: row.total_prompts_analyzed,
  };
}

function rowToPrompt(row: PromptRow): UserPrompt {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    content: row.content,
    directory: row.directory ?? "",
    isCaptured: row.is_captured === 1,
    isUserLearningCaptured: row.is_user_learning_captured === 1,
    linkedMemoryId: row.linked_memory_id ?? undefined,
  };
}

// -- CRUD: memories ----------------------------------------------------------

const MEMORY_INSERT_SQL = `INSERT OR REPLACE INTO memories (
  id, content, embedding, container_tag, tags, type, is_pinned,
  created_at, updated_at, metadata, display_name, user_name, user_email,
  project_path, project_name, git_repo_url, source_file, source_line,
  provenance_session_id, provenance_message_range, provenance_tool_call_ids,
  last_accessed_at, access_count, epistemic_confidence, epistemic_evidence_count,
  evicted_at, suspended, suspended_reason, suspended_at, stability, next_review_at
) VALUES (
  ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?
)`;

export function insertMemory(db: Database, memory: Memory): void {
  const logger = getLogger();
  logger.debug("insertMemory start", { id: memory.id });
  db.query(MEMORY_INSERT_SQL).run(
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
    JSON.stringify(memory.metadata),
    memory.displayName,
    memory.userName,
    memory.userEmail,
    memory.projectPath,
    memory.projectName,
    memory.gitRepoUrl,
    memory.sourceFile ?? null,
    memory.sourceLine ?? null,
    memory.provenance.sessionId,
    JSON.stringify(memory.provenance.messageRange),
    JSON.stringify(memory.provenance.toolCallIds),
    memory.lastAccessedAt,
    memory.accessCount,
    memory.epistemicStatus.confidence,
    memory.epistemicStatus.evidenceCount,
    memory.evictedAt,
    memory.suspended ? 1 : 0,
    memory.suspendedReason,
    memory.suspendedAt,
    memory.stability,
    memory.nextReviewAt,
  );
}

export function getMemory(db: Database, id: string): Memory | null {
  const row = db
    .query("SELECT * FROM memories WHERE id = ?")
    .get(id) as MemoryRow | null;
  return row ? rowToMemory(row) : null;
}

export function deleteMemory(db: Database, id: string): void {
  const logger = getLogger();
  logger.debug("deleteMemory start", { id });
  db.query("DELETE FROM memories WHERE id = ?").run(id);
}

export function listMemories(
  db: Database,
  containerTag: string,
  limit: number,
  offset: number,
): Memory[] {
  const rows = db
    .query(
      "SELECT * FROM memories WHERE container_tag = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
    .all(containerTag, limit, offset) as MemoryRow[];
  return rows.map(rowToMemory);
}

export function searchMemoriesByText(
  db: Database,
  query: string,
  containerTag: string,
  limit: number,
): Memory[] {
  const rows = db
    .query(
      "SELECT * FROM memories WHERE content LIKE ? AND container_tag = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(`%${query}%`, containerTag, limit) as MemoryRow[];
  return rows.map(rowToMemory);
}

export function countMemories(db: Database, containerTag: string): number {
  const row = db
    .query("SELECT COUNT(*) as count FROM memories WHERE container_tag = ?")
    .get(containerTag) as { count: number };
  return row.count;
}

export function getAllActiveMemories(db: Database): Memory[] {
  const rows = db
    .query("SELECT * FROM memories WHERE evicted_at IS NULL AND suspended = 0")
    .all() as MemoryRow[];
  return rows.map(rowToMemory);
}

// -- CRUD: profiles ----------------------------------------------------------

export function insertProfile(db: Database, profile: UserProfile): void {
  db.query(
    `INSERT OR REPLACE INTO user_profiles (
      id, user_id, profile_data, version, created_at, last_analyzed_at, total_prompts_analyzed
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    profile.id,
    profile.userId,
    JSON.stringify(profile.profileData),
    profile.version,
    profile.createdAt,
    profile.lastAnalyzedAt,
    profile.totalPromptsAnalyzed,
  );
}

export function getProfile(db: Database, userId: string): UserProfile | null {
  const row = db
    .query("SELECT * FROM user_profiles WHERE user_id = ?")
    .get(userId) as ProfileRow | null;
  return row ? rowToProfile(row) : null;
}

export function updateProfile(db: Database, profile: UserProfile): void {
  db.query(
    `UPDATE user_profiles SET
      profile_data = ?, version = ?, last_analyzed_at = ?, total_prompts_analyzed = ?
    WHERE id = ?`,
  ).run(
    JSON.stringify(profile.profileData),
    profile.version,
    profile.lastAnalyzedAt,
    profile.totalPromptsAnalyzed,
    profile.id,
  );
}

// -- CRUD: prompts -----------------------------------------------------------

export function insertPrompt(db: Database, prompt: UserPrompt): void {
  db.query(
    `INSERT INTO user_prompts (
      id, session_id, message_id, content, directory,
      is_captured, is_user_learning_captured, linked_memory_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    prompt.id,
    prompt.sessionId,
    prompt.messageId,
    prompt.content,
    prompt.directory,
    prompt.isCaptured ? 1 : 0,
    prompt.isUserLearningCaptured ? 1 : 0,
    prompt.linkedMemoryId ?? null,
    Date.now(),
  );
}

export function markPromptCaptured(db: Database, promptId: string): void {
  db.query("UPDATE user_prompts SET is_captured = 1 WHERE id = ?").run(
    promptId,
  );
}

// -- Lifecycle ---------------------------------------------------------------

export function closeDb(): void {
  const logger = getLogger();
  if (!_db) return;
  _db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  _db.close();
  _db = null;
  logger.debug("closeDb completed");
}

export function _setDbForTesting(db: Database): void {
  _db = db;
}
