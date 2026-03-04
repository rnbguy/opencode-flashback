import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import ISO6391 from "iso-639-1";
import type { LLMCallResult } from "../src/core/ai/generate";
import {
  _resetCaptureDepsForTesting,
  _setCaptureDepsForTesting,
  type CaptureRequest,
  enqueueCapture,
  resetCapture,
} from "../src/core/capture";
import { detectLanguage, getLanguageName } from "../src/util/language";

function makeRequest(overrides?: Partial<CaptureRequest>): CaptureRequest {
  return {
    sessionId: "session-language-test",
    containerTag: "language-test",
    messages: [{ role: "user", content: "Please summarize this work." }],
    directory: "/tmp/language-test",
    ...overrides,
  };
}

async function flushPromises(count = 30): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

describe("detectLanguage fuzzing", () => {
  test("handles diverse fuzz inputs without crashing", async () => {
    const longNaturalLanguage =
      "This is a long natural language sentence intended to exceed fifty characters so language detection can run safely and consistently.";
    const mixedInput =
      "const value = computeScore(userData); The implementation should remain stable under random noisy input.";
    const unicodeInput =
      "\u4F60\u597D \u0645\u0631\u062D\u0628\u0627 \u041F\u0440\u0438\u0432\u0435\u0442 \uD83D\uDE00\uD83D\uDE80";

    const randomAscii = Array.from({ length: 2048 }, () =>
      String.fromCharCode(32 + Math.floor(Math.random() * 95)),
    ).join("");

    const inputs = [
      "",
      "     \t\n",
      "x",
      "x".repeat(100 * 1024),
      "const x = { foo: bar(); }; if (a > b) { return c[d]; }",
      longNaturalLanguage,
      mixedInput,
      unicodeInput,
      "hello\u0000world",
      "a".repeat(50000),
      "'; DROP TABLE memories; --",
      "<script>alert(1)</script>",
      randomAscii,
    ];

    for (const input of inputs) {
      const result = await detectLanguage(input);

      expect(result).toBeDefined();
      expect(["code", "nl", "mixed"]).toContain(result.mode);
      expect(Number.isFinite(result.codeRatio)).toBe(true);
      expect(result.codeRatio).toBeGreaterThanOrEqual(0);

      if (result.detectedLang !== undefined) {
        expect(typeof result.detectedLang).toBe("string");
      }
    }
  }, 20000);
});

describe("detectLanguage properties", () => {
  test("classifies code-heavy inputs as code", async () => {
    for (let i = 0; i < 40; i++) {
      const heavySymbols = "{}[]<>()".repeat(30 + i);
      const text = `${heavySymbols} valueName item_one computeValue() finalToken`;
      const result = await detectLanguage(text);

      expect(result.codeRatio).toBeGreaterThan(0.3);
      expect(result.mode).toBe("code");
    }
  });

  test("returns deterministic result for empty and whitespace input", async () => {
    const samples = ["", " ", "\t", "\n\n", "   \t   "];

    for (const sample of samples) {
      await expect(detectLanguage(sample)).resolves.toEqual({
        mode: "nl",
        codeRatio: 0,
        detectedLang: "en",
      });
    }
  });

  test("short low-code text stays mixed", async () => {
    const shortSamples = [
      "quick status update",
      "ship docs now",
      "ok lets test this",
      "forty chars should still be mixed text",
    ];

    for (const text of shortSamples) {
      expect(text.length).toBeLessThan(50);
      const result = await detectLanguage(text);
      expect(result.codeRatio).toBeLessThan(0.1);
      expect(result.mode).toBe("mixed");
    }
  });

  test("codeRatio always stays in [0, 1) for non-empty inputs", async () => {
    const generated: string[] = [];

    for (let i = 0; i < 60; i++) {
      const length = 1 + Math.floor(Math.random() * 400);
      const value = Array.from({ length }, (_, idx) => {
        const bucket = (idx + i) % 6;
        if (bucket === 0) return "{";
        if (bucket === 1) return "}";
        if (bucket === 2) return "_";
        if (bucket === 3) return "a";
        if (bucket === 4) return "B";
        return " ";
      }).join("");
      generated.push(value);
    }

    generated.push("a");
    generated.push("{a}");
    generated.push("camelCase");
    generated.push("snake_case");

    for (const text of generated) {
      expect(text.length).toBeGreaterThan(0);
      const result = await detectLanguage(text);
      expect(result.codeRatio).toBeGreaterThanOrEqual(0);
      expect(result.codeRatio).toBeLessThanOrEqual(1);
    }
  });
});

