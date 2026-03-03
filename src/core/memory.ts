import {
  countMemories,
  deleteMemory,
  getAllActiveMemories,
  getDb,
  getMemory,
  insertMemory,
  listMemories as dbListMemories,
  searchMemoriesByText,
} from "../db/database.ts";
import { embed } from "../embed/embedder.ts";
import { getConfig, getHybridWeights, type PluginConfig } from "../config.ts";
import { hybridSearch, initSearch, markStale } from "../search/index.ts";
import { resolveContainerTag } from "./tags.ts";
import type { ContainerTagInfo, Memory, SearchResult } from "../types.ts";
import { MEMORY_HEADER } from "../consts.ts";
import { getLogger } from "../util/logger.ts";

const DEDUP_SIMILARITY_THRESHOLD = 0.9;
const DEFAULT_IMPORTANCE = 5;
const TAG_BUDGET = 500;
const EVICTION_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface AddMemoryOptions {
  content: string;
  containerTag: string;
  tags?: string[];
  type?: string;
  isPinned?: boolean;
  importance?: number;
  provenance?: Memory["provenance"];
  epistemicStatus?: Memory["epistemicStatus"];
  metadata?: Record<string, string | number | boolean | null>;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  sourceFile?: string;
  sourceLine?: number;
}

export async function addMemory(
  opts: AddMemoryOptions,
): Promise<{ id: string; deduplicated: boolean }> {
  const logger = getLogger();
  logger.debug("addMemory start", {
    contentLength: opts.content.length,
    containerTag: opts.containerTag,
    tags: opts.tags ?? [],
  });
  const db = getDb();

  const content = opts.content.trim();

  const vectors = await embed([content], "document");
  const vector = vectors[0];

  const duplicate = findDuplicateMemory(opts.containerTag, vector);
  if (duplicate) {
    return { id: duplicate.id, deduplicated: true };
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const importance = clampImportance(opts.importance);
  const metadata = {
    ...(opts.metadata ?? {}),
    importance,
  };

  let resolvedTagInfo: ContainerTagInfo | null = null;
  if (opts.projectPath) {
    try {
      resolvedTagInfo = resolveContainerTag(opts.projectPath);
    } catch {
      // resolveContainerTag fails in non-git directories -- treat as untagged
      resolvedTagInfo = null;
      resolvedTagInfo = null;
    }
  }

  const memory: Memory = {
    id,
    content,
    embedding: new Float32Array(vector),
    containerTag: opts.containerTag,
    tags: opts.tags ?? [],
    type: opts.type ?? "note",
    isPinned: opts.isPinned ?? false,
    createdAt: now,
    updatedAt: now,
    metadata,
    displayName: opts.displayName ?? resolvedTagInfo?.displayName ?? "",
    userName: opts.userName ?? resolvedTagInfo?.userName ?? "",
    userEmail: opts.userEmail ?? resolvedTagInfo?.userEmail ?? "",
    projectPath: opts.projectPath ?? resolvedTagInfo?.projectPath ?? "",
    projectName: opts.projectName ?? resolvedTagInfo?.projectName ?? "",
    gitRepoUrl: opts.gitRepoUrl ?? resolvedTagInfo?.gitRepoUrl ?? "",
    sourceFile: opts.sourceFile,
    sourceLine: opts.sourceLine,
    provenance: opts.provenance ?? {
      sessionId: "",
      messageRange: [0, 0],
      toolCallIds: [],
    },
    lastAccessedAt: now,
    accessCount: 0,
    epistemicStatus: opts.epistemicStatus ?? {
      confidence: 0.7,
      evidenceCount: 1,
    },
    evictedAt: null,
    suspended: false,
    suspendedReason: null,
    suspendedAt: null,
    stability: 0,
    nextReviewAt: null,
  };

  insertMemory(db, memory);
  markStale();
  await enforceTagBudget(opts.containerTag);

  return { id, deduplicated: false };
}

export async function searchMemories(
  query: string,
  containerTag: string,
  limit?: number,
): Promise<SearchResult[]> {
  const logger = getLogger();
  const db = getDb();
  const config = getConfig();
  const maxResults = limit ?? config.memory.maxResults;
  const hybridWeights = getHybridWeights(config);
  void hybridWeights;

  try {
    await initSearch();
  } catch {
    logger.warn("searchMemories initSearch failed", { containerTag });
    // Search init failure is non-fatal -- text fallback used below
  }

  try {
    const vectors = await embed([query], "query");
    const vector = vectors[0];
    const results = await hybridSearch(query, vector, containerTag, maxResults);
    const ranked = rerank(results, config);
    trackAccess(ranked);
    logger.debug("searchMemories completed", {
      query,
      containerTag,
      resultCount: ranked.length,
    });
    return ranked;
  } catch {
    // hybrid search failed -- fall back to text-only search below
    logger.warn("searchMemories using text fallback", { query, containerTag });
    logger.warn("searchMemories using text fallback", { query, containerTag });
    const fallback = searchMemoriesByText(db, query, containerTag, maxResults);
    const ranked = rerank(
      fallback.map((memory) => ({
        memory,
        score: 0,
        _debug: { fallback: true },
      })),
      config,
    );
    trackAccess(ranked);
    logger.debug("searchMemories completed", {
      query,
      containerTag,
      resultCount: ranked.length,
    });
    return ranked;
  }
}

export async function recallMemories(
  sessionMessages: string[],
  containerTag: string,
  limit?: number,
): Promise<SearchResult[]> {
  const logger = getLogger();
  const query = sessionMessages
    .slice(-10)
    .map((message) => message.slice(0, 500))
    .join("\n");

  if (query.trim().length === 0) {
    logger.debug("recallMemories completed", { containerTag, resultCount: 0 });
    return [];
  }

  const results = await searchMemories(query, containerTag, limit);
  logger.debug("recallMemories completed", {
    containerTag,
    resultCount: results.length,
  });
  return results;
}

export async function forgetMemory(id: string): Promise<void> {
  const logger = getLogger();
  logger.debug("forgetMemory start", { id });
  const db = getDb();
  deleteMemory(db, id);
  markStale();
}

export async function listMemoriesPage(
  containerTag: string,
  limit: number,
  offset: number,
): Promise<{ memories: Memory[]; total: number }> {
  const db = getDb();
  const memories = dbListMemories(db, containerTag, limit, offset);
  const total = countMemories(db, containerTag);
  return { memories, total };
}

export async function listMemories(
  containerTag: string,
  limit = 50,
  offset = 0,
): Promise<{ memories: Memory[]; total: number }> {
  const logger = getLogger();
  const page = await listMemoriesPage(containerTag, limit, offset);
  logger.debug("listMemories completed", {
    containerTag,
    limit,
    offset,
    total: page.total,
  });
  return page;
}

export async function getContext(
  containerTag: string,
  sessionId?: string,
): Promise<string> {
  const logger = getLogger();
  const db = getDb();
  const config = getConfig();
  const topMemories = dbListMemories(db, containerTag, 5, 0).filter(
    (memory) => memory.evictedAt === null,
  );

  if (topMemories.length === 0) {
    logger.debug("getContext completed", { containerTag, contextLength: 0 });
    return "";
  }

  const profileRow = db
    .query(
      "SELECT profile_data FROM user_profiles ORDER BY last_analyzed_at DESC LIMIT 1",
    )
    .get() as { profile_data: string } | null;

  const preferenceLines = parsePreferenceLines(
    profileRow?.profile_data ?? null,
  );
  const memoryLines = topMemories.map((result) => {
    const summary = summarizeContent(result.content, 180);
    const confidencePct = Math.round(result.epistemicStatus.confidence * 100);
    return `- [${confidencePct}%] ${summary}`;
  });

  const metadataSessionSuffix = sessionId ? ` (session ${sessionId})` : "";

  const lines = [MEMORY_HEADER, "", "User Preferences:"];
  if (preferenceLines.length === 0) {
    lines.push("- none");
  } else {
    lines.push(...preferenceLines);
  }

  lines.push("", `Project Knowledge:${metadataSessionSuffix}`);
  lines.push(...memoryLines);

  if (config.memory.maxResults <= 0) {
    logger.debug("getContext completed", { containerTag, contextLength: 0 });
    return "";
  }

  const context = lines.join("\n");
  logger.debug("getContext completed", {
    containerTag,
    contextLength: context.length,
  });
  return context;
}

export async function getMemoryById(id: string): Promise<Memory | null> {
  const logger = getLogger();
  const db = getDb();
  const memory = getMemory(db, id);
  logger.debug("getMemoryById completed", { id, found: memory !== null });
  return memory;
}

export async function exportMemories(
  containerTag: string,
  format: "json" | "markdown",
): Promise<{ data: string; count: number }> {
  const logger = getLogger();
  const db = getDb();
  const all = getAllActiveMemories(db).filter(
    (memory) =>
      memory.containerTag === containerTag && memory.evictedAt === null,
  );

  if (format === "markdown") {
    const data = all
      .map((memory) => {
        const tags =
          memory.tags.length > 0 ? `\nTags: ${memory.tags.join(", ")}` : "";
        return `## ${memory.type || "note"}\n\n${memory.content}${tags}\n\nCreated: ${new Date(memory.createdAt).toISOString()}`;
      })
      .join("\n\n---\n\n");
    logger.debug("exportMemories completed", {
      containerTag,
      format,
      count: all.length,
    });
    return { data, count: all.length };
  }

  logger.debug("exportMemories completed", {
    containerTag,
    format,
    count: all.length,
  });
  return {
    data: JSON.stringify(
      all.map((memory) => ({
        id: memory.id,
        content: memory.content,
        type: memory.type,
        tags: memory.tags,
        createdAt: memory.createdAt,
        containerTag: memory.containerTag,
      })),
      null,
      2,
    ),
    count: all.length,
  };
}

export async function findRelatedMemories(
  query: string,
  containerTag: string,
  limit?: number,
): Promise<SearchResult[]> {
  const logger = getLogger();
  const results = await searchMemories(query, containerTag, limit);
  logger.debug("findRelatedMemories completed", {
    query,
    resultCount: results.length,
  });
  return results;
}

export async function suspendMemory(
  id: string,
  reason: string | null,
): Promise<boolean> {
  const logger = getLogger();
  const db = getDb();
  const memory = getMemory(db, id);
  if (!memory) {
    logger.debug("suspendMemory completed", { id, success: false });
    return false;
  }

  db.query(
    "UPDATE memories SET suspended = 1, suspended_reason = ?, suspended_at = ? WHERE id = ?",
  ).run(reason, Date.now(), id);
  logger.debug("suspendMemory completed", { id, success: true });
  return true;
}

export async function getMemoriesForReview(
  containerTag: string,
  limit?: number,
): Promise<Memory[]> {
  const logger = getLogger();
  const db = getDb();
  const now = Date.now();
  const memories = getAllActiveMemories(db).filter(
    (memory) =>
      memory.containerTag === containerTag &&
      memory.evictedAt === null &&
      !memory.suspended &&
      memory.nextReviewAt !== null &&
      memory.nextReviewAt <= now,
  );

  const results = memories
    .sort((a, b) => (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0))
    .slice(0, limit ?? 10);
  logger.debug("getMemoriesForReview completed", {
    containerTag,
    count: results.length,
  });
  return results;
}

function getRankingWeights(config: PluginConfig): {
  recency: number;
  importance: number;
  semantic: number;
} {
  const quality = config.search.retrievalQuality;
  switch (quality) {
    case "fast":
      return { recency: 0.5, importance: 0.2, semantic: 0.3 };
    case "balanced":
      return { recency: 0.3, importance: 0.4, semantic: 0.3 };
    case "thorough":
      return { recency: 0.2, importance: 0.3, semantic: 0.5 };
    case "custom":
      return (
        config.search.rankingWeights ?? {
          recency: 0.3,
          importance: 0.4,
          semantic: 0.3,
        }
      );
    default:
      return { recency: 0.3, importance: 0.4, semantic: 0.3 };
  }
}

function rerank(results: SearchResult[], config: PluginConfig): SearchResult[] {
  const weights = getRankingWeights(config);
  const now = Date.now();

  return results
    .map((result, index) => {
      const rankScore = 1 / (1 + index);
      const importanceRaw = result.memory.metadata.importance;
      const importance =
        typeof importanceRaw === "number"
          ? clampImportance(importanceRaw)
          : DEFAULT_IMPORTANCE;
      const importanceScore = Math.log(importance + 1);
      const daysSinceAccess = Math.max(
        0,
        (now - result.memory.lastAccessedAt) / DAY_MS,
      );

      const finalScore =
        weights.semantic * rankScore +
        weights.importance * importanceScore -
        weights.recency * daysSinceAccess;

      return {
        ...result,
        score: finalScore,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function findDuplicateMemory(
  containerTag: string,
  vector: number[],
): Memory | null {
  const db = getDb();
  const memories = getAllActiveMemories(db).filter(
    (memory) => memory.containerTag === containerTag,
  );

  let best: { memory: Memory; similarity: number } | null = null;

  for (const memory of memories) {
    const similarity = cosineSimilarity(vector, Array.from(memory.embedding));
    if (similarity <= DEDUP_SIMILARITY_THRESHOLD) {
      continue;
    }
    if (!best || similarity > best.similarity) {
      best = { memory, similarity };
    }
  }

  return best?.memory ?? null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

async function enforceTagBudget(containerTag: string): Promise<void> {
  const db = getDb();
  const active = getAllActiveMemories(db).filter(
    (memory) => memory.containerTag === containerTag,
  );

  if (active.length <= TAG_BUDGET) {
    return;
  }

  const excess = active.length - TAG_BUDGET;
  const nonPinned = active.filter((memory) => !memory.isPinned);

  if (nonPinned.length === 0) {
    return;
  }

  const now = Date.now();
  const graceCutoff = now - EVICTION_GRACE_DAYS * DAY_MS;
  const graceEligible = nonPinned.filter(
    (memory) => memory.createdAt <= graceCutoff,
  );
  const pool = graceEligible.length >= excess ? graceEligible : nonPinned;

  const evictable = pool
    .map((memory) => {
      const importanceRaw = memory.metadata.importance;
      const importance =
        typeof importanceRaw === "number"
          ? clampImportance(importanceRaw)
          : DEFAULT_IMPORTANCE;
      const daysSinceAccess = Math.max(
        0,
        (now - memory.lastAccessedAt) / DAY_MS,
      );
      const utility =
        (importance * (1 + Math.log(memory.accessCount + 1))) /
        (1 + daysSinceAccess);

      return { id: memory.id, utility };
    })
    .sort((a, b) => a.utility - b.utility)
    .slice(0, excess);

  if (evictable.length === 0) {
    return;
  }

  for (const candidate of evictable) {
    db.query("UPDATE memories SET evicted_at = ? WHERE id = ?").run(
      now,
      candidate.id,
    );
  }

  markStale();
}

function clampImportance(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_IMPORTANCE;
  }
  return Math.min(Math.max(Math.round(value), 1), 10);
}

function summarizeContent(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function parsePreferenceLines(profileDataRaw: string | null): string[] {
  if (!profileDataRaw) {
    return [];
  }

  try {
    const parsed = JSON.parse(profileDataRaw) as {
      preferences?: Record<string, string | number | boolean | null>;
    };
    const prefs = parsed.preferences ?? {};
    return Object.entries(prefs)
      .slice(0, 10)
      .map(([key, value]) => `- [${key}] ${String(value)}`);
  } catch {
    // JSON parse failed on preference data -- skip malformed entries
    return [];
  }

}

function trackAccess(results: SearchResult[]): void {
  if (results.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const stmt = db.query(
    "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?",
  );
  for (const result of results) {
    stmt.run(now, result.memory.id);
    result.memory.accessCount += 1;
    result.memory.lastAccessedAt = now;
  }
}
