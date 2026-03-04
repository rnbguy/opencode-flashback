import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { APICallError } from "ai";
import {
  _setConfigForTesting,
  _resetConfigForTesting,
  type PluginConfig,
} from "../config.ts";
import {
  callLLMWithTool,
  _setGenerateDepsForTesting,
  _resetGenerateDepsForTesting,
} from "../core/ai/generate.ts";
import type { LLMCallOptions } from "../core/ai/generate.ts";
import type { createLLMProvider } from "../core/ai/providers.ts";

const defaultConfig: PluginConfig = {
  llm: {
    provider: "ollama",
    model: "kimi-k2.5:cloud",
    apiUrl: "http://127.0.0.1:11434",
    apiKey: "test-key-1234",
  },
  embedding: {
    provider: "ollama",
    model: "embeddinggemma:latest",
    apiUrl: "http://127.0.0.1:11434",
    apiKey: "",
  },
  storage: { path: "/tmp/test" },
  memory: {
    maxResults: 10,
    autoCapture: true,
    injection: "first",
    excludeCurrentSession: true,
  },
  web: { port: 4747, enabled: false },
  search: { retrievalQuality: "balanced" },
  toasts: {
    autoCapture: true,
    userProfile: true,
    errors: true,
  },
  compaction: {
    enabled: true,
    memoryLimit: 10,
  },
};

const baseOptions: LLMCallOptions = {
  systemPrompt: "You are a test assistant.",
  userPrompt: "Return test output",
  toolSchema: {
    name: "test_tool",
    description: "Conformance test tool",
    parameters: {
      type: "object",
      properties: {
        result: { type: "string" },
      },
      required: ["result"],
    },
  },
  apiKey: "test-key-1234",
  timeout: 30_000,
};

const mockGenerateText = mock(() => Promise.resolve({ output: { result: "hello" } }));
const mockCreateLLMProvider = mock(() =>
  Promise.resolve({ chat: (_id: string) => ({}) }),
);

describe("provider conformance", () => {
  beforeEach(() => {
    _setConfigForTesting(defaultConfig);
    mockGenerateText.mockReset();
    mockCreateLLMProvider.mockReset();
    mockCreateLLMProvider.mockResolvedValue({ chat: (_id: string) => ({}) });
    _setGenerateDepsForTesting({
      generateText: mockGenerateText as unknown as typeof import("ai").generateText,
      createLLMProvider: mockCreateLLMProvider as unknown as typeof createLLMProvider,
    });
  });

  afterEach(() => {
    _resetGenerateDepsForTesting();
    _resetConfigForTesting();
  });

  afterAll(() => {
    mock.restore();
  });

  test("normalizes successful tool call output", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: { result: "hello" } });
    const result = await callLLMWithTool(baseOptions);
    expect(result).toEqual({ success: true, data: { result: "hello" } });
  });

  test("normalizes 429 as rate_limit", async () => {
    mockGenerateText.mockRejectedValueOnce(
      new APICallError({
        message: "rate limited",
        statusCode: 429,
        url: "http://127.0.0.1:11434",
        requestBodyValues: {},
        responseHeaders: {},
        responseBody: undefined,
        isRetryable: false,
      }),
    );

    const result = await callLLMWithTool(baseOptions);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("rate_limit");
    }
  });

  test("normalizes 500 as api_error", async () => {
    mockGenerateText.mockRejectedValueOnce(
      new APICallError({
        message: "internal",
        statusCode: 500,
        url: "http://127.0.0.1:11434",
        requestBodyValues: {},
        responseHeaders: {},
        responseBody: undefined,
        isRetryable: false,
      }),
    );

    const result = await callLLMWithTool(baseOptions);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("api_error");
    }
  });

  test("normalizes network failures", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await callLLMWithTool(baseOptions);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("network_error");
    }
  });
});
