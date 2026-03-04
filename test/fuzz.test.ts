import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { generateText } from "ai";
import { APICallError, NoObjectGeneratedError } from "ai";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  _resetConfigForTesting,
  _setConfigForTesting,
  ConfigSchema,
} from "../src/config.ts";
import {
  _resetEmbedDepsForTesting,
  _setEmbedDepsForTesting,
  resetEmbedder,
} from "../src/core/ai/embed.ts";
import {
  _resetGenerateDepsForTesting,
  _setGenerateDepsForTesting,
  callLLMWithTool,
} from "../src/core/ai/generate.ts";
import type {
  createEmbeddingProvider,
  createLLMProvider,
} from "../src/core/ai/providers.ts";
import { closeDb, getDb } from "../src/db/database.ts";
import { makeTestConfig } from "./fixtures/config.ts";

const defaultConfig = makeTestConfig({ llm: { apiKey: "test-key-1234" } });

const mockGenerateText = mock(() => Promise.resolve({ output: {} }));
const mockCreateLLMProvider = mock(() =>
  Promise.resolve({ chat: (_id: string) => ({}) }),
);

function seededVector(text: string): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
  }
  const vector = new Array(768);
  for (let i = 0; i < 768; i++) {
    seed = (seed * 1664525 + 1013904223) | 0;
    vector[i] = Math.sin(seed + i) * 0.5;
  }
  return vector;
}

const mockEmbedMany = mock((_opts: { values: string[] }) =>
  Promise.resolve({
    embeddings: _opts.values.map((value) => seededVector(value)),
  }),
);
const mockCreateEmbeddingProvider = mock(() =>
  Promise.resolve({ embedding: (_id: string) => ({}) }),
);

let tmpDir = "";
let addMemory: typeof import("../src/core/memory.ts")["addMemory"];
let searchMemories: typeof import("../src/core/memory.ts")["searchMemories"];

function memoriesTableCount(): number {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as count FROM memories").get() as {
    count: number;
  };
  return row.count;
}

function expectMemoriesTableExists(): void {
  const db = getDb();
  const row = db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'",
    )
    .get() as { name: string } | null;
  expect(row?.name).toBe("memories");
}

function makeNoObjectGeneratedError(message: string): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message,
    text: "malformed output",
    response: {
      id: "resp_fuzz_1",
      timestamp: new Date(),
      modelId: "kimi-k2.5:cloud",
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
    finishReason: "error",
  });
}

describe("fuzz", () => {
  beforeEach(async () => {
    _setConfigForTesting(defaultConfig);
    closeDb();
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-fuzz-"));
    getDb(join(tmpDir, "fuzz.db"));

    mockEmbedMany.mockReset();
    mockCreateEmbeddingProvider.mockReset();
    mockEmbedMany.mockImplementation((_opts: { values: string[] }) =>
      Promise.resolve({
        embeddings: _opts.values.map((value) => seededVector(value)),
      }),
    );
    mockCreateEmbeddingProvider.mockResolvedValue({
      embedding: (_id: string) => ({}),
    });
    _setEmbedDepsForTesting({
      embedMany: mockEmbedMany as unknown as typeof import("ai").embedMany,
      createEmbeddingProvider:
        mockCreateEmbeddingProvider as unknown as typeof createEmbeddingProvider,
    });
    resetEmbedder();

    mockGenerateText.mockReset();
    mockCreateLLMProvider.mockReset();
    mockGenerateText.mockResolvedValue({ output: {} });
    mockCreateLLMProvider.mockResolvedValue({ chat: (_id: string) => ({}) });
    _setGenerateDepsForTesting({
      generateText: mockGenerateText as unknown as typeof generateText,
      createLLMProvider:
        mockCreateLLMProvider as unknown as typeof createLLMProvider,
    });

    const memory = await import(
      `../src/core/memory.ts?fuzz-test=${Date.now()}`
    );
    addMemory = memory.addMemory;
    searchMemories = memory.searchMemories;
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetGenerateDepsForTesting();
    resetEmbedder();
    _resetEmbedDepsForTesting();
    closeDb();
    mock.restore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("handles memory content fuzz inputs without crashing", async () => {
    const inputs = [
      "\u4F60\u597D\u4E16\u754C",
      "\u0627\u0644\u0633\u0644\u0627\u0645",
      "\uD83D\uDE00\uD83D\uDE80\uD83C\uDF0D",
      "e\u0301 combining",
      "hello\u0000world",
      "x".repeat(100 * 1024),
      "",
      "   ",
      "<script>alert(1)</script>",
      "'; DROP TABLE memories; --",
    ];

    for (const content of inputs) {
      const result = await addMemory({
        content,
        containerTag: "fuzz-memory",
      });
      expect(typeof result.id).toBe("string");
      expect(typeof result.deduplicated).toBe("boolean");
    }

    expectMemoriesTableExists();
    expect(memoriesTableCount()).toBeGreaterThan(0);
  });

  test("handles search query fuzz inputs and preserves DB state", async () => {
    await addMemory({
      content: "baseline searchable text",
      containerTag: "fuzz-search",
    });

    const queries = [
      "",
      "a",
      "q".repeat(10_000),
      ".*",
      "[a-z]+",
      "(?:)",
      "' OR 1=1 --",
    ];

    for (const query of queries) {
      const results = await searchMemories(query, "fuzz-search", 10);
      expect(Array.isArray(results)).toBe(true);
    }

    expectMemoriesTableExists();
    expect(memoriesTableCount()).toBeGreaterThan(0);
  });

  test("validates config fuzz cases without throwing", () => {
    const negativePort = {
      ...defaultConfig,
      web: { ...defaultConfig.web, port: -1 },
    };
    const emptyApiKey = {
      ...defaultConfig,
      llm: { ...defaultConfig.llm, apiKey: "" },
    };
    const unknownExtra = {
      ...defaultConfig,
      extraField: true,
    };

    expect(ConfigSchema.safeParse(negativePort).success).toBe(true);
    expect(ConfigSchema.safeParse(emptyApiKey).success).toBe(true);
    expect(ConfigSchema.safeParse(unknownExtra).success).toBe(false);
    expect(ConfigSchema.safeParse({}).success).toBe(false);
  });

  test("handles malformed llm responses with graceful errors", async () => {
    const toolSchema = {
      name: "fuzz_tool",
      description: "fuzz tool",
      parameters: {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
      },
    };

    const malformedMessages = [
      "invalid-json",
      "missing-tool-calls",
      "wrong-argument-type",
    ];

    for (const malformed of malformedMessages) {
      mockGenerateText.mockRejectedValueOnce(
        makeNoObjectGeneratedError(`malformed: ${malformed}`),
      );
      const result = await callLLMWithTool({
        systemPrompt: "sys",
        userPrompt: "user",
        toolSchema,
        provider: "ollama",
        model: "kimi-k2.5:cloud",
        apiUrl: "http://127.0.0.1:11434",
        apiKey: "test-key-1234",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("parse_error");
      }
    }

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
    const rateLimited = await callLLMWithTool({
      systemPrompt: "sys",
      userPrompt: "user",
      toolSchema,
      provider: "ollama",
      model: "kimi-k2.5:cloud",
      apiUrl: "http://127.0.0.1:11434",
      apiKey: "test-key-1234",
    });
    expect(rateLimited.success).toBe(false);
    if (!rateLimited.success) {
      expect(rateLimited.code).toBe("rate_limit");
    }

    expectMemoriesTableExists();
  });
});
