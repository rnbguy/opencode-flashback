import {
  getAllActiveMemories,
  getDb,
  getMemory,
  insertMemory,
} from "../db/database.ts";
import { getConfig } from "../config.ts";
import { markStale } from "../search.ts";
import type { ConsolidationCandidate, Memory } from "../types.ts";
import { getLogger } from "../util/logger.ts";
import { embed } from "./ai/embed.ts";
import { cosineSimilarity } from "./memory.ts";

const DUPLICATE_THRESHOLD = 0.92;
const NEAR_DUPLICATE_THRESHOLD = 0.85;
const CONSOLIDATION_CAP = 500;

export interface ConsolidateOptions {
  containerTag: string;
  dryRun: boolean;
}

export interface ConsolidateResult {
  candidates: ConsolidationCandidate[];
  merged: number;
}

class UnionFind {
  private parent: Map<string, string> = new Map();
  private rank: Map<string, number> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)!));
    }
    return this.parent.get(x)!;
  }

  union(x: string, y: string): void {
    const px = this.find(x);
    const py = this.find(y);
    if (px === py) return;
    const rx = this.rank.get(px) ?? 0;
    const ry = this.rank.get(py) ?? 0;
    if (rx < ry) {
      this.parent.set(px, py);
    } else if (rx > ry) {
      this.parent.set(py, px);
    } else {
      this.parent.set(py, px);
      this.rank.set(px, rx + 1);
    }
  }

  groups(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      if (!result.has(root)) result.set(root, []);
      result.get(root)!.push(key);
    }
    return result;
  }
}

function chooseSurvivor(memories: Memory[]): Memory {
  return [...memories].sort((a, b) => {
    if (a.epistemicStatus.confidence !== b.epistemicStatus.confidence) {
      return b.epistemicStatus.confidence - a.epistemicStatus.confidence;
    }
    if (a.accessCount !== b.accessCount) {
      return b.accessCount - a.accessCount;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return a.id.localeCompare(b.id);
  })[0];
}

function buildCandidate(memories: Memory[]): ConsolidationCandidate {
  const survivor = chooseSurvivor(memories);
  const survivorEmbedding = Array.from(survivor.embedding);
  let groupSimilarity = 1;

  for (const memory of memories) {
    const similarity = cosineSimilarity(
      survivorEmbedding,
      Array.from(memory.embedding),
    );
    groupSimilarity = Math.min(groupSimilarity, similarity);
  }

  const reason =
    groupSimilarity >= DUPLICATE_THRESHOLD ? "duplicate" : "near-duplicate";
  const unionTags = [
    ...new Set(memories.flatMap((memory) => memory.tags)),
  ].sort((a, b) => a.localeCompare(b));
  const confidence = survivor.epistemicStatus.confidence.toFixed(2);

  return {
    memoryIds: memories
      .map((memory) => memory.id)
      .sort((a, b) => a.localeCompare(b)),
    reason,
    similarity: groupSimilarity,
    suggestion: `Keep ${survivor.id} (confidence: ${confidence}). Merge ${memories.length - 1} duplicates. Tags: ${unionTags.join(", ")}`,
  };
}

export async function consolidateMemories(
  opts: ConsolidateOptions,
): Promise<ConsolidateResult> {
  const logger = getLogger();
  const db = getDb();
  const config = getConfig();
  const maxCandidates = config.consolidation?.maxCandidates ?? 500;
  const memories = getAllActiveMemories(db).filter(
    (memory) =>
      memory.containerTag === opts.containerTag && memory.evictedAt === null,
  );

  if (memories.length < 2) {
    return { candidates: [], merged: 0 };
  }

  let pool = memories;
  if (pool.length > maxCandidates) {
    logger.warn("consolidateMemories capped input", {
      total: pool.length,
      cap: maxCandidates,
    });
    pool = [...pool]
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, maxCandidates);
  }

  const uf = new UnionFind();
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    const aEmbedding = Array.from(a.embedding);
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j];
      const similarity = cosineSimilarity(aEmbedding, Array.from(b.embedding));
      if (similarity >= NEAR_DUPLICATE_THRESHOLD) {
        uf.union(a.id, b.id);
      }
    }
  }

  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const candidates = [...uf.groups().values()]
    .filter((group) => group.length >= 2)
    .map((group) =>
      group
        .map((id) => byId.get(id))
        .filter((memory): memory is Memory => memory !== undefined),
    )
    .filter((group) => group.length >= 2)
    .map((group) => buildCandidate(group))
    .sort((a, b) => b.similarity - a.similarity);

  if (opts.dryRun) {
    return { candidates, merged: 0 };
  }

  const merged = await applyConsolidation(candidates);
  logger.info("consolidateMemories merged candidates", {
    containerTag: opts.containerTag,
    candidateCount: candidates.length,
    merged,
  });
  return { candidates, merged };
}

export async function applyConsolidation(
  candidates: ConsolidationCandidate[],
): Promise<number> {
  const db = getDb();
  const logger = getLogger();
  let merged = 0;

  for (const candidate of candidates) {
    let transactionStarted = false;

    try {
      const memories = candidate.memoryIds
        .map((id) => getMemory(db, id))
        .filter(
          (memory): memory is Memory =>
            memory !== null && memory.evictedAt === null,
        );

      if (memories.length < 2) {
        continue;
      }

      const survivor = chooseSurvivor(memories);
      const losers = memories.filter((memory) => memory.id !== survivor.id);
      const tags = [...new Set(memories.flatMap((memory) => memory.tags))].sort(
        (a, b) => a.localeCompare(b),
      );
      const maxConfidence = Math.max(
        ...memories.map((memory) => memory.epistemicStatus.confidence),
      );
      const maxAccessCount = Math.max(
        ...memories.map((memory) => memory.accessCount),
      );
      const earliestCreatedAt = Math.min(
        ...memories.map((memory) => memory.createdAt),
      );
      const now = Date.now();

      const vectors = await embed([survivor.content], "document");
      const updated: Memory = {
        ...survivor,
        tags,
        metadata: {
          ...survivor.metadata,
          mergedFromCount: memories.length - 1,
        },
        accessCount: maxAccessCount,
        createdAt: earliestCreatedAt,
        updatedAt: now,
        epistemicStatus: {
          ...survivor.epistemicStatus,
          confidence: maxConfidence,
        },
        embedding: new Float32Array(vectors[0]),
      };

      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      insertMemory(db, updated);
      for (const loser of losers) {
        db.query("UPDATE memories SET evicted_at = ? WHERE id = ?").run(
          now,
          loser.id,
        );
      }
      markStale();
      db.exec("COMMIT");
      transactionStarted = false;
      merged += losers.length;
    } catch (error) {
      if (transactionStarted) {
        try {
          db.exec("ROLLBACK");
        } catch {
          logger.warn("applyConsolidation rollback failed", {
            memoryIds: candidate.memoryIds,
          });
        }
      }
      logger.warn("applyConsolidation group failed", {
        memoryIds: candidate.memoryIds,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return merged;
}
