import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { PluginConfig } from "../src/config";
import {
  _resetConfigForTesting,
  ConfigSchema,
  getConfig,
  getConfigErrors,
  getHybridWeights,
} from "../src/config";

// -- ConfigSchema validation -------------------------------------------------

describe("ConfigSchema", () => {
  const validConfig: PluginConfig = {
    llm: {
      provider: "ollama",
      model: "glm-4.6:cloud",
      apiUrl: "http://127.0.0.1:11434",
      apiKey: "",
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
    web: { port: 4747, enabled: true },
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

// -- getHybridWeights --------------------------------------------------------

describe("getHybridWeights", () => {
  function makeConfig(
    quality: PluginConfig["search"]["retrievalQuality"],
    hybridWeights?: { semantic: number; keyword: number },
  ): PluginConfig {
    return {
      llm: {
        provider: "ollama",
        model: "glm-4.6:cloud",
        apiUrl: "http://127.0.0.1:11434",
        apiKey: "",
      },
      embedding: {
        provider: "ollama",
        model: "embeddinggemma:latest",
        apiUrl: "http://127.0.0.1:11434",
        apiKey: "",
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

describe("getConfig", () => {
  let tempRoot = "";
  let xdgConfigBackup: string | undefined;
  let xdgDataBackup: string | undefined;

  function defaultsStoragePath(): string {
    return join(homedir(), ".local", "share", "opencode-flashback");
  }

  function writeConfigFiles(json?: string, jsonc?: string): void {
    const configDir = join(tempRoot, "opencode");
    mkdirSync(configDir, { recursive: true });
    if (json !== undefined) {
      writeFileSync(join(configDir, "opencode-flashback.json"), json);
    }
    if (jsonc !== undefined) {
      writeFileSync(join(configDir, "opencode-flashback.jsonc"), jsonc);
    }
  }

  beforeEach(() => {
    xdgConfigBackup = process.env.XDG_CONFIG_HOME;
    xdgDataBackup = process.env.XDG_DATA_HOME;
    tempRoot = mkdtempSync(join(tmpdir(), "flashback-config-"));
    process.env.XDG_CONFIG_HOME = tempRoot;
    process.env.XDG_DATA_HOME = join(tempRoot, "xdg-data");
    _resetConfigForTesting();
  });

  afterEach(() => {
    if (xdgConfigBackup === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = xdgConfigBackup;
    }

    if (xdgDataBackup === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = xdgDataBackup;
    }

    _resetConfigForTesting();
    rmSync(tempRoot, { recursive: true, force: true });
    mock.restore();
  });

  test("returns defaults when no config files exist", () => {
    const config = getConfig();
    expect(config.storage.path).toBe(
      join(tempRoot, "xdg-data", "opencode-flashback"),
    );
    expect(config.search.retrievalQuality).toBe("balanced");
    expect(config.memory.maxResults).toBe(10);
  });

  test("loads JSONC with comments and preserves comment-like strings", () => {
    writeConfigFiles(
      undefined,
      `{
        // top-level comment
        "llm": {
          "apiKey": "sk-//keep",
          "model": "my-model"
        },
        "storage": {
          "path": "~/custom-db"
        },
        /* inline block comment */
        "search": {
          "retrievalQuality": "custom",
          "hybridWeights": {
            "semantic": 0.9,
            "keyword": 0.1
          }
        }
      }`,
    );

    const config = getConfig();
    expect(config.llm.apiKey).toBe("sk-//keep");
    expect(config.llm.model).toBe("my-model");
    expect(config.storage.path).toBe(join(homedir(), "custom-db"));
    expect(config.search.hybridWeights).toEqual({
      semantic: 0.9,
      keyword: 0.1,
    });
  });

  test("loads JSONC with trailing commas", () => {
    writeConfigFiles(
      undefined,
      `{
        "memory": {
          "autoCapture": false,
        },
        "web": {
          "enabled": false,
        },
      }`,
    );

    const config = getConfig();
    expect(config.memory.autoCapture).toBe(false);
    expect(config.web.enabled).toBe(false);
  });

  test("loads JSONC with escaped quotes in strings", () => {
    writeConfigFiles(
      undefined,
      `{
        "llm": {
          "model": "gpt-\\"edge\\""
        }
      }`,
    );

    const config = getConfig();
    expect(config.llm.model).toBe('gpt-"edge"');
  });

  test("loads JSON config when only json exists", () => {
    writeConfigFiles(
      JSON.stringify({
        web: { port: 5050 },
        memory: { autoCapture: false },
      }),
    );

    const config = getConfig();
    expect(config.web.port).toBe(5050);
    expect(config.memory.autoCapture).toBe(false);
    expect(config.memory.maxResults).toBe(10);
  });

  test("loads JSONC without comments", () => {
    writeConfigFiles(undefined, JSON.stringify({ web: { enabled: false } }));

    const config = getConfig();
    expect(config.web.enabled).toBe(false);
    expect(config.web.port).toBe(4747);
  });

  test("prefers JSONC values over JSON and warns when both exist", () => {
    writeConfigFiles(
      JSON.stringify({
        llm: { model: "json-model", apiKey: "json-key" },
        web: { port: 4001 },
      }),
      JSON.stringify({
        llm: { model: "jsonc-model" },
        web: { enabled: false },
      }),
    );

    const config = getConfig();
    expect(config.llm.model).toBe("jsonc-model");
    expect(config.llm.apiKey).toBe("json-key");
    expect(config.web.port).toBe(4001);
    expect(config.web.enabled).toBe(false);
    const errors = getConfigErrors();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.includes("Both"))).toBe(true);
  });

  test("falls back to defaults on invalid JSON", () => {
    writeConfigFiles("{ invalid");
    const config = getConfig();
    expect(config).toMatchObject({
      llm: { provider: "ollama", model: "glm-4.6:cloud" },
      search: { retrievalQuality: "balanced" },
    });
    expect(config.storage.path).toBe(
      join(tempRoot, "xdg-data", "opencode-flashback"),
    );
  });

  test("falls back to defaults on invalid JSONC", () => {
    writeConfigFiles(undefined, '{\n  "llm": {\n');
    const config = getConfig();
    expect(config.search.retrievalQuality).toBe("balanced");
    expect(config.web.port).toBe(4747);
  });

  test("falls back to defaults for unknown keys because schema is strict", () => {
    writeConfigFiles(
      JSON.stringify({
        llm: { apiKey: "ok" },
        unexpected: true,
      }),
    );

    const config = getConfig();
    expect(config.llm.apiKey).toBe("");
    expect(config.search.retrievalQuality).toBe("balanced");
    const errors = getConfigErrors();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(
      errors.some(
        (e) =>
          e.includes("validation failed") ||
          e.includes("Config validation failed"),
      ),
    ).toBe(true);
  });

  test("deep merges nested objects for partial overrides", () => {
    writeConfigFiles(
      JSON.stringify({
        llm: { apiKey: "partial-key" },
        memory: { injection: "every" },
        web: { port: 8787 },
      }),
    );

    const config = getConfig();
    expect(config.llm.apiKey).toBe("partial-key");
    expect(config.llm.provider).toBe("ollama");
    expect(config.memory.injection).toBe("every");
    expect(config.memory.maxResults).toBe(10);
    expect(config.web.port).toBe(8787);
    expect(config.web.enabled).toBe(true);
  });

  test("falls back when array value overrides object shape", () => {
    writeConfigFiles(
      JSON.stringify({
        search: {
          retrievalQuality: "custom",
          rankingWeights: [1, 2, 3],
        },
      }),
    );

    const config = getConfig();
    expect(config.search.retrievalQuality).toBe("balanced");
  });

  test("uses homedir fallback paths when XDG env vars are unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    _resetConfigForTesting();

    const config = getConfig();
    expect(config.storage.path).toBe(defaultsStoragePath());
  });

  test("loads empty JSONC as invalid input and returns defaults", () => {
    writeConfigFiles(undefined, "");

    const config = getConfig();
    expect(config.web.enabled).toBe(true);
    expect(config.llm.model).toBe("glm-4.6:cloud");
  });

  test("returns cached reference until reset", () => {
    writeConfigFiles(undefined, JSON.stringify({ web: { port: 6060 } }));

    const first = getConfig();
    const second = getConfig();
    expect(second).toBe(first);
    expect(second.web.port).toBe(6060);

    writeConfigFiles(undefined, JSON.stringify({ web: { port: 7070 } }));
    const stillCached = getConfig();
    expect(stillCached.web.port).toBe(6060);

    _resetConfigForTesting();
    const reloaded = getConfig();
    expect(reloaded.web.port).toBe(7070);
  });
});
