import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { generateText } from "ai";
import { APICallError, NoObjectGeneratedError } from "ai";
import { _resetConfigForTesting, _setConfigForTesting } from "../src/config.ts";
import {
  _resetGenerateDepsForTesting,
  _setGenerateDepsForTesting,
  callLLMWithTool,
  getAvailableModels,
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
  const mockFetch = mock((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(null, { status: 200 })),
  );

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
    _setGenerateDepsForTesting({
      fetch: mockFetch as unknown as typeof fetch,
    });
  });

  test("returns ok true when endpoint responds with 200", async () => {
    const result = await validateLLMEndpoint();

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("calls correct URL for ollama provider", async () => {
    _setConfigForTesting(
      makeTestConfig({
        llm: { provider: "ollama", apiUrl: "http://localhost:11434" },
      }),
    );

    await validateLLMEndpoint();

    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toBe("http://localhost:11434/v1/models");
  });

  test("calls correct URL for openai-chat provider", async () => {
    _setConfigForTesting(
      makeTestConfig({
        llm: {
          provider: "openai-chat",
          apiUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
        },
      }),
    );

    await validateLLMEndpoint();

    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toBe("https://api.openai.com/v1/models");
  });

  test("returns timeout on TimeoutError", async () => {
    const err = new Error("TimeoutError");
    err.name = "TimeoutError";
    mockFetch.mockRejectedValueOnce(err);

    const result = await validateLLMEndpoint();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
  });

  test("returns invalid API key for 401", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 401, statusText: "Unauthorized" }),
    );

    const result = await validateLLMEndpoint();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid or unauthorized API key");
  });

  test("returns model not found for 404", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 404, statusText: "Not Found" }),
    );

    const result = await validateLLMEndpoint();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Model not found");
  });

  test("returns endpoint unreachable for network errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1"));

    const result = await validateLLMEndpoint();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("LLM endpoint unreachable");
  });
});

describe("getAvailableModels", () => {
  const mockFetch = mock((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(new Response(null, { status: 200 })),
  );

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
    _setGenerateDepsForTesting({
      fetch: mockFetch as unknown as typeof fetch,
    });
  });

  test("sends Authorization header for openai providers", async () => {
    _setConfigForTesting(
      makeTestConfig({
        llm: {
          provider: "openai-chat",
          apiUrl: "https://api.openai.com/v1",
          apiKey: "sk-test-key",
        },
      }),
    );

    await getAvailableModels();

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test-key",
    );
  });

  test("sends x-api-key header for anthropic", async () => {
    _setConfigForTesting(
      makeTestConfig({
        llm: {
          provider: "anthropic",
          apiUrl: "https://api.anthropic.com/v1",
          apiKey: "sk-ant-test",
        },
      }),
    );

    await getAvailableModels();

    const url = mockFetch.mock.calls[0]?.[0] as string;
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(
      "sk-ant-test",
    );
  });

  test("sends key as query param for gemini", async () => {
    _setConfigForTesting(
      makeTestConfig({
        llm: {
          provider: "gemini",
          apiUrl: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "gemini-key",
        },
      }),
    );

    await getAvailableModels();

    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?key=gemini-key",
    );
  });
});
