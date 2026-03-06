import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setConfigForTesting,
  getHybridWeights,
  type PluginConfig,
} from "../../src/config.ts";
import {
  _setDbForTesting,
  closeDb,
  getAllActiveMemories,
  getDb,
  insertMemory,
} from "../../src/db/database.ts";
import type { Memory } from "../../src/types.ts";

type RetrievalPreset = "fast" | "balanced" | "thorough";

interface GoldenDatasetEntry {
  id: string;
  memory_content: string;
  query: string;
  expected_rank: number;
  category: "general" | "code";
}

interface Metrics {
  mrrAt10: number;
  recallAt5: number;
  ndcgAt10: number;
}

interface BaselineFile {
  version: number;
  datasetSize: number;
  generatedAt: string;
  presets: Record<RetrievalPreset, Metrics>;
}

const CONTAINER_TAG = "golden-regression";
const VECTOR_DIMENSIONS = 768;
const TOP_K = 10;
const REGRESSION_TOLERANCE = 0.05;

const TOPIC_KEYWORDS: Record<string, string[]> = {
  database: [
    "database",
    "postgres",
    "sql",
    "sqlite",
    "query",
    "migration",
    "transaction",
    "index",
    "db",
  ],
  infra: [
    "deploy",
    "release",
    "staging",
    "production",
    "canary",
    "rollback",
    "pipeline",
    "ci",
    "github actions",
    "kubernetes",
  ],
  security: [
    "auth",
    "oauth",
    "token",
    "secret",
    "encrypted",
    "security",
    "verify",
    "malware",
    "password",
    "api key",
  ],
  observability: [
    "trace",
    "otel",
    "metrics",
    "grafana",
    "prometheus",
    "incident",
    "pagerduty",
    "log",
    "slo",
    "uptime",
  ],
  product: [
    "frontend",
    "mobile",
    "theme",
    "onboarding",
    "support",
    "translation",
    "docs",
    "analytics",
    "feature",
    "ui",
  ],
  code: [
    "function",
    "class",
    "method",
    "stack trace",
    "error",
    "api",
    "commit",
    "typescript",
    "javascript",
    "python",
    "rust",
  ],
};

const TOPIC_NAMES = Object.keys(TOPIC_KEYWORDS);

const DATASET_URL = new URL("./dataset.json", import.meta.url);
const BASELINE_URL = new URL("./baseline.json", import.meta.url);

function xorshift32(seed: number): () => number {
  let state = seed | 0;
  if (state === 0) state = 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function normalizeVector(vec: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }

  const length = Math.sqrt(norm);
  if (length === 0) {
    return vec;
  }

  for (let i = 0; i < vec.length; i++) {
    vec[i] /= length;
  }

  return vec;
}

function makeBaseDirection(topic: string): number[] {
  const rand = xorshift32(hashToken(`topic:${topic}`));
  const vec = new Array<number>(VECTOR_DIMENSIONS);
  for (let i = 0; i < VECTOR_DIMENSIONS; i++) {
    vec[i] = rand() * 2 - 1;
  }
  return normalizeVector(vec);
}

const TOPIC_BASES: Record<string, number[]> = TOPIC_NAMES.reduce(
  (acc, topic) => {
    acc[topic] = makeBaseDirection(topic);
    return acc;
  },
  {} as Record<string, number[]>,
);

function hashToken(token: string): number {
  let hash = 216613626;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function inferTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const topic of TOPIC_NAMES) {
    const keywords = TOPIC_KEYWORDS[topic];
    if (keywords.some((keyword) => lower.includes(keyword))) {
      matched.push(topic);
    }
  }
  if (matched.length === 0) {
    return ["product"];
  }
  return matched;
}

function embedDeterministic(text: string): number[] {
  const vec = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  const topics = inferTopics(text);

  for (const topic of topics) {
    const base = TOPIC_BASES[topic];
    for (let i = 0; i < VECTOR_DIMENSIONS; i++) {
      vec[i] += base[i] * 1.2;
    }
  }

  const tokens = tokenize(text);
  for (const token of tokens) {
    const index = Math.abs(hashToken(token)) % VECTOR_DIMENSIONS;
    vec[index] += 0.25;

    const neighbor = (index + 97) % VECTOR_DIMENSIONS;
    vec[neighbor] -= 0.1;
  }

  return normalizeVector(vec);
}

