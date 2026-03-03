import { describe, test, expect, beforeEach, mock } from "bun:test";

// -- Mock @huggingface/transformers before importing embedder ----------------

const mockDispose = mock(() => {});
const mockPipelineInstance = mock();

mock.module("@huggingface/transformers", () => ({
  pipeline: mockPipelineInstance,
}));

import { embed, getEmbedderState, resetEmbedder } from "../embed/embedder.ts";

// -- Helpers -----------------------------------------------------------------

function makeVector(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => (seed + i) * 0.001);
}

function makeBatchOutput(vectors: number[][]) {
  const output: Record<string | number, unknown> = {
    dispose: mockDispose,
  };
  for (let i = 0; i < vectors.length; i++) {
    output[i] = { data: vectors[i] };
  }
  return output;
}

function setupSuccessfulPipeline(vectors?: number[][]) {
  const vecs = vectors ?? [makeVector(1)];
  let callIndex = 0;
  const pipelineFn = mock(async () => {
    const batch = vecs.slice(callIndex, callIndex + 10);
    callIndex += batch.length;
    return makeBatchOutput(batch.length > 0 ? batch : [makeVector(99)]);
  });
  mockPipelineInstance.mockResolvedValue(pipelineFn);
  return pipelineFn;
}

// -- Tests -------------------------------------------------------------------

