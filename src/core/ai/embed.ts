import { embedMany } from "ai";
import {
  CircuitState,
  ConsecutiveBreaker,
  circuitBreaker,
  handleAll,
  isBrokenCircuitError,
} from "cockatiel";
import { LRUCache } from "lru-cache";
import { getConfig } from "../../config";
import type { SubsystemState } from "../../types";
import { getLogger } from "../../util/logger.ts";
import { createEmbeddingProvider } from "./providers";

let embeddingDimension: number | null = null;
const CACHE_MAX_SIZE = 100;
const FAILURE_THRESHOLD = 3;
const DEGRADED_COOLDOWN_MS = 30_000;

const CIRCUIT_OPEN_MESSAGE = "Embedder circuit breaker is open";
const EMBED_DIMENSION_MISMATCH_PREFIX = "Unexpected embedding dimension: got ";
const EMBED_CONFIG_REQUIRED = "Embedding configuration is required";
const EMBED_FAILED_MESSAGE =
  "Embedding generation failed for one or more inputs";

interface EmbedDeps {
  embedMany: typeof embedMany;
  createEmbeddingProvider: typeof createEmbeddingProvider;
}

type EmbeddingModel = Parameters<typeof embedMany>[0]["model"];
type Mode = "query" | "document";

const defaultDeps: EmbedDeps = {
  embedMany,
  createEmbeddingProvider,
};

let deps: EmbedDeps = { ...defaultDeps };
let initialized = false;
let cache = new LRUCache<string, number[]>({ max: CACHE_MAX_SIZE });
let breaker = circuitBreaker(handleAll, {
  halfOpenAfter: DEGRADED_COOLDOWN_MS,
  breaker: new ConsecutiveBreaker(FAILURE_THRESHOLD),
});

function makeCacheKey(mode: Mode, text: string): string {
  return `${mode}:${text}`;
}

function toModelInput(mode: Mode, text: string): string {
  return mode === "query"
    ? `task: search result | query: ${text}`
    : `title: none | text: ${text}`;
}

function getEmbeddingModel(
  provider: Awaited<ReturnType<typeof createEmbeddingProvider>>,
  modelId: string,
): EmbeddingModel {
  if ("embedding" in provider) {
    return provider.embedding(modelId);
  }
  throw new Error("Embedding provider does not support embeddings");
}

function mapCircuitState(): SubsystemState {
  if (!initialized) {
    return "uninitialized";
  }
  switch (breaker.state) {
    case CircuitState.Closed:
      return "ready";
    case CircuitState.Open:
    case CircuitState.HalfOpen:
      return "degraded";
    case CircuitState.Isolated:
      return "error";
  }
}

export function getEmbedderState(): SubsystemState {
  return mapCircuitState();
}

export function resetEmbedder(): void {
  initialized = false;
  embeddingDimension = null;
  cache = new LRUCache<string, number[]>({ max: CACHE_MAX_SIZE });
  breaker = circuitBreaker(handleAll, {
    halfOpenAfter: DEGRADED_COOLDOWN_MS,
    breaker: new ConsecutiveBreaker(FAILURE_THRESHOLD),
  });
}

export function _setEmbedDepsForTesting(overrides: Partial<EmbedDeps>): void {
  deps = { ...deps, ...overrides };
}

export function _resetEmbedDepsForTesting(): void {
  deps = { ...defaultDeps };
}

export async function embed(texts: string[], mode: Mode): Promise<number[][]> {
  const logger = getLogger();
  const start = Date.now();

  if (texts.length === 0) {
    logger.debug("embed completed", {
      textCount: 0,
      purpose: mode,
      durationMs: Date.now() - start,
    });
    return [];
  }

  const keys = texts.map((text) => makeCacheKey(mode, text));
  const cached = keys.map((key) => cache.get(key) ?? null);
  if (cached.every((vector) => vector !== null)) {
    logger.debug("embed completed", {
      textCount: texts.length,
      purpose: mode,
      durationMs: Date.now() - start,
    });
    return cached as number[][];
  }

  const vectors: Array<number[] | null> = [...cached];
  const missingIndices: number[] = [];
  for (let i = 0; i < vectors.length; i++) {
    if (vectors[i] === null) {
      missingIndices.push(i);
    }
  }

  const modelInputs = missingIndices.map((index) =>
    toModelInput(mode, texts[index]),
  );
  const config = getConfig();
  if (!config.embedding) {
    throw new Error(EMBED_CONFIG_REQUIRED);
  }
  const provider = await deps.createEmbeddingProvider(config.embedding);
  const embeddingModel = getEmbeddingModel(provider, config.embedding.model);

  try {
    const { embeddings } = await breaker.execute(() =>
      deps.embedMany({
        model: embeddingModel,
        values: modelInputs,
        maxRetries: 3,
      }),
    );

    initialized = true;

    for (let i = 0; i < missingIndices.length; i++) {
      const vector = embeddings[i];
      if (embeddingDimension === null) {
        embeddingDimension = vector.length;
      } else if (vector.length !== embeddingDimension) {
        throw new Error(
          `${EMBED_DIMENSION_MISMATCH_PREFIX}${vector.length}, expected ${embeddingDimension}`,
        );
      }
      const index = missingIndices[i];
      vectors[index] = vector;
      cache.set(keys[index], vector);
    }
  } catch (error: unknown) {
    initialized = true;
    if (isBrokenCircuitError(error)) {
      throw new Error(CIRCUIT_OPEN_MESSAGE);
    }
    logger.error("embed failed", { textCount: texts.length, purpose: mode });
    throw error;
  }

  const finalized = vectors.map((vector) => {
    if (vector === null) {
      throw new Error(EMBED_FAILED_MESSAGE);
    }
    return vector;
  });

  logger.debug("embed completed", {
    textCount: texts.length,
    purpose: mode,
    durationMs: Date.now() - start,
  });
  return finalized;
}

export function getEmbeddingDimension(): number | null {
  return embeddingDimension;
}