describe("getLanguageName properties", () => {
  test("returns non-empty names for all valid ISO 639-1 codes", () => {
    const codes = ISO6391.getAllCodes();

    for (const code of codes) {
      const name = getLanguageName(code);
      expect(typeof name).toBe("string");
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  test("matches ISO6391.getName for all valid codes", () => {
    const codes = ISO6391.getAllCodes();

    for (const code of codes) {
      expect(getLanguageName(code)).toBe(ISO6391.getName(code));
    }
  });

  test("falls back to English for invalid codes", () => {
    const invalidCodes = [
      "xx",
      "zz",
      "abc",
      "123",
      "",
      " ",
      "0",
      "9z",
      "x1",
      "_",
      "--",
      "EN",
      "eng",
      "e",
      "   ",
      "!",
      "@@",
      "*a",
      "na1",
      "??",
    ];

    for (const code of invalidCodes) {
      expect(getLanguageName(code)).toBe("English");
    }
  });
});

describe("capture language prompt integration", () => {
  const mockAddMemory = mock(
    async (_opts: unknown) =>
      ({ id: "mem-language", deduplicated: false }) as {
        id: string;
        deduplicated: boolean;
      },
  );
  const mockStorePrompt = mock(
    (_sid: string, _mid: string, _content: string, _dir: string) =>
      "prompt-language",
  );
  const mockGetLastUncaptured = mock(
    (_sid: string) =>
      ({
        id: "prompt-language",
        sessionId: "session-language-test",
        messageId: "msg-language",
        content: "Please summarize this work.",
        directory: "/tmp/language-test",
        isCaptured: false,
        isUserLearningCaptured: false,
      }) as {
        id: string;
        sessionId: string;
        messageId: string;
        content: string;
        directory: string;
        isCaptured: boolean;
        isUserLearningCaptured: boolean;
      },
  );
  const mockMarkCaptured = mock((_pid: string, _mid: string) => {});
  const mockMarkAnalyzed = mock((_pid: string) => {});
  let realSetTimeout: typeof setTimeout;

  beforeEach(() => {
    realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      _ms?: number,
      ...args: unknown[]
    ) => {
      return realSetTimeout(fn, 0, ...args);
    }) as typeof setTimeout;
    resetCapture();
  });

  afterEach(async () => {
    await flushPromises();
    globalThis.setTimeout = realSetTimeout;
    resetCapture();
    _resetCaptureDepsForTesting();
    mock.restore();
  });

  test("injects detected language into system prompt", async () => {
    const callLLMSpy = mock(async (opts: unknown): Promise<LLMCallResult> => {
      const parsed = opts as { systemPrompt: string };
      expect(parsed.systemPrompt).toContain("French");
      expect(parsed.systemPrompt).toContain(
        "You MUST write the summary in French",
      );
      expect(parsed.systemPrompt).toContain("in French]");

      return {
        success: true,
        data: {
          summary: "## Request\nTest\n\n## Outcome\nDone",
          type: "feature",
          tags: ["language"],
          importance: 5,
          confidence: 0.9,
          evidenceCount: 1,
        },
      };
    });

    _setCaptureDepsForTesting({
      addMemory: mockAddMemory,
      callLLMWithTool: callLLMSpy,
      storePrompt: mockStorePrompt,
      getLastUncapturedPrompt: mockGetLastUncaptured,
      markCaptured: mockMarkCaptured,
      markAnalyzed: mockMarkAnalyzed,
      detectLanguage: mock(async (_text: string) => ({
        mode: "nl" as const,
        codeRatio: 0,
        detectedLang: "fr",
      })),
      getLanguageName: mock((_code: string) => "French"),
    });

    enqueueCapture(makeRequest());
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    await flushPromises();

    expect(callLLMSpy).toHaveBeenCalledTimes(1);
  });
});