describe("embedder", () => {
  beforeEach(() => {
    resetEmbedder();
    mockPipelineInstance.mockReset();
    mockDispose.mockClear();
  });

  describe("lazy initialization", () => {
    test("starts uninitialized", () => {
      expect(getEmbedderState()).toBe("uninitialized");
    });

    test("initializes on first embed call", async () => {
      setupSuccessfulPipeline();
      await embed(["hello"], "query");
      expect(getEmbedderState()).toBe("ready");
      expect(mockPipelineInstance).toHaveBeenCalledWith(
        "feature-extraction",
        "onnx-community/embeddinggemma-300m-ONNX",
        { device: "cpu", dtype: "q4" },
      );
    });

    // Regression: onnxruntime-node only supports cuda/cpu, not wasm
    test("uses cpu device, not wasm (onnxruntime-node compatibility)", async () => {
      setupSuccessfulPipeline();
      await embed(["regression"], "query");
      const opts = mockPipelineInstance.mock.calls[0][2] as { device: string };
      expect(opts.device).toBe("cpu");
      expect(opts.device).not.toBe("wasm");
    });

    test("reuses pipeline on subsequent calls", async () => {
      setupSuccessfulPipeline();
      await embed(["hello"], "query");
      await embed(["world"], "query");
      // pipeline() called only once
      expect(mockPipelineInstance).toHaveBeenCalledTimes(1);
    });
  });

  describe("embedding generation", () => {
    test("returns empty array for empty input", async () => {
      const result = await embed([], "query");
      expect(result).toEqual([]);
    });

    test("returns vectors with correct dimensions", async () => {
      const vec = makeVector(42);
      setupSuccessfulPipeline([vec]);
      const result = await embed(["test text"], "query");
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveLength(768);
    });

    test("handles multiple texts", async () => {
      const vecs = [makeVector(1), makeVector(2), makeVector(3)];
      setupSuccessfulPipeline(vecs);
      const result = await embed(["a", "b", "c"], "document");
      expect(result).toHaveLength(3);
    });

    test("disposes tensor output after processing", async () => {
      setupSuccessfulPipeline();
      await embed(["test"], "query");
      expect(mockDispose).toHaveBeenCalled();
    });
  });

  describe("LRU cache", () => {
    test("cache hit returns previously computed vector", async () => {
      const vec = makeVector(10);
      const pipelineFn = setupSuccessfulPipeline([vec]);
      await embed(["cached text"], "query");

      pipelineFn.mockClear();
      const result = await embed(["cached text"], "query");
      // Should not call model again -- all cached
      expect(pipelineFn).not.toHaveBeenCalled();
      expect(result[0]).toHaveLength(768);
    });

    test("different modes produce different cache keys", async () => {
      const vec = makeVector(20);
      const pipelineFn = setupSuccessfulPipeline([vec]);
      await embed(["same text"], "query");

      pipelineFn.mockClear();
      // Same text but different mode = cache miss
      setupSuccessfulPipeline([makeVector(21)]);
      const result = await embed(["same text"], "document");
      expect(result[0]).toHaveLength(768);
    });

    test("mixed cache hit/miss fetches only missing", async () => {
      const vec1 = makeVector(30);
      setupSuccessfulPipeline([vec1]);
      await embed(["text1"], "query");

      // Now embed text1 (cached) + text2 (miss)
      const vec2 = makeVector(31);
      setupSuccessfulPipeline([vec2]);
      const result = await embed(["text1", "text2"], "query");
      expect(result).toHaveLength(2);
    });
  });

  describe("circuit breaker", () => {
    test("transitions to error state on failure", async () => {
      mockPipelineInstance.mockResolvedValue(
        mock(async () => {
          throw new Error("Model inference failed");
        }),
      );
      await expect(embed(["test"], "query")).rejects.toThrow(
        "Model inference failed",
      );
      expect(getEmbedderState()).toBe("error");
    });

    test("transitions to degraded after 3 failures", async () => {
      for (let i = 0; i < 3; i++) {
        resetEmbedder();
        // Keep state as ready but simulate failures
        mockPipelineInstance.mockResolvedValue(
          mock(async () => {
            throw new Error(`Failure ${i}`);
          }),
        );
        try {
          await embed(["test"], "query");
        } catch {
          // expected
        }
      }
      // After 3 failures within the window, state should be degraded
      // Note: resetEmbedder clears failure timestamps, so we need consecutive failures
      // without resetting
      resetEmbedder();
      const failingFn = mock(async () => {
        throw new Error("fail");
      });
      mockPipelineInstance.mockResolvedValue(failingFn);

      for (let i = 0; i < 3; i++) {
        try {
          await embed(["test"], "query");
        } catch {
          // expected
        }
      }
      expect(getEmbedderState()).toBe("degraded");
    });

    test("degraded state throws circuit breaker error", async () => {
      // Force degraded state with 3 failures
      const failingFn = mock(async () => {
        throw new Error("fail");
      });
      mockPipelineInstance.mockResolvedValue(failingFn);

      for (let i = 0; i < 3; i++) {
        try {
          await embed(["test"], "query");
        } catch {
          // expected
        }
      }
      expect(getEmbedderState()).toBe("degraded");

      // Next call should throw circuit breaker error
      await expect(embed(["test"], "query")).rejects.toThrow(
        "Embedder circuit breaker is open",
      );
    });
  });

  describe("error handling", () => {
    test("wrong embedding dimension throws", async () => {
      const wrongDimVector = Array.from({ length: 256 }, (_, i) => i * 0.01);
      const pipelineFn = mock(async () => makeBatchOutput([wrongDimVector]));
      mockPipelineInstance.mockResolvedValue(pipelineFn);

      await expect(embed(["test"], "query")).rejects.toThrow(
        "Unexpected embedding dimension",
      );
    });

    test("pipeline init failure sets error state", async () => {
      mockPipelineInstance.mockRejectedValue(
        new Error("Model download failed"),
      );
      await expect(embed(["test"], "query")).rejects.toThrow(
        "Model download failed",
      );
      expect(getEmbedderState()).toBe("error");
    });
  });

  describe("resetEmbedder", () => {
    test("clears all state", async () => {
      setupSuccessfulPipeline();
      await embed(["test"], "query");
      expect(getEmbedderState()).toBe("ready");

      resetEmbedder();
      expect(getEmbedderState()).toBe("uninitialized");
    });
  });
});
