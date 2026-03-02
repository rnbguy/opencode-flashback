import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  _setConfigForTesting,
  _resetConfigForTesting,
  type PluginConfig,
} from "../config";

// -- Mock dependencies -------------------------------------------------------

const defaultConfig: PluginConfig = {
  llm: {
    provider: "openai-chat" as const,
    model: "gpt-4o-mini",
    apiUrl: "https://api.openai.com/v1",
    apiKey: "test-key-1234",
  },
  storage: { path: "/tmp/test" },
  memory: {
    maxResults: 10,
    autoCapture: true,
    injection: "first" as const,
    excludeCurrentSession: true,
  },
  web: { port: 4747, enabled: false },
  search: { retrievalQuality: "balanced" as const },
};

import { callLLMWithTool } from "../core/llm.ts";
import type { LLMCallOptions, LLMCallResult, ToolSchema } from "../core/llm.ts";

// -- Speed up retries: make setTimeout instant -------------------------------

const realSetTimeout = globalThis.setTimeout;

// -- Helpers -----------------------------------------------------------------

const testTool: ToolSchema = {
  name: "test_tool",
  description: "A test tool",
  parameters: {
    type: "object",
    properties: { result: { type: "string" } },
    required: ["result"],
  },
};

const baseOptions: LLMCallOptions = {
  systemPrompt: "You are a test assistant.",
  userPrompt: "Test prompt",
  toolSchema: testTool,
  apiKey: "test-key-1234",
  apiUrl: "https://api.test.com/v1",
  timeout: 30_000,
};

const mockFetch = mock<typeof fetch>();

