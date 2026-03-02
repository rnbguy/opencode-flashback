import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ConfigSchema, getHybridWeights } from "../config";
import type { PluginConfig } from "../config";

// ── ConfigSchema validation ─────────────────────────────────────────────────

describe("ConfigSchema", () => {
  const validConfig: PluginConfig = {
    llm: {
      provider: "openai-chat",
      model: "gpt-4o-mini",
      apiUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    },
    storage: { path: "/tmp/test" },
    memory: {
      maxResults: 10,
      autoCapture: true,
      injection: "first",
      excludeCurrentSession: true,
    },
    web: { port: 4747, enabled: true },
    search: { retrievalQuality: "balanced" },
  };

  test("accepts valid config", () => {
    const result = ConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  test("accepts all provider values", () => {
    const providers = [
      "openai-chat",
      "openai-responses",
      "anthropic",
      "gemini",
      "generic",
    ] as const;
    for (const provider of providers) {
      const cfg = { ...validConfig, llm: { ...validConfig.llm, provider } };
      const result = ConfigSchema.safeParse(cfg);
      expect(result.success).toBe(true);
    }
  });

  test("accepts all retrievalQuality values", () => {
    const qualities = ["fast", "balanced", "thorough", "custom"] as const;
    for (const q of qualities) {
      const cfg = {
        ...validConfig,
        search: { retrievalQuality: q },
      };
      const result = ConfigSchema.safeParse(cfg);
      expect(result.success).toBe(true);
    }
  });

  test("accepts all injection values", () => {
    for (const injection of ["first", "every"] as const) {
      const cfg = {
        ...validConfig,
        memory: { ...validConfig.memory, injection },
      };
      const result = ConfigSchema.safeParse(cfg);
      expect(result.success).toBe(true);
    }
  });

  test("accepts custom search with hybridWeights", () => {
    const cfg = {
      ...validConfig,
      search: {
        retrievalQuality: "custom" as const,
        hybridWeights: { semantic: 0.6, keyword: 0.4 },
      },
    };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(true);
  });

  test("accepts search with rankingWeights", () => {
    const cfg = {
      ...validConfig,
      search: {
        retrievalQuality: "balanced" as const,
        rankingWeights: { recency: 0.3, importance: 0.4, semantic: 0.3 },
      },
    };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(true);
  });

  test("rejects invalid provider", () => {
    const cfg = {
      ...validConfig,
      llm: { ...validConfig.llm, provider: "invalid" },
    };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  test("rejects invalid retrievalQuality", () => {
    const cfg = {
      ...validConfig,
      search: { retrievalQuality: "ultra" },
    };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  test("rejects invalid injection value", () => {
    const cfg = {
      ...validConfig,
      memory: { ...validConfig.memory, injection: "never" },
    };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  test("rejects unknown keys in top-level (strict)", () => {
    const cfg = { ...validConfig, extra: "nope" };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  test("rejects unknown keys in nested objects (strict)", () => {
    const cfg = {
      ...validConfig,
      llm: { ...validConfig.llm, temperature: 0.5 },
    };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  test("rejects missing required fields", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects wrong types", () => {
    const cfg = {
      ...validConfig,
      memory: { ...validConfig.memory, maxResults: "ten" },
    };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });

  test("rejects missing llm fields", () => {
    const cfg = { ...validConfig, llm: { provider: "openai-chat" } };
    const result = ConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
  });
});

// ── getHybridWeights ────────────────────────────────────────────────────────

describe("getHybridWeights", () => {
  function makeConfig(
    quality: PluginConfig["search"]["retrievalQuality"],
    hybridWeights?: { semantic: number; keyword: number },
  ): PluginConfig {
    return {
      llm: {
        provider: "openai-chat",
        model: "m",
        apiUrl: "u",
        apiKey: "k",
      },
      storage: { path: "/tmp" },
      memory: {
        maxResults: 10,
        autoCapture: true,
        injection: "first",
        excludeCurrentSession: true,
      },
      web: { port: 4747, enabled: true },
      search: { retrievalQuality: quality, hybridWeights },
    };
  }

  test("fast returns keyword-heavy weights", () => {
    expect(getHybridWeights(makeConfig("fast"))).toEqual({
      semantic: 0.3,
      keyword: 0.7,
    });
  });

  test("balanced returns equal weights", () => {
    expect(getHybridWeights(makeConfig("balanced"))).toEqual({
      semantic: 0.5,
      keyword: 0.5,
    });
  });

  test("thorough returns semantic-heavy weights", () => {
    expect(getHybridWeights(makeConfig("thorough"))).toEqual({
      semantic: 0.7,
      keyword: 0.3,
    });
  });

  test("custom uses provided hybridWeights", () => {
    expect(
      getHybridWeights(makeConfig("custom", { semantic: 0.9, keyword: 0.1 })),
    ).toEqual({ semantic: 0.9, keyword: 0.1 });
  });

  test("custom without hybridWeights falls back to balanced", () => {
    expect(getHybridWeights(makeConfig("custom"))).toEqual({
      semantic: 0.5,
      keyword: 0.5,
    });
  });
});