function makeConfig(retrievalQuality: RetrievalPreset): PluginConfig {
  return {
    llm: {
      provider: "ollama",
      model: "glm-4.6:cloud",
      apiUrl: "http://127.0.0.1:11434",
      apiKey: "",
    },
    embedding: {
      provider: "ollama",
      model: "embeddinggemma:latest",
      apiUrl: "http://127.0.0.1:11434",
      apiKey: "",
    },
    storage: { path: "/tmp" },
    memory: {
      maxResults: TOP_K,
      autoCapture: false,
      injection: "first",
      excludeCurrentSession: true,
    },
    web: {
      port: 4747,
    },
    search: {
      retrievalQuality,
    },
    toasts: {
      autoCapture: true,
      userProfile: true,
      errors: true,
    },
    compaction: {
      enabled: true,
      memoryLimit: 10,
    },
    consolidation: {
      maxCandidates: 500,
    },
  };
}

function makeMemory(entry: GoldenDatasetEntry): Memory {
  const now = Date.now();
  return {
    id: entry.id,
    content: entry.memory_content,
    embedding: new Float32Array(embedDeterministic(entry.memory_content)),
    containerTag: CONTAINER_TAG,
    tags: [entry.category],
    type: entry.category === "code" ? "code" : "note",
    isStarred: false,
    createdAt: now,
    updatedAt: now,
    metadata: { importance: entry.category === "code" ? 7 : 5 },
    userName: "",
    userEmail: "",
    projectPath: "",
    projectName: "",
    gitRepoUrl: "",
    provenance: {
      sessionId: "golden-suite",
      messageRange: [0, 0],
      toolCallIds: [],
    },
    lastAccessedAt: now,
    accessCount: 0,
    epistemicStatus: {
      confidence: 0.9,
      evidenceCount: 2,
    },
    evictedAt: null,
    suspended: false,
    suspendedReason: null,
    suspendedAt: null,
    stability: 0,
    difficulty: 5.0,
    nextReviewAt: null,
  };
}

function computeMetrics(ranks: number[], totalQueries: number): Metrics {
  const mrrAt10 =
    ranks.reduce((sum, rank) => {
      if (rank >= 1 && rank <= 10) {
        return sum + 1 / rank;
      }
      return sum;
    }, 0) / totalQueries;

  const recallAt5 =
    ranks.reduce((sum, rank) => {
      if (rank >= 1 && rank <= 5) {
        return sum + 1;
      }
      return sum;
    }, 0) / totalQueries;

  const ndcgAt10 =
    ranks.reduce((sum, rank) => {
      if (rank >= 1 && rank <= 10) {
        const dcg = 1 / Math.log2(rank + 1);
        return sum + dcg;
      }
      return sum;
    }, 0) / totalQueries;

  return { mrrAt10, recallAt5, ndcgAt10 };
}

function cosineSimilarity(a: number[], b: Float32Array): number {
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

function keywordScore(query: string, content: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) {
    return 0;
  }

  const contentTokens = new Set(tokenize(content));
  let overlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / queryTokens.size;
}

