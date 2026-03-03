import {
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import type { SubsystemState } from "../types";
import { getLogger } from "../util/logger.ts";

const MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
const EMBEDDING_DIMENSION = 768;
const CACHE_SIZE = 100;
const BATCH_SIZE = 10;
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const DEGRADED_COOLDOWN_MS = 30_000;

let subsystemState: SubsystemState = "uninitialized";
let modelPipeline: FeatureExtractionPipeline | null = null;
let modelInitPromise: Promise<FeatureExtractionPipeline> | null = null;

const cache = new Map<string, number[]>();
const failureTimestamps: number[] = [];
let degradedUntil = 0;
let degradedProbeAvailable = false;

type Mode = "query" | "document";

interface BatchEmbeddingOutput {
  dispose: () => void;
  [index: number]: {
    data: ArrayLike<number>;
  };
}

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

function beforeRequest(): void {
  if (subsystemState !== "degraded") {
    return;
  }

  const now = Date.now();
  if (now < degradedUntil) {
    throw new Error("Embedder circuit breaker is open");
  }

  if (!degradedProbeAvailable) {
    throw new Error("Embedder circuit breaker probe already in progress");
  }

  degradedProbeAvailable = false;
}

function onSuccess(): void {
  failureTimestamps.length = 0;
  degradedUntil = 0;
  degradedProbeAvailable = false;
  subsystemState = "ready";
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
    degradedProbeAvailable = true;
    return;
  }

  subsystemState = "error";
}

async function getModel(): Promise<FeatureExtractionPipeline> {
  const logger = getLogger();
  if (modelPipeline) {
    return modelPipeline;
  }

  if (modelInitPromise) {
    return modelInitPromise;
  }

  subsystemState = "initializing";
  const start = Date.now();
  modelInitPromise = pipeline("feature-extraction", MODEL_ID, {
    device: "cpu",
    dtype: "q4",
  })
    .catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : "";
      if (msg.includes("device") || msg.includes("unsupported")) {
        logger.warn("Embedder device cpu failed, retrying with auto-detect");
        return pipeline("feature-extraction", MODEL_ID, { dtype: "q4" });
      }
      throw error;
    })
    .then((instance) => {
      modelPipeline = instance;
      modelInitPromise = null;
      subsystemState = "ready";
      logger.debug("Embedder model loaded", {
        modelName: MODEL_ID,
        durationMs: Date.now() - start,
      });
      return instance;
    })
    .catch((error: unknown) => {
      modelInitPromise = null;
      subsystemState = "error";
      logger.error("Embedder model load failed", { modelName: MODEL_ID });
      throw error;
    });

  return modelInitPromise;
}

export function getEmbedderState(): SubsystemState {
  return subsystemState;
}

export function resetEmbedder(): void {
  subsystemState = "uninitialized";
  modelPipeline = null;
  modelInitPromise = null;
  cache.clear();
  failureTimestamps.length = 0;
  degradedUntil = 0;
  degradedProbeAvailable = false;
}

export async function embed(texts: string[], mode: Mode): Promise<number[][]> {
  const logger = getLogger();
  const start = Date.now();
  beforeRequest();

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

  const model = await getModel();

  try {
    for (let start = 0; start < missingIndices.length; start += BATCH_SIZE) {
      const batchIndices = missingIndices.slice(start, start + BATCH_SIZE);
      const modelInputs = batchIndices.map((index) =>
        toModelInput(mode, texts[index]),
      );
      const output = (await model(modelInputs, {
        pooling: "mean",
        normalize: true,
      })) as unknown as BatchEmbeddingOutput;

      try {
        for (let i = 0; i < batchIndices.length; i++) {
          const vector = Array.from(output[i].data);
          if (vector.length !== EMBEDDING_DIMENSION) {
            throw new Error(
              `Unexpected embedding dimension: got ${vector.length}, expected ${EMBEDDING_DIMENSION}`,
            );
          }

          const index = batchIndices[i];
          vectors[index] = vector;
          setCachedVector(keys[index], vector);
        }
      } finally {
        output.dispose();
      }

      if (
        missingIndices.length > BATCH_SIZE &&
        start + BATCH_SIZE < missingIndices.length
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
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
