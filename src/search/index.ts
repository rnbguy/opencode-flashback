import { create, insert, search } from "@orama/orama";
import type { Orama } from "@orama/orama";
import { getDb } from "../db/database.ts";
import {
  getAllActiveMemories,
  getMemory,
  searchMemoriesByText,
} from "../db/database.ts";
import { getConfig, getHybridWeights } from "../config.ts";
import type { Memory, SearchResult, SubsystemState } from "../types.ts";
import { getLogger } from "../util/logger.ts";

// -- Schema ------------------------------------------------------------------

const schema = {
  memoryId: "string",
  content: "string",
  tags: "string",
  containerTag: "enum",
  isPinned: "boolean",
  embedding: "vector[768]",
} as const;

type SearchDoc = {
  memoryId: string;
  content: string;
  tags: string;
  containerTag: string;
  isPinned: boolean;
  embedding: number[];
};

// -- State -------------------------------------------------------------------

let state: SubsystemState = "uninitialized";
let oramaDb: Orama<typeof schema> | null = null;
let isStale = false;

// -- Init / Rebuild ----------------------------------------------------------

export async function initSearch(): Promise<void> {
  const logger = getLogger();
  if (oramaDb) return;

  try {
    const previousState = state;
    state = "initializing";
    logger.debug("initSearch state transition", {
      from: previousState,
      to: state,
    });
    oramaDb = create({ schema });
    await rebuildIndex();
    const fromState = state;
    state = "ready";
    logger.debug("initSearch state transition", { from: fromState, to: state });
  } catch (error: unknown) {
    const fromState = state;
    state = "error";
    logger.error("initSearch failed", { from: fromState, to: state });
    throw error;
  }
}

export async function rebuildIndex(): Promise<void> {
  const logger = getLogger();
  const start = Date.now();
  try {
    // Recreate to guarantee a clean index
    oramaDb = create({ schema });
    isStale = false;

    const db = getDb();
    const memories = getAllActiveMemories(db);

    for (const memory of memories) {
      const doc: SearchDoc = {
        memoryId: memory.id,
        content: memory.content,
        tags: memory.tags.join(", "),
        containerTag: memory.containerTag,
        isPinned: memory.isPinned,
        embedding: Array.from(memory.embedding),
      };
      insert(oramaDb, doc);
    }
    logger.debug("rebuildIndex completed", {
      memoryCount: memories.length,
      durationMs: Date.now() - start,
    });
  } catch (error: unknown) {
    state = "error";
    logger.error("rebuildIndex failed", {
      durationMs: Date.now() - start,
    });
    throw error;
  }
}

// -- Search ------------------------------------------------------------------

export async function hybridSearch(
  query: string,
  queryVector: number[],
  containerTag: string,
  limit: number,
): Promise<SearchResult[]> {
  const logger = getLogger();
  try {
    if (!oramaDb) {
      await initSearch();
    }

    if (isStale) {
      await rebuildIndex();
      state = "ready";
    }

    const config = getConfig();
    const weights = getHybridWeights(config);

    const results = search(oramaDb!, {
      mode: "hybrid",
      term: query,
      vector: { value: queryVector, property: "embedding" },
      where: { containerTag: { eq: containerTag } },
      similarity: 0.3,
      limit,
      hybridWeights: { text: weights.keyword, vector: weights.semantic },
    });

    // Orama search may be sync or async depending on hooks
    const resolved = results instanceof Promise ? await results : results;

    if (resolved.count === 0) {
      logger.debug("hybridSearch completed", { query, resultCount: 0 });
      return [];
    }

    const db = getDb();
    const searchResults: SearchResult[] = [];

    for (const hit of resolved.hits) {
      const doc = hit.document as SearchDoc;
      const memory = getMemory(db, doc.memoryId);
      if (!memory) continue;

      searchResults.push({
        memory,
        score: hit.score,
        _debug: { oramaScore: hit.score },
      });
    }


    logger.debug("hybridSearch completed", {
      query,
      resultCount: searchResults.length,
    });
    return searchResults;
  } catch (error: unknown) {
    state = "degraded";
    logger.warn("hybridSearch degraded", { query });

    // Fallback to SQLite text search
    const db = getDb();
    const fallback = searchMemoriesByText(db, query, containerTag, limit);
    const results = fallback.map((memory) => ({
      memory,
      score: 0,
      _debug: { fallback: true, oramaScore: 0 },
    }));
    logger.debug("hybridSearch completed", {
      query,
      resultCount: results.length,
    });
    return results;
  }
}

// -- Stale / State -----------------------------------------------------------

export function markStale(): void {
  isStale = true;
}

export function getSearchState(): SubsystemState {
  return state;
}