function makeOpenAIChatResponse(args: Record<string, unknown>): unknown {
  return {
    choices: [
      {
        message: {
          tool_calls: [{ function: { arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

function makeOpenAIResponsesResponse(args: Record<string, unknown>): unknown {
  return {
    output: [{ type: "function_call", arguments: JSON.stringify(args) }],
  };
}

function makeAnthropicResponse(input: Record<string, unknown>): unknown {
  return {
    content: [{ type: "tool_use", input }],
  };
}

function makeGeminiResponse(args: Record<string, unknown>): unknown {
  return {
    candidates: [
      {
        content: {
          parts: [{ functionCall: { args } }],
        },
      },
    ],
  };
}

function mockSuccess(body: unknown): void {
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200 }),
  );
}

function mockError(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers }),
  );
}

// -- Tests -------------------------------------------------------------------

describe("llm", () => {
  beforeEach(() => {
    _setConfigForTesting(defaultConfig);
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    // Make all setTimeout instant to speed up retry tests
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      _ms?: number,
      ...args: unknown[]
    ) => {
      return realSetTimeout(fn, 0, ...args);
    }) as typeof setTimeout;
  });

  afterEach(() => {
    _resetConfigForTesting();
    globalThis.setTimeout = realSetTimeout;
  });

  // -- OpenAI Chat ---------------------------------------------------------

  describe("openai-chat", () => {
    test("returns parsed tool call arguments", async () => {
      mockSuccess(makeOpenAIChatResponse({ result: "hello" }));

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-chat",
        model: "gpt-4o",
      });

      expect(result).toEqual({ success: true, data: { result: "hello" } });
    });

    test("sends correct payload structure", async () => {
      mockSuccess(makeOpenAIChatResponse({ result: "ok" }));

      await callLLMWithTool({
        ...baseOptions,
        provider: "openai-chat",
        model: "gpt-4o",
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.test.com/v1/chat/completions");
      const body = JSON.parse(opts!.body as string);
      expect(body.model).toBe("gpt-4o");
      expect(body.messages).toHaveLength(2);
      expect(body.tools[0].type).toBe("function");
      expect(body.tool_choice.type).toBe("function");
    });

    test("handles missing tool call arguments", async () => {
      mockSuccess({ choices: [{ message: {} }] });

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-chat",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("parse_error");
      }
    });
  });

  // -- OpenAI Responses ----------------------------------------------------

  describe("openai-responses", () => {
    test("returns parsed function call arguments", async () => {
      mockSuccess(makeOpenAIResponsesResponse({ result: "world" }));

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-responses",
        model: "gpt-4o",
      });

      expect(result).toEqual({ success: true, data: { result: "world" } });
    });

    test("nothink mode adds reasoning effort none", async () => {
      mockSuccess(makeOpenAIResponsesResponse({ result: "ok" }));

      await callLLMWithTool({
        ...baseOptions,
        provider: "openai-responses",
        model: "gpt-4o",
        nothink: true,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.reasoning).toEqual({ effort: "none" });
    });

    test("falls back on nothink 400 error mentioning reasoning", async () => {
      // First call: 400 with reasoning error
      mockError(400, { error: { message: "reasoning effort not supported" } });
      // Fallback call: success without reasoning
      mockSuccess(makeOpenAIResponsesResponse({ result: "fallback" }));

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-responses",
        model: "gpt-4o",
        nothink: true,
      });

      expect(result).toEqual({
        success: true,
        data: { result: "fallback" },
      });
      // Second call should NOT have reasoning field
      const fallbackBody = JSON.parse(
        mockFetch.mock.calls[1][1]!.body as string,
      );
      expect(fallbackBody.reasoning).toBeUndefined();
    });

    test("sends to /responses endpoint", async () => {
      mockSuccess(makeOpenAIResponsesResponse({ result: "ok" }));

      await callLLMWithTool({
        ...baseOptions,
        provider: "openai-responses",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.test.com/v1/responses");
    });

    test("handles missing function_call in output", async () => {
      mockSuccess({ output: [{ type: "text", text: "no tool" }] });

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-responses",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("parse_error");
      }
    });
  });

  // -- Anthropic -----------------------------------------------------------

  describe("anthropic", () => {
    test("returns parsed tool_use input", async () => {
      mockSuccess(makeAnthropicResponse({ result: "claude" }));

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        apiUrl: "https://api.anthropic.com/v1",
      });

      expect(result).toEqual({ success: true, data: { result: "claude" } });
    });

    test("sends anthropic-version header and x-api-key", async () => {
      mockSuccess(makeAnthropicResponse({ result: "ok" }));

      await callLLMWithTool({
        ...baseOptions,
        provider: "anthropic",
        apiUrl: "https://api.anthropic.com/v1",
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      const headers = opts!.headers as Record<string, string>;
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["x-api-key"]).toBe("test-key-1234");
    });

    test("sends system prompt as top-level field", async () => {
      mockSuccess(makeAnthropicResponse({ result: "ok" }));

      await callLLMWithTool({
        ...baseOptions,
        provider: "anthropic",
        apiUrl: "https://api.anthropic.com/v1",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.system).toBe("You are a test assistant.");
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe("user");
    });

    test("uses input_schema for tool parameters", async () => {
      mockSuccess(makeAnthropicResponse({ result: "ok" }));

      await callLLMWithTool({
        ...baseOptions,
        provider: "anthropic",
        apiUrl: "https://api.anthropic.com/v1",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.tools[0].input_schema).toBeDefined();
      expect(body.tools[0].input_schema.type).toBe("object");
    });

    test("handles missing tool_use in response", async () => {
      mockSuccess({ content: [{ type: "text", text: "no tool" }] });

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "anthropic",
        apiUrl: "https://api.anthropic.com/v1",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("parse_error");
      }
    });
  });

  // -- Gemini --------------------------------------------------------------

  describe("gemini", () => {
    test("returns parsed functionCall args", async () => {
      mockSuccess(makeGeminiResponse({ result: "gemini" }));

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "gemini",
        model: "gemini-2.0-flash",
        apiUrl: "https://generativelanguage.googleapis.com/v1beta",
      });

      expect(result).toEqual({ success: true, data: { result: "gemini" } });
    });

    test("puts API key in query parameter", async () => {
      mockSuccess(makeGeminiResponse({ result: "ok" }));

      await callLLMWithTool({
        ...baseOptions,
        provider: "gemini",
        model: "gemini-2.0-flash",
        apiUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-key-5678",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url as string).toContain("key=gemini-key-5678");
      expect(url as string).toContain(
        "models/gemini-2.0-flash:generateContent",
      );
    });

    test("uses system_instruction and function_declarations", async () => {
      mockSuccess(makeGeminiResponse({ result: "ok" }));

      await callLLMWithTool({
        ...baseOptions,
        provider: "gemini",
        model: "gemini-2.0-flash",
        apiUrl: "https://generativelanguage.googleapis.com/v1beta",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.system_instruction.parts[0].text).toBe(
        "You are a test assistant.",
      );
      expect(body.tools[0].function_declarations).toHaveLength(1);
      expect(body.tool_config.function_calling_config.mode).toBe("ANY");
    });

    test("handles missing functionCall in response", async () => {
      mockSuccess({
        candidates: [{ content: { parts: [{ text: "no tool" }] } }],
      });

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "gemini",
        model: "gemini-2.0-flash",
        apiUrl: "https://generativelanguage.googleapis.com/v1beta",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("parse_error");
      }
    });
  });

  // -- Generic -------------------------------------------------------------

  describe("generic", () => {
    test("returns parsed tool call arguments", async () => {
      mockSuccess(makeOpenAIChatResponse({ result: "generic" }));

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "generic",
        model: "local-model",
      });

      expect(result).toEqual({
        success: true,
        data: { result: "generic" },
      });
    });

    test("nothink mode adds think: false", async () => {
      mockSuccess(makeOpenAIChatResponse({ result: "ok" }));

      await callLLMWithTool({
        ...baseOptions,
        provider: "generic",
        model: "local-model",
        nothink: true,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
      expect(body.think).toBe(false);
    });

    test("sends to /chat/completions endpoint", async () => {
      mockSuccess(makeOpenAIChatResponse({ result: "ok" }));

      await callLLMWithTool({
        ...baseOptions,
        provider: "generic",
        apiUrl: "http://localhost:11434/v1",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:11434/v1/chat/completions");
    });

    test("handles missing tool call arguments", async () => {
      mockSuccess({ choices: [{ message: { tool_calls: [{}] } }] });

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "generic",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("parse_error");
      }
    });
  });

  // -- Retry logic ---------------------------------------------------------

  describe("retry logic", () => {
    test("retries on 429 with Retry-After header", async () => {
      mockError(
        429,
        { error: { message: "rate limited" } },
        {
          "Retry-After": "0",
        },
      );
      mockSuccess(makeOpenAIChatResponse({ result: "retried" }));

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-chat",
      });

      expect(result).toEqual({
        success: true,
        data: { result: "retried" },
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("retries on 500 server error", async () => {
      mockError(500, { error: { message: "internal error" } });
      mockSuccess(makeOpenAIChatResponse({ result: "recovered" }));

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-chat",
      });

      expect(result).toEqual({
        success: true,
        data: { result: "recovered" },
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("returns error after max retries exhausted", async () => {
      // 4 calls total: initial + 3 retries
      for (let i = 0; i < 4; i++) {
        mockError(
          429,
          { error: { message: "rate limited" } },
          {
            "Retry-After": "0",
          },
        );
      }

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-chat",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("rate_limit");
      }
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    test("does not retry on parse_error", async () => {
      // Response with missing tool call -> parse_error
      mockSuccess({ choices: [{ message: {} }] });

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-chat",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("parse_error");
      }
      // Only 1 call -- no retries for parse errors
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test("does not retry on non-retryable 4xx errors", async () => {
      mockError(401, { error: { message: "unauthorized" } });

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-chat",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("api_error");
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // -- Timeout -------------------------------------------------------------

  describe("timeout", () => {
    test("returns timeout error on AbortError", async () => {
      mockFetch.mockImplementation((async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }) as unknown as typeof fetch);

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-chat",
        timeout: 100,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("timeout");
        expect(result.error).toContain("timed out");
      }
    });
  });

  // -- Network error -------------------------------------------------------

  describe("network error", () => {
    test("returns network_error on fetch failure", async () => {
      mockFetch.mockImplementation((async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch);

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-chat",
        timeout: 100,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("network_error");
        expect(result.error).toContain("ECONNREFUSED");
      }
    });
  });

  // -- API key sanitization ----------------------------------------------

  describe("error sanitization", () => {
    test("redacts API key from error messages", async () => {
      mockError(401, {
        error: { message: "Invalid key: test-key-1234" },
      });

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: "openai-chat",
        apiKey: "test-key-1234",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).not.toContain("test-key-1234");
        expect(result.error).toContain("[redacted:1234]");
      }
    });
  });
});
