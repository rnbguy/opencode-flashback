import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  mock,
} from "bun:test";
import {
  _setConfigForTesting,
  _resetConfigForTesting,
  type PluginConfig,
} from "../config.ts";
import { callLLMWithTool } from "../core/llm.ts";
import type { LLMCallOptions } from "../core/llm.ts";
import type { LLMProvider } from "../types.ts";

const defaultConfig: PluginConfig = {
  llm: {
    provider: "openai-chat",
    model: "gpt-4o-mini",
    apiUrl: "https://api.openai.com/v1",
    apiKey: "test-key-1234",
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

const mockFetch = mock<typeof fetch>();
const realSetTimeout = globalThis.setTimeout;
const realFetch = globalThis.fetch;

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

type ProviderCase = {
  provider: LLMProvider;
  model: string;
  apiUrl: string;
  body: unknown;
};

const providerCases: ProviderCase[] = [
  {
    provider: "openai-chat",
    model: "gpt-4o",
    apiUrl: "https://api.test.com/v1",
    body: {
      choices: [
        {
          message: {
            tool_calls: [{ function: { arguments: '{"result":"hello"}' } }],
          },
        },
      ],
    },
  },
  {
    provider: "openai-responses",
    model: "gpt-4o",
    apiUrl: "https://api.test.com/v1",
    body: {
      output: [{ type: "function_call", arguments: '{"result":"hello"}' }],
    },
  },
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    apiUrl: "https://api.anthropic.com/v1",
    body: {
      content: [{ type: "tool_use", input: { result: "hello" } }],
    },
  },
  {
    provider: "gemini",
    model: "gemini-2.0-flash",
    apiUrl: "https://generativelanguage.googleapis.com/v1beta",
    body: {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { args: { result: "hello" } } }],
          },
        },
      ],
    },
  },
  {
    provider: "generic",
    model: "local-model",
    apiUrl: "http://localhost:11434/v1",
    body: {
      choices: [
        {
          message: {
            tool_calls: [{ function: { arguments: '{"result":"hello"}' } }],
          },
        },
      ],
    },
  },
];

describe("provider conformance", () => {
  beforeEach(() => {
    _setConfigForTesting(defaultConfig);
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
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
    globalThis.fetch = realFetch;
  });

  afterAll(() => {
    mock.restore();
  });

  test("normalizes successful tool call output across providers", async () => {
    for (const providerCase of providerCases) {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(providerCase.body), { status: 200 }),
      );

      const result = await callLLMWithTool({
        ...baseOptions,
        provider: providerCase.provider,
        model: providerCase.model,
        apiUrl: providerCase.apiUrl,
      });

      expect(result).toEqual({ success: true, data: { result: "hello" } });
    }
  });

  test("normalizes 429 responses as rate_limit", async () => {
    mockFetch.mockImplementation(
      (async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
        })) as unknown as typeof fetch,
    );

    const result = await callLLMWithTool({
      ...baseOptions,
      provider: "openai-chat",
      model: "gpt-4o",
      apiUrl: "https://api.test.com/v1",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("rate_limit");
    }
  });

  test("normalizes 500 responses as api_error", async () => {
    mockFetch.mockImplementation(
      (async () =>
        new Response(JSON.stringify({ error: { message: "internal" } }), {
          status: 500,
        })) as unknown as typeof fetch,
    );

    const result = await callLLMWithTool({
      ...baseOptions,
      provider: "openai-chat",
      model: "gpt-4o",
      apiUrl: "https://api.test.com/v1",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("api_error");
    }
  });

  test("normalizes network failures as network_error", async () => {
    mockFetch.mockImplementation((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);

    const result = await callLLMWithTool({
      ...baseOptions,
      provider: "openai-chat",
      model: "gpt-4o",
      apiUrl: "https://api.test.com/v1",
      timeout: 100,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("network_error");
    }
  });
});
