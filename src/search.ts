import type { Orama } from "@orama/orama";
import { create, insert, search } from "@orama/orama";
import { getConfig, getHybridWeights } from "./config.ts";
import { getEmbeddingDimension } from "./core/ai/embed.ts";
import {
  getAllActiveMemories,
  getDb,
  getMemory,
  getMetaValue,
  META_KEY_EMBEDDING_DIMENSION,
  searchMemoriesByText,
} from "./db/database.ts";
import type { SearchResult, SubsystemState } from "./types.ts";
import { getLogger } from "./util/logger.ts";

// -- DI Hooks ----------------------------------------------------------------

interface SearchDeps {
  initSearch: () => Promise<void>;
  hybridSearch: (
    query: string,
    queryVector: number[],
    containerTag: string,
    limit: number,
  ) => Promise<SearchResult[]>;
  markStale: () => void;
  rebuildIndex: () => Promise<void>;
  getSearchState: () => SubsystemState;
}

const defaultDeps: SearchDeps = {
  initSearch: initSearchImpl,
  hybridSearch: hybridSearchImpl,
  markStale: markStaleImpl,
  rebuildIndex: rebuildIndexImpl,
  getSearchState: getSearchStateImpl,
};

let deps: SearchDeps = { ...defaultDeps };

export function _setSearchDepsForTesting(overrides: Partial<SearchDeps>): void {
  deps = { ...deps, ...overrides };
}

export function _resetSearchDepsForTesting(): void {
  deps = { ...defaultDeps };
}

// -- Wrapper Exports (delegate to deps) ----------------------------------------

export async function initSearch(): Promise<void> {
  return deps.initSearch();
}

export async function rebuildIndex(): Promise<void> {
  return deps.rebuildIndex();
}

export async function hybridSearch(
  query: string,
  queryVector: number[],
  containerTag: string,
  limit: number,
): Promise<SearchResult[]> {
  return deps.hybridSearch(query, queryVector, containerTag, limit);
}

export function markStale(): void {
  deps.markStale();
}

export function getSearchState(): SubsystemState {
  return deps.getSearchState();
}

// -- Schema ------------------------------------------------------------------

const DEFAULT_EMBEDDING_DIMENSION = 768;

function resolveEmbeddingDimension(): number {
  const detected = getEmbeddingDimension();
  if (detected !== null) return detected;
  const stored = getMetaValue(getDb(), META_KEY_EMBEDDING_DIMENSION);
  if (stored !== null) {
    const parsed = parseInt(stored, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_EMBEDDING_DIMENSION;
}

function createSchema(dimension: number) {
  return {
    memoryId: "string",
    content: "string",
    tags: "string",
    containerTag: "enum",
    isStarred: "boolean",
    embedding: `vector[${dimension}]`,
  } as const;
}

type SearchDoc = {
  memoryId: string;
  content: string;
  tags: string;
  containerTag: string;
  isStarred: boolean;
  embedding: number[];
};

// -- State -------------------------------------------------------------------

let state: SubsystemState = "uninitialized";
let oramaDb: Orama<ReturnType<typeof createSchema>> | null = null;
let isStale = false;
let rebuildPromise: Promise<void> = Promise.resolve();

// -- Init / Rebuild ----------------------------------------------------------

async function initSearchImpl(): Promise<void> {
  const logger = getLogger();
  if (oramaDb) return;

  try {
    const previousState = state;
    state = "initializing";
    logger.debug("initSearch state transition", {
      from: previousState,
      to: state,
    });
    oramaDb = create({ schema: createSchema(resolveEmbeddingDimension()) });
    await deps.rebuildIndex();
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

async function rebuildIndexImpl(): Promise<void> {
  // biome-ignore format: keep single line for regression audit invariant
  rebuildPromise = rebuildPromise.then(() => doRebuild())
    .catch(() => {
      // serialization catch -- individual errors handled inside doRebuild
    });
  return rebuildPromise;
}

async function doRebuild(): Promise<void> {
  const logger = getLogger();
  const start = Date.now();
  try {
    // Recreate to guarantee a clean index
    oramaDb = create({ schema: createSchema(resolveEmbeddingDimension()) });
    isStale = false;

    const db = getDb();
    const memories = getAllActiveMemories(db);

    for (const memory of memories) {
      const doc: SearchDoc = {
        memoryId: memory.id,
        content: memory.content,
        tags: memory.tags.join(", "),
        containerTag: memory.containerTag,
        isStarred: memory.isStarred,
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

async function hybridSearchImpl(
  query: string,
  queryVector: number[],
  containerTag: string,
  limit: number,
): Promise<SearchResult[]> {
  const logger = getLogger();
  try {
    if (!oramaDb) {
      await deps.initSearch();
    }

    if (isStale) {
      await deps.rebuildIndex();
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
  } catch (_error: unknown) {
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

function markStaleImpl(): void {
  isStale = true;
}

function getSearchStateImpl(): SubsystemState {
  return state;
}