function runHybridRetrieval(
  db: ReturnType<typeof getDb>,
  query: string,
  config: PluginConfig,
  limit: number,
): { memory: Memory; score: number }[] {
  const weights = getHybridWeights(config);
  const queryVec = embedDeterministic(query);
  const memories = getAllActiveMemories(db).filter(
    (memory) => memory.containerTag === CONTAINER_TAG,
  );

  return memories
    .map((memory) => {
      const semanticRaw = cosineSimilarity(queryVec, memory.embedding);
      const semantic = (semanticRaw + 1) / 2;
      const keyword = keywordScore(query, memory.content);
      const score = weights.semantic * semantic + weights.keyword * keyword;
      return { memory, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function readDataset(): GoldenDatasetEntry[] {
  const raw = readFileSync(DATASET_URL, "utf-8");
  const parsed = JSON.parse(raw) as GoldenDatasetEntry[];
  return parsed;
}

function readBaseline(): BaselineFile | null {
  if (!existsSync(BASELINE_URL)) {
    return null;
  }
  const raw = readFileSync(BASELINE_URL, "utf-8");
  return JSON.parse(raw) as BaselineFile;
}

function writeBaseline(
  metrics: Record<RetrievalPreset, Metrics>,
  datasetSize: number,
): void {
  const payload: BaselineFile = {
    version: 1,
    datasetSize,
    generatedAt: new Date().toISOString(),
    presets: metrics,
  };
  writeFileSync(BASELINE_URL, `${JSON.stringify(payload, null, 2)}\n`);
}

function assertWithinRegressionThreshold(
  current: Record<RetrievalPreset, Metrics>,
  baseline: BaselineFile,
): void {
  for (const preset of ["fast", "balanced", "thorough"] as const) {
    const currentMetrics = current[preset];
    const baselineMetrics = baseline.presets[preset];

    for (const metricName of ["mrrAt10", "recallAt5", "ndcgAt10"] as const) {
      const currentValue = currentMetrics[metricName];
      const baselineValue = baselineMetrics[metricName];
      const floor = baselineValue * (1 - REGRESSION_TOLERANCE);

      expect(
        currentValue,
        `${preset} ${metricName} regressed: current=${currentValue.toFixed(6)}, baseline=${baselineValue.toFixed(6)}, allowed_floor=${floor.toFixed(6)}`,
      ).toBeGreaterThanOrEqual(floor);
    }
  }
}

describe("golden retrieval regression", () => {
  const dataset = readDataset();
  let tmpRoot = "";
  let db: ReturnType<typeof getDb>;

  beforeAll(async () => {
    mock.restore();
    closeDb();
    tmpRoot = mkdtempSync(join(tmpdir(), "flashback-golden-"));
    db = getDb(join(tmpRoot, "golden.db"));

    _setDbForTesting(db);
    _setConfigForTesting(makeConfig("balanced"));

    for (const entry of dataset) {
      insertMemory(db, makeMemory(entry));
    }
  });

  afterAll(() => {
    closeDb();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("keeps MRR@10, Recall@5, and NDCG@10 within 5 percent of baseline", async () => {
    const presetMetrics: Record<RetrievalPreset, Metrics> = {
      fast: { mrrAt10: 0, recallAt5: 0, ndcgAt10: 0 },
      balanced: { mrrAt10: 0, recallAt5: 0, ndcgAt10: 0 },
      thorough: { mrrAt10: 0, recallAt5: 0, ndcgAt10: 0 },
    };

    for (const preset of ["fast", "balanced", "thorough"] as const) {
      const config = makeConfig(preset);
      _setConfigForTesting(config);
      const ranks: number[] = [];

      for (const entry of dataset) {
        const results = runHybridRetrieval(db, entry.query, config, TOP_K);

        const rank =
          results.findIndex((result) => result.memory.id === entry.id) + 1;
        ranks.push(rank > 0 ? rank : Number.POSITIVE_INFINITY);
      }

      presetMetrics[preset] = computeMetrics(ranks, dataset.length);
    }

    const baseline = readBaseline();
    if (baseline === null || process.env.UPDATE_GOLDEN_BASELINE === "1") {
      writeBaseline(presetMetrics, dataset.length);
      const updatedBaseline = readBaseline();
      expect(updatedBaseline).not.toBeNull();
      expect(updatedBaseline?.datasetSize).toBe(dataset.length);
      return;
    }

    expect(baseline.datasetSize).toBe(dataset.length);
    assertWithinRegressionThreshold(presetMetrics, baseline);
  });

  it("retrieves most curated entries within top 10", async () => {
    const config = makeConfig("balanced");
    _setConfigForTesting(config);

    let foundInTop10 = 0;
    let metExpectedRank = 0;

    for (const entry of dataset) {
      const results = runHybridRetrieval(db, entry.query, config, TOP_K);
      const rank =
        results.findIndex((result) => result.memory.id === entry.id) + 1;

      if (rank > 0 && rank <= TOP_K) {
        foundInTop10 += 1;
      }

      if (rank > 0 && rank <= entry.expected_rank) {
        metExpectedRank += 1;
      }
    }

    expect(foundInTop10 / dataset.length).toBeGreaterThanOrEqual(0.65);
    expect(metExpectedRank).toBeGreaterThanOrEqual(10);
  });
});
