import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  _setConfigForTesting,
  _resetConfigForTesting,
  ConfigSchema,
  type PluginConfig,
} from "../config.ts";
import { getDb, closeDb } from "../db/database.ts";
import { callLLMWithTool } from "../core/llm.ts";
import type { pipeline as hfPipeline } from "@huggingface/transformers";
import {
  _setEmbedderDepsForTesting,
  _resetEmbedderDepsForTesting,
  resetEmbedder,
} from "../embed/embedder.ts";

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
const realFetch = globalThis.fetch;

let tmpDir = "";
let realSetTimeout: typeof setTimeout;

let addMemory: (typeof import("../core/memory.ts"))["addMemory"];
let searchMemories: (typeof import("../core/memory.ts"))["searchMemories"];

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

describe("fuzz", () => {
  beforeEach(async () => {
    _setConfigForTesting(defaultConfig);
    closeDb();
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-fuzz-"));
    getDb(join(tmpDir, "fuzz.db"));

    const mockedPipeline = mock(async () => async (inputs: string[]) => {
      const output: Record<string | number, unknown> = {
        dispose: () => {},
      };
      for (let i = 0; i < inputs.length; i++) {
        output[i] = {
          data: Array.from(
            { length: 768 },
            (_, j) => Math.sin(j + inputs[i].length) * 0.5,
          ),
        };
      }
      return output;
    }) as unknown as typeof hfPipeline;
    _setEmbedderDepsForTesting({ pipeline: mockedPipeline });
    resetEmbedder();

    const memory = await import(`../core/memory.ts?fuzz-test=${Date.now()}`);
    addMemory = memory.addMemory;
    searchMemories = memory.searchMemories;

    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    realSetTimeout = globalThis.setTimeout;
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
    resetEmbedder();
    _resetEmbedderDepsForTesting();
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

    const malformedBodies = ['{"choices":[{"message":{"tool_', "", "not json"];

    for (const body of malformedBodies) {
      mockFetch.mockResolvedValueOnce(new Response(body, { status: 200 }));
      const result = await callLLMWithTool({
        systemPrompt: "sys",
        userPrompt: "user",
        toolSchema,
        provider: "openai-chat",
        model: "gpt-4o",
        apiUrl: "https://api.test.com/v1",
        apiKey: "test-key-1234",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe("parse_error");
      }
    }

    const missingToolCalls = { choices: [{ message: {} }] };
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(missingToolCalls), { status: 200 }),
    );
    const missingResult = await callLLMWithTool({
      systemPrompt: "sys",
      userPrompt: "user",
      toolSchema,
      provider: "openai-chat",
      model: "gpt-4o",
      apiUrl: "https://api.test.com/v1",
      apiKey: "test-key-1234",
    });
    expect(missingResult.success).toBe(false);
    if (!missingResult.success) {
      expect(missingResult.code).toBe("parse_error");
    }

    const wrongTypes = {
      choices: [
        { message: { tool_calls: [{ function: { arguments: 123 } }] } },
      ],
    };
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(wrongTypes), { status: 200 }),
    );
    const wrongTypeResult = await callLLMWithTool({
      systemPrompt: "sys",
      userPrompt: "user",
      toolSchema,
      provider: "openai-chat",
      model: "gpt-4o",
      apiUrl: "https://api.test.com/v1",
      apiKey: "test-key-1234",
    });
    expect(wrongTypeResult.success).toBe(false);
    if (!wrongTypeResult.success) {
      expect(wrongTypeResult.code).toBe("parse_error");
    }

    expectMemoriesTableExists();
  });
});
