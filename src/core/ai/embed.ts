import { embedMany } from "ai";
import { getConfig } from "../../config";
import type { SubsystemState } from "../../types";
import { getLogger } from "../../util/logger.ts";
import { createEmbeddingProvider } from "./providers";

const EMBEDDING_DIMENSION = 768;
const CACHE_SIZE = 100;
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const DEGRADED_COOLDOWN_MS = 30_000;

interface EmbedDeps {
  embedMany: typeof embedMany;
  createEmbeddingProvider: typeof createEmbeddingProvider;
}

type EmbeddingModel = Parameters<typeof embedMany>[0]["model"];

const defaultDeps: EmbedDeps = {
  embedMany,
  createEmbeddingProvider,
};

let deps: EmbedDeps = { ...defaultDeps };

let subsystemState: SubsystemState = "uninitialized";

const cache = new Map<string, number[]>();
const failureTimestamps: number[] = [];
let degradedUntil = 0;
let degradedProbePromise: Promise<void> | null = null;
let probeResolve: (() => void) | null = null;
let probeReject: ((err: Error) => void) | null = null;

type Mode = "query" | "document";

function makeCacheKey(mode: Mode, text: string): string {
  return `${mode}:${text}`;
}

function toModelInput(mode: Mode, text: string): string {
  return mode === "query"
    ? `task: search result | query: ${text}`
    : `title: none | text: ${text}`;
}

function getCachedVector(key: string): number[] | null {
  const hit = cache.get(key);
  if (!hit) {
    return null;
  }

  cache.delete(key);
  cache.set(key, hit);
  return [...hit];
}

function setCachedVector(key: string, vector: number[]): void {
  if (cache.has(key)) {
    cache.delete(key);
  }

  cache.set(key, [...vector]);
  if (cache.size <= CACHE_SIZE) {
    return;
  }

  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) {
    cache.delete(oldestKey);
  }
}

function pruneFailures(now: number): void {
  while (
    failureTimestamps.length > 0 &&
    now - failureTimestamps[0] > FAILURE_WINDOW_MS
  ) {
    failureTimestamps.shift();
  }
}

async function beforeRequest(): Promise<void> {
  if (subsystemState !== "degraded") {
    return;
  }

  const now = Date.now();
  if (now < degradedUntil) {
    throw new Error("Embedder circuit breaker is open");
  }

  if (degradedProbePromise) {
    await degradedProbePromise;
    return;
  }

  degradedProbePromise = new Promise<void>((resolve, reject) => {
    probeResolve = resolve;
    probeReject = reject;
  });
}

function onSuccess(): void {
  failureTimestamps.length = 0;
  degradedUntil = 0;
  subsystemState = "ready";
  if (probeResolve) {
    probeResolve();
    probeResolve = null;
    probeReject = null;
    degradedProbePromise = null;
  }
}

function onFailure(): void {
  const now = Date.now();
  pruneFailures(now);
  failureTimestamps.push(now);

  if (
    failureTimestamps.length >= FAILURE_THRESHOLD ||
    subsystemState === "degraded"
  ) {
    subsystemState = "degraded";
    degradedUntil = now + DEGRADED_COOLDOWN_MS;
    if (probeReject) {
      probeReject(new Error("Embedder circuit breaker probe failed"));
      probeResolve = null;
      probeReject = null;
      degradedProbePromise = null;
    }
    return;
  }

  subsystemState = "error";
}

export function getEmbedderState(): SubsystemState {
  return subsystemState;
}

export function resetEmbedder(): void {
  subsystemState = "uninitialized";
  cache.clear();
  failureTimestamps.length = 0;
  degradedUntil = 0;
  degradedProbePromise = null;
  probeResolve = null;
  probeReject = null;
}

export function _setEmbedDepsForTesting(overrides: Partial<EmbedDeps>): void {
  deps = { ...deps, ...overrides };
}

export function _resetEmbedDepsForTesting(): void {
  deps = { ...defaultDeps };
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

export async function embed(texts: string[], mode: Mode): Promise<number[][]> {
  const logger = getLogger();
  const start = Date.now();
  await beforeRequest();

  if (texts.length === 0) {
    logger.debug("embed completed", {
      textCount: 0,
      purpose: mode,
      durationMs: Date.now() - start,
    });
    return [];
  }

  const keys = texts.map((text) => makeCacheKey(mode, text));
  const cached = keys.map((key) => getCachedVector(key));
  const allCached = cached.every((vector) => vector !== null);
  if (allCached) {
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

  const modelInputs = missingIndices.map((index) => toModelInput(mode, texts[index]));
  const config = getConfig();
  if (!config.embedding) {
    throw new Error("Embedding configuration is required");
  }
  const provider = await deps.createEmbeddingProvider(config.embedding);
  const embeddingModel = getEmbeddingModel(provider, config.embedding.model);

  try {
    const { embeddings } = await deps.embedMany({
      model: embeddingModel,
      values: modelInputs,
      maxRetries: 3,
    });

    for (let i = 0; i < missingIndices.length; i++) {
      const vector = embeddings[i];
      if (vector.length !== EMBEDDING_DIMENSION) {
        throw new Error(
          `Unexpected embedding dimension: got ${vector.length}, expected ${EMBEDDING_DIMENSION}`,
        );
      }

      const index = missingIndices[i];
      vectors[index] = vector;
      setCachedVector(keys[index], vector);
    }

    onSuccess();
  } catch (error: unknown) {
    onFailure();
    logger.error("embed failed", { textCount: texts.length, purpose: mode });
    throw error;
  }

  const finalized = vectors.map((vector) => {
    if (vector === null) {
      throw new Error("Embedding generation failed for one or more inputs");
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
