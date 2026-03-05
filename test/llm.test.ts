import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { generateText } from "ai";
import { APICallError, NoObjectGeneratedError } from "ai";
import { _resetConfigForTesting, _setConfigForTesting } from "../src/config.ts";
import {
  _resetGenerateDepsForTesting,
  _setGenerateDepsForTesting,
  callLLMWithTool,
  type LLMCallOptions,
  type ToolSchema,
  validateLLMEndpoint,
} from "../src/core/ai/generate.ts";
import type { createLLMProvider } from "../src/core/ai/providers.ts";
import { makeTestConfig } from "./fixtures/config.ts";

const baseConfig = makeTestConfig({ llm: { apiKey: "test-key-1234" } });

const testToolSchema: ToolSchema = {
  name: "extract_fact",
  description: "Extract structured data",
  parameters: {
    type: "object",
    properties: {
      result: { type: "string" },
    },
    required: ["result"],
  },
};

const baseOptions: LLMCallOptions = {
  systemPrompt: "You are a strict JSON assistant.",
  userPrompt: "Return one fact.",
  toolSchema: testToolSchema,
};

const mockGenerateText = mock(
  (_options: {
    prompt?: string;
    system?: string;
    temperature?: number;
    output?: unknown;
  }): Promise<{ output: Record<string, unknown> }> =>
    Promise.resolve({ output: { result: "test" } }),
);
const mockCreateLLMProvider = mock(() =>
  Promise.resolve({ chat: (_id: string) => ({}) }),
);

function makeAbortError(): Error {
  const err = new Error("AbortError");
  err.name = "AbortError";
  return err;
}

function makeApiCallError(message: string, statusCode?: number): APICallError {
  return new APICallError({
    message,
    url: "http://test",
    requestBodyValues: {},
    statusCode,
    responseHeaders: {},
    responseBody: undefined,
    isRetryable: false,
  });
}

function makeNoObjectGeneratedError(message: string): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message,
    text: "not-json",
    response: {
      id: "resp-1",
      timestamp: new Date(),
      modelId: "test-model",
    },
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      inputTokenDetails: {
        noCacheTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokenDetails: {
        textTokens: 1,
        reasoningTokens: 0,
      },
    },
    finishReason: "stop",
  });
}

function getFailure(
  result: Awaited<ReturnType<typeof callLLMWithTool>>,
): Extract<Awaited<ReturnType<typeof callLLMWithTool>>, { success: false }> {
  if (result.success) {
    throw new Error("Expected callLLMWithTool to fail");
  }

  return result as Extract<
    Awaited<ReturnType<typeof callLLMWithTool>>,
    { success: false }
  >;
}

beforeEach(() => {
  _setConfigForTesting(baseConfig);
  mockGenerateText.mockReset();
  mockCreateLLMProvider.mockReset();
  mockGenerateText.mockResolvedValue({ output: { result: "test" } });
  mockCreateLLMProvider.mockResolvedValue({ chat: (_id: string) => ({}) });
  _setGenerateDepsForTesting({
    generateText: mockGenerateText as unknown as typeof generateText,
    createLLMProvider:
      mockCreateLLMProvider as unknown as typeof createLLMProvider,
  });
});

afterEach(() => {
  _resetGenerateDepsForTesting();
  _resetConfigForTesting();
});

