import type { Orama } from "@orama/orama";
import { create, insert, search } from "@orama/orama";
import { getConfig, getHybridWeights } from "./config.ts";
import { getEmbeddingDimension } from "./core/ai/embed.ts";
import {
  countSearchMemoriesByText,
  getAllActiveMemories,
  getDb,
  getMemoriesByIds,
  getMetaValue,
  getRevision,
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
    offset?: number,
  ) => Promise<{ results: SearchResult[]; totalCount: number }>;
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
  offset = 0,
): Promise<{ results: SearchResult[]; totalCount: number }> {
  return deps.hybridSearch(query, queryVector, containerTag, limit, offset);
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
let loadedRevision = -1;
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
  let caught: unknown;
  // biome-ignore format: keep single line for regression audit invariant
  rebuildPromise = rebuildPromise.then(() => doRebuild()).catch((err) => { caught = err; });
  await rebuildPromise;
  if (caught) throw caught;
}

async function doRebuild(): Promise<void> {
  const logger = getLogger();
  const start = Date.now();
  try {
    // Recreate to guarantee a clean index
    oramaDb = create({ schema: createSchema(resolveEmbeddingDimension()) });
    isStale = false;

    const db = getDb();
    const dbRevision = getRevision(db);
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
    loadedRevision = dbRevision;
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
  offset = 0,
): Promise<{ results: SearchResult[]; totalCount: number }> {
  const logger = getLogger();
  try {
    if (!oramaDb) {
      await deps.initSearch();
    }

    const db = getDb();
    const dbRevision = getRevision(db);

    if (isStale || dbRevision > loadedRevision) {
      await deps.rebuildIndex();
      loadedRevision = dbRevision;
      state = "ready";
    }

    const config = getConfig();
    const weights = getHybridWeights(config);

    const effectiveOffset = Math.max(0, offset);
    const fetchLimit = limit + effectiveOffset;

    const results = search(oramaDb!, {
      mode: "hybrid",
      term: query,
      vector: { value: queryVector, property: "embedding" },
      where: { containerTag: { eq: containerTag } },
      similarity: 0.3,
      limit: fetchLimit,
      hybridWeights: { text: weights.keyword, vector: weights.semantic },
    });

    // Orama search may be sync or async depending on hooks
    const resolved = results instanceof Promise ? await results : results;

    if (resolved.count === 0) {
      logger.debug("hybridSearch completed", { query, resultCount: 0 });
      return { results: [], totalCount: 0 };
    }

    const searchResults: SearchResult[] = [];

    const memoryIds = resolved.hits.map(
      (hit) => (hit.document as SearchDoc).memoryId,
    );
    const memoriesById = new Map(
      getMemoriesByIds(db, memoryIds).map((m) => [m.id, m]),
    );

    for (const hit of resolved.hits) {
      const doc = hit.document as SearchDoc;
      const memory = memoriesById.get(doc.memoryId);
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
      totalCount: resolved.count,
    });
    const pagedResults = searchResults.slice(
      effectiveOffset,
      effectiveOffset + limit,
    );
    return { results: pagedResults, totalCount: resolved.count };
  } catch (_error: unknown) {
    state = "degraded";
    const reason = _error instanceof Error ? _error.message : "unknown error";
    logger.warn("hybridSearch degraded", { reason, query, containerTag });

    // Fallback to SQLite text search
    const db = getDb();
    const fallback = searchMemoriesByText(
      db,
      query,
      containerTag,
      limit,
      offset,
    );
    const totalCount = countSearchMemoriesByText(db, query, containerTag);
    const results = fallback.map((memory) => ({
      memory,
      score: 0,
      _debug: { fallback: true, oramaScore: 0, reason },
    }));
    logger.debug("hybridSearch completed", {
      query,
      resultCount: results.length,
      totalCount,
    });
    return { results, totalCount };
  }
}

// -- Stale / State -----------------------------------------------------------

function markStaleImpl(): void {
  isStale = true;
}

function getSearchStateImpl(): SubsystemState {
  return state;
}
