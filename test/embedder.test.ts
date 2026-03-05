import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _resetConfigForTesting, _setConfigForTesting } from "../src/config.ts";
import {
  _resetEmbedDepsForTesting,
  _setEmbedDepsForTesting,
  embed,
  getEmbedderState,
  resetEmbedder,
} from "../src/core/ai/embed.ts";
import type { createEmbeddingProvider } from "../src/core/ai/providers.ts";
import { makeTestConfig } from "./fixtures/config.ts";

const testConfig = makeTestConfig();

const mockEmbedMany = mock((_options: { values: string[] }) =>
  Promise.resolve({ embeddings: [] as number[][] }),
);
const mockCreateEmbeddingProvider = mock(() =>
  Promise.resolve({ embedding: (_id: string) => ({}) }),
);

function makeVector(seed: number, dim = 768): number[] {
  return Array.from({ length: dim }, (_, i) => seed + i * 0.001);
}

beforeEach(() => {
  resetEmbedder();
  _setConfigForTesting(testConfig);
  mockEmbedMany.mockReset();
  mockCreateEmbeddingProvider.mockReset();
  mockCreateEmbeddingProvider.mockResolvedValue({
    embedding: (_id: string) => ({}),
  });
  _setEmbedDepsForTesting({
    embedMany: mockEmbedMany as unknown as typeof import("ai").embedMany,
    createEmbeddingProvider:
      mockCreateEmbeddingProvider as unknown as typeof createEmbeddingProvider,
  });
});

afterEach(() => {
  _resetEmbedDepsForTesting();
  _resetConfigForTesting();
  resetEmbedder();
});

describe("embed()", () => {
  test("returns [] for empty input without calling embedMany", async () => {
    const result = await embed([], "query");

    expect(result).toEqual([]);
    expect(mockEmbedMany).not.toHaveBeenCalled();
    expect(mockCreateEmbeddingProvider).not.toHaveBeenCalled();
  });

  test("returns a 768-dim vector for single text", async () => {
    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(1)] });

    const result = await embed(["hello"], "query");

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(768);
    expect(mockEmbedMany).toHaveBeenCalledTimes(1);
  });

  test("caches identical inputs", async () => {
    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(2)] });

    const first = await embed(["same"], "query");
    const second = await embed(["same"], "query");

    expect(first).toEqual(second);
    expect(mockEmbedMany).toHaveBeenCalledTimes(1);
  });

  test("uses different cache keys for query and document modes", async () => {
    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(3)] });
    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(4)] });

    const query = await embed(["same text"], "query");
    const document = await embed(["same text"], "document");

    expect(mockEmbedMany).toHaveBeenCalledTimes(2);
    expect(query[0]).not.toEqual(document[0]);
  });

  test("handles mixed cache hits and misses", async () => {
    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(10)] });
    await embed(["a"], "query");

    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(11)] });
    const result = await embed(["a", "b"], "query");

    expect(mockEmbedMany).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(768);
    expect(result[1]).toHaveLength(768);
  });

  test("keeps separate caches across modes", async () => {
    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(20)] });
    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(21)] });

    await embed(["shared"], "query");
    await embed(["shared"], "document");
    await embed(["shared"], "query");
    await embed(["shared"], "document");

    expect(mockEmbedMany).toHaveBeenCalledTimes(2);
  });

  test("throws on wrong embedding dimension", async () => {
    // First call establishes the dimension at 768
    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(10, 768)] });
    await embed(["first"], "query");

    // Second call with different dimension should throw
    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(30, 32)] });

    await expect(embed(["bad"], "document")).rejects.toThrow(
      "Unexpected embedding dimension",
    );
  });

  test("propagates provider creation errors", async () => {
    mockCreateEmbeddingProvider.mockRejectedValueOnce(
      new Error("provider failed"),
    );

    await expect(embed(["x"], "query")).rejects.toThrow("provider failed");
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });

  test("resetEmbedder clears cache and state", async () => {
    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(40)] });

    await embed(["x"], "query");
    expect(getEmbedderState()).toBe("ready");

    resetEmbedder();
    expect(getEmbedderState()).toBe("uninitialized");

    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(41)] });
    await embed(["x"], "query");
    expect(mockEmbedMany).toHaveBeenCalledTimes(2);
  });

  test("throws when embedding config is missing", async () => {
    const { embedding: _embedding, ...withoutEmbedding } = testConfig;
    _setConfigForTesting(withoutEmbedding);

    await expect(embed(["x"], "query")).rejects.toThrow(
      "Embedding configuration is required",
    );
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });
});

describe("getEmbedderState()", () => {
  test("returns uninitialized initially", () => {
    expect(getEmbedderState()).toBe("uninitialized");
  });

  test("returns ready after successful embed", async () => {
    mockEmbedMany.mockResolvedValueOnce({ embeddings: [makeVector(50)] });

    await embed(["ok"], "query");

    expect(getEmbedderState()).toBe("ready");
  });

  test("returns degraded after breaker opens", async () => {
    mockEmbedMany.mockRejectedValue(new Error("boom"));

    await expect(embed(["a"], "query")).rejects.toThrow("boom");
    await expect(embed(["b"], "query")).rejects.toThrow("boom");
    await expect(embed(["c"], "query")).rejects.toThrow("boom");

    expect(getEmbedderState()).toBe("degraded");
    await expect(embed(["d"], "query")).rejects.toThrow(
      "Embedder circuit breaker is open",
    );
  });
});