describe("callLLMWithTool", () => {
  test("returns parsed data on success", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: { result: "ok" } });

    const result = await callLLMWithTool(baseOptions);

    expect(result).toEqual({ success: true, data: { result: "ok" } });
  });

  test("passes prompt and schema to generateText", async () => {
    await callLLMWithTool(baseOptions);

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        system: baseOptions.systemPrompt,
        output: expect.anything(),
      }),
    );
    expect(
      (mockGenerateText.mock.lastCall?.[0] as { prompt: string } | undefined)
        ?.prompt,
    ).toContain(baseOptions.userPrompt);
    expect(
      (mockGenerateText.mock.lastCall?.[0] as { prompt: string } | undefined)
        ?.prompt,
    ).toContain("Return ONLY a raw JSON object");
    expect(
      (mockGenerateText.mock.lastCall?.[0] as { prompt: string } | undefined)
        ?.prompt,
    ).toContain(testToolSchema.name);
  });

  test("supports per-call provider overrides", async () => {
    const chat = mock((_id: string) => ({}));
    mockCreateLLMProvider.mockResolvedValueOnce({ chat });

    await callLLMWithTool({
      ...baseOptions,
      provider: "openai-chat",
      model: "gpt-4o-mini",
      apiUrl: "https://api.openai.com/v1",
      apiKey: "override-key",
    });

    expect(mockCreateLLMProvider).toHaveBeenCalledWith({
      provider: "openai-chat",
      model: "gpt-4o-mini",
      apiUrl: "https://api.openai.com/v1",
      apiKey: "override-key",
    });
    expect(chat).toHaveBeenCalledWith("gpt-4o-mini");
  });

  test("uses temperature 0 for nothink and 0.3 when nothink is false", async () => {
    await callLLMWithTool({ ...baseOptions, nothink: true });
    await callLLMWithTool({ ...baseOptions, nothink: false });

    expect(mockGenerateText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ temperature: 0 }),
    );
    expect(mockGenerateText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ temperature: 0.3 }),
    );
  });

  test("maps AbortError to timeout", async () => {
    mockGenerateText.mockRejectedValueOnce(makeAbortError());

    const result = await callLLMWithTool(baseOptions);

    expect(result.success).toBe(false);
    expect(getFailure(result).code).toBe("timeout");
  });

  test("maps APICallError 429 to rate_limit", async () => {
    mockGenerateText.mockRejectedValueOnce(
      makeApiCallError("Too many requests", 429),
    );

    const result = await callLLMWithTool(baseOptions);

    expect(result.success).toBe(false);
    expect(getFailure(result).code).toBe("rate_limit");
  });

  test("maps APICallError 401 to api_error", async () => {
    mockGenerateText.mockRejectedValueOnce(
      makeApiCallError("Unauthorized", 401),
    );

    const result = await callLLMWithTool(baseOptions);

    expect(result.success).toBe(false);
    expect(getFailure(result).code).toBe("api_error");
  });

  test("maps APICallError without status to network_error", async () => {
    mockGenerateText.mockRejectedValueOnce(makeApiCallError("fetch failed"));

    const result = await callLLMWithTool(baseOptions);

    expect(result.success).toBe(false);
    expect(getFailure(result).code).toBe("network_error");
  });

  test("maps NoObjectGeneratedError to parse_error", async () => {
    mockGenerateText.mockRejectedValueOnce(
      makeNoObjectGeneratedError("No object generated from model output"),
    );

    const result = await callLLMWithTool(baseOptions);

    expect(result.success).toBe(false);
    expect(getFailure(result).code).toBe("parse_error");
  });

  test("maps ECONNREFUSED errors to network_error", async () => {
    mockGenerateText.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 127.0.0.1"),
    );

    const result = await callLLMWithTool(baseOptions);

    expect(result.success).toBe(false);
    expect(getFailure(result).code).toBe("network_error");
  });

  test("maps generic errors to api_error", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("unexpected failure"));

    const result = await callLLMWithTool(baseOptions);

    expect(result.success).toBe(false);
    expect(getFailure(result).code).toBe("api_error");
  });

  test("sanitizes API key in error messages", async () => {
    _setConfigForTesting({
      ...baseConfig,
      llm: {
        ...baseConfig.llm,
        apiKey: "secret-test-key",
      },
    });
    mockGenerateText.mockRejectedValueOnce(
      new Error(
        "Request failed for key secret-test-key with Bearer secret-test-key",
      ),
    );

    const result = await callLLMWithTool(baseOptions);

    const failure = getFailure(result);
    expect(result.success).toBe(false);
    expect(failure.error).not.toContain("secret-test-key");
    expect(failure.error).toContain("[redacted");
  });
});

describe("validateLLMEndpoint", () => {
  test("returns ok true when endpoint responds", async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { ok: true } as Record<string, unknown>,
    });

    const result = await validateLLMEndpoint();

    expect(result).toEqual({ ok: true });
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  test("returns timeout on AbortError", async () => {
    _setConfigForTesting({
      ...baseConfig,
      llm: {
        ...baseConfig.llm,
        apiKey: "test-key",
      },
    });
    mockGenerateText.mockRejectedValueOnce(makeAbortError());

    const result = await validateLLMEndpoint();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  test("returns invalid API key for 401", async () => {
    _setConfigForTesting({
      ...baseConfig,
      llm: {
        ...baseConfig.llm,
        apiKey: "test-key",
      },
    });
    mockGenerateText.mockRejectedValueOnce(
      makeApiCallError("Unauthorized", 401),
    );

    const result = await validateLLMEndpoint();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid or unauthorized API key");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  test("returns model not found for 404", async () => {
    _setConfigForTesting({
      ...baseConfig,
      llm: {
        ...baseConfig.llm,
        apiKey: "test-key",
      },
    });
    mockGenerateText.mockRejectedValueOnce(
      makeApiCallError("Model not found", 404),
    );

    const result = await validateLLMEndpoint();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Model not found");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  test("returns endpoint unreachable for network errors", async () => {
    _setConfigForTesting({
      ...baseConfig,
      llm: {
        ...baseConfig.llm,
        apiKey: "test-key",
      },
    });
    mockGenerateText.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1"));

    const result = await validateLLMEndpoint();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("LLM endpoint unreachable");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });
});
