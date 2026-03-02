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
  if (oramaDb) return;

  try {
    state = "initializing";
    oramaDb = create({ schema });
    await rebuildIndex();
    state = "ready";
  } catch (error: unknown) {
    state = "error";
    throw error;
  }
}

export async function rebuildIndex(): Promise<void> {
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
  } catch (error: unknown) {
    state = "error";
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
    const resolved =
      results instanceof Promise ? await results : results;

    if (resolved.count === 0) {
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

    // Fire-and-forget access tracking
    const ids = searchResults.map((r) => r.memory.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      db.query(
        `UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id IN (${placeholders})`,
      ).run(Date.now(), ...ids);
    }

    return searchResults;
  } catch (error: unknown) {
    state = "degraded";

    // Fallback to SQLite text search
    const db = getDb();
    const fallback = searchMemoriesByText(db, query, containerTag, limit);
    return fallback.map((memory) => ({
      memory,
      score: 0,
      _debug: { fallback: true, oramaScore: 0 },
    }));
  }
}

// -- Stale / State -----------------------------------------------------------

export function markStale(): void {
  isStale = true;
}

export function getSearchState(): SubsystemState {
  return state;
}
