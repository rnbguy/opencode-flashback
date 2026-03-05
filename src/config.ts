import { deepmerge } from "deepmerge-ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import type { ParseError } from "jsonc-parser";
import { parse as parseJsonc } from "jsonc-parser";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import type { LlmConfig } from "./types";
import { getLogger } from "./util/logger.ts";
import { expandPath } from "./util/path";

// -- XDG path helpers ---------------------------------------------------------

function getConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return join(xdgConfigHome, "opencode");
  }
  return join(homedir(), ".config", "opencode");
}

function getDataDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome) {
    return join(xdgDataHome, "opencode-flashback");
  }
  return join(homedir(), ".local", "share", "opencode-flashback");
}

function parseJsoncStrict(content: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    throw new Error(JSON.stringify(errors));
  }
  return parsed as Record<string, unknown>;
}

// -- Zod schema ---------------------------------------------------------------

export const ConfigSchema = z
  .object({
    llm: z
      .object({
        provider: z.enum([
          "openai-chat",
          "openai-responses",
          "anthropic",
          "gemini",
          "generic",
          "ollama",
        ]),
        model: z.string(),
        apiUrl: z.string(),
        apiKey: z.string(),
      })
      .strict(),
    embedding: z
      .object({
        provider: z.enum([
          "openai-chat",
          "openai-responses",
          "anthropic",
          "gemini",
          "generic",
          "ollama",
        ]),
        model: z.string(),
        apiUrl: z.string(),
        apiKey: z.string(),
      })
      .strict()
      .optional()
      .default({
        provider: "ollama",
        model: "embeddinggemma:latest",
        apiUrl: "http://127.0.0.1:11434",
        apiKey: "",
      }),
    storage: z
      .object({
        path: z.string(),
      })
      .strict(),
    logLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
    memory: z
      .object({
        maxResults: z.number(),
        autoCapture: z.boolean(),
        injection: z.enum(["first", "every"]),
        excludeCurrentSession: z.boolean(),
        maxAgeDays: z.number().optional(),
      })
      .strict(),
    web: z
      .object({
        port: z.number(),
        enabled: z.boolean(),
      })
      .strict(),
    search: z
      .object({
        retrievalQuality: z.enum(["fast", "balanced", "thorough", "custom"]),
        hybridWeights: z
          .object({
            semantic: z.number(),
            keyword: z.number(),
          })
          .optional(),
        rankingWeights: z
          .object({
            recency: z.number(),
            importance: z.number(),
            semantic: z.number(),
          })
          .optional(),
      })
      .strict(),
    toasts: z
      .object({
        autoCapture: z.boolean(),
        userProfile: z.boolean(),
        errors: z.boolean(),
      })
      .strict(),
    compaction: z
      .object({
        enabled: z.boolean(),
        memoryLimit: z.number(),
      })
      .strict(),
  })
  .strict();

export type PluginConfig = z.input<typeof ConfigSchema>;

// -- Config loader -----------------------------------------------------------

function generateDefaultConfig(path: string, defaults: PluginConfig): void {
  const lines = [
    "{",
    "  // JSON Schema for validation and editor autocompletion",
    '  "$schema": "https://raw.githubusercontent.com/rnbguy/opencode-flashback/main/schema.json",',
    "",
    "  // LLM provider for auto-capture and summarization",
    '  "llm": {',
    `    "provider": "${defaults.llm.provider}",`,
    `    "model": "${defaults.llm.model}",`,
    `    "apiUrl": "${defaults.llm.apiUrl}",`,
    '    // Use "env://OPENAI_API_KEY" or "file://~/.secrets/openai.txt"',
    `    "apiKey": "${defaults.llm.apiKey}"`,
    "  },",
    "",
    "  // Embedding provider for semantic search vectors",
    '  "embedding": {',
    `    "provider": "${defaults.embedding?.provider ?? "ollama"}",`,
    `    "model": "${defaults.embedding?.model ?? "embeddinggemma:latest"}",`,
    `    "apiUrl": "${defaults.embedding?.apiUrl ?? "http://127.0.0.1:11434"}",`,
    "    // Placeholder for local Ollama embedding endpoint",
    `    "apiKey": "${defaults.embedding?.apiKey ?? ""}"`,
    "  },",
    "",
    "  // Local storage path for memories and database",
    '  "storage": {',
    '    "path": "~/.local/share/opencode-flashback"',
    "  },",
    "",
    "  // Logging level: debug, info, warn, error",
    `  "logLevel": "${defaults.logLevel}",`,
    "",
    "  // Memory retrieval settings",
    '  "memory": {',
    `    "maxResults": ${defaults.memory.maxResults},`,
    `    "autoCapture": ${defaults.memory.autoCapture},`,
    `    "injection": "${defaults.memory.injection}",`,
    `    "excludeCurrentSession": ${defaults.memory.excludeCurrentSession}`,
    "  },",
    "",
    "  // Web UI settings",
    '  "web": {',
    `    "port": ${defaults.web.port},`,
    `    "enabled": ${defaults.web.enabled}`,
    "  },",
    "",
    "  // Search quality preset: fast, balanced, thorough, custom",
    '  "search": {',
    `    "retrievalQuality": "${defaults.search.retrievalQuality}"`,
    "  },",
    "",
    "  // Toast notification toggles",
    '  "toasts": {',
    `    "autoCapture": ${defaults.toasts.autoCapture},`,
    `    "userProfile": ${defaults.toasts.userProfile},`,
    `    "errors": ${defaults.toasts.errors}`,
    "  },",
    "",
    "  // Post-compaction memory re-injection",
    '  "compaction": {',
    `    "enabled": ${defaults.compaction.enabled},`,
    `    "memoryLimit": ${defaults.compaction.memoryLimit}`,
    "  }",
    "}",
  ];

  try {
    mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  } catch {
    // Best-effort -- read-only filesystem or permissions issue
  }
}

let _configErrors: string[] = [];

export function getConfigErrors(): string[] {
  return _configErrors;
}

function loadConfigFile(): PluginConfig {
  const logger = getLogger();
  const configDir = getConfigDir();
  const jsonPath = join(configDir, "opencode-flashback.json");
  const jsoncPath = join(configDir, "opencode-flashback.jsonc");

  const llmDefaults: LlmConfig = {
    provider: "ollama",
    model: "glm-4.6:cloud",
    apiUrl: "http://127.0.0.1:11434",
    apiKey: "",
  };

  const defaults: PluginConfig = {
    llm: llmDefaults,
    embedding: {
      provider: "ollama",
      model: "embeddinggemma:latest",
      apiUrl: "http://127.0.0.1:11434",
      apiKey: "",
    },
    storage: {
      path: getDataDir(),
    },
    logLevel: "info",
    memory: {
      maxResults: 10,
      autoCapture: true,
      injection: "first",
      excludeCurrentSession: true,
    },
    web: {
      port: 4747,
      enabled: true,
    },
    search: {
      retrievalQuality: "balanced",
    },
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

  const jsonExists = existsSync(jsonPath);
  const jsoncExists = existsSync(jsoncPath);
  const loadedConfigFiles: string[] = [];

  if (!jsonExists && !jsoncExists) {
    generateDefaultConfig(jsoncPath, defaults);
    logger.debug("loadConfigFile using defaults", { source: "using defaults" });
    return defaults;
  }

  let config = { ...defaults };

  _configErrors = [];

  if (jsonExists && jsoncExists) {
    _configErrors.push(
      "Both opencode-flashback.json and .jsonc found. Using .jsonc values where they overlap.",
    );
    logger.warn("Both opencode-flashback.json and .jsonc found");

    try {
      const jsonContent = readFileSync(jsonPath, "utf-8");
      const jsonData = JSON.parse(jsonContent);
      config = deepmerge(config, jsonData) as PluginConfig;
      loadedConfigFiles.push("opencode-flashback.json");
    } catch (err) {
      const msg = `Failed to parse opencode-flashback.json: ${err instanceof Error ? err.message : String(err)}`;
      _configErrors.push(msg);
      logger.error("loadConfigFile parse failed", {
        source: "opencode-flashback.json",
      });
    }

    try {
      const jsoncContent = readFileSync(jsoncPath, "utf-8");
      const jsoncData = parseJsoncStrict(jsoncContent);
      config = deepmerge(config, jsoncData) as PluginConfig;
      loadedConfigFiles.push("opencode-flashback.jsonc");
    } catch (err) {
      const msg = `Failed to parse opencode-flashback.jsonc: ${err instanceof Error ? err.message : String(err)}`;
      _configErrors.push(msg);
      logger.error("loadConfigFile parse failed", {
        source: "opencode-flashback.jsonc",
      });
    }
  } else if (jsoncExists) {
    try {
      const jsoncContent = readFileSync(jsoncPath, "utf-8");
      const jsoncData = parseJsoncStrict(jsoncContent);
      config = deepmerge(config, jsoncData) as PluginConfig;
      loadedConfigFiles.push("opencode-flashback.jsonc");
    } catch (err) {
      const msg = `Failed to parse opencode-flashback.jsonc: ${err instanceof Error ? err.message : String(err)}`;
      _configErrors.push(msg);
      logger.error("loadConfigFile parse failed", {
        source: "opencode-flashback.jsonc",
      });
    }
  } else if (jsonExists) {
    try {
      const jsonContent = readFileSync(jsonPath, "utf-8");
      const jsonData = JSON.parse(jsonContent);
      config = deepmerge(config, jsonData) as PluginConfig;
      loadedConfigFiles.push("opencode-flashback.json");
    } catch (err) {
      const msg = `Failed to parse opencode-flashback.json: ${err instanceof Error ? err.message : String(err)}`;
      _configErrors.push(msg);
      logger.error("loadConfigFile parse failed", {
        source: "opencode-flashback.json",
      });
    }
  }

  if (loadedConfigFiles.length > 0) {
    logger.debug("loadConfigFile loaded config", {
      source: loadedConfigFiles.join(", "),
    });
  } else {
    logger.debug("loadConfigFile using defaults", { source: "using defaults" });
  }

  // Expand storage path
  config.storage.path = expandPath(config.storage.path);

  // Strip $schema key before validation (schema uses .strict())
  const { $schema: _, ...configWithoutSchema } = config as Record<
    string,
    unknown
  > & { $schema?: string };

  // Validate against schema
  const result = ConfigSchema.safeParse(configWithoutSchema);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    _configErrors.push(`Config validation failed: ${issues}`);
    logger.error("loadConfigFile validation failed", { issues });

    // Backup invalid config files and regenerate defaults
    for (const source of loadedConfigFiles) {
      const sourcePath = join(configDir, source);
      const bakPath = sourcePath + ".bak";
      try {
        const content = readFileSync(sourcePath, "utf-8");
        writeFileSync(bakPath, content, "utf-8");
        logger.warn("loadConfigFile backed up invalid config", {
          source: sourcePath,
          backup: bakPath,
        });
      } catch {
        // best-effort backup -- read-only filesystem or permissions issue
      }
    }
    generateDefaultConfig(jsoncPath, defaults);

    return defaults;
  }

  return result.data;
}

// -- Lazy config getter -------------------------------------------------------

let _config: PluginConfig | null = null;

export function getConfig(): PluginConfig {
  if (_config === null) {
    _config = loadConfigFile();
  }
  return _config;
}

/** @internal - test-only: override the config singleton */
export function _setConfigForTesting(config: PluginConfig): void {
  _config = config;
}

/** @internal - test-only: reset the config singleton */
export function _resetConfigForTesting(): void {
  _config = null;
}

// -- Retrieval quality preset mapping -----------------------------------------

export function getHybridWeights(config: PluginConfig): {
  semantic: number;
  keyword: number;
} {
  const quality = config.search.retrievalQuality;

  switch (quality) {
    case "fast":
      return { semantic: 0.3, keyword: 0.7 };
    case "balanced":
      return { semantic: 0.5, keyword: 0.5 };
    case "thorough":
      return { semantic: 0.7, keyword: 0.3 };
    case "custom":
      return config.search.hybridWeights || { semantic: 0.5, keyword: 0.5 };
    default:
      return { semantic: 0.5, keyword: 0.5 };
  }
}

export function isConfigured(): boolean {
  const config = getConfig();
  if (config.llm.provider === "ollama") return true;
  const key = config.llm.apiKey;
  if (key.length === 0) return false;
  // Check if secret reference resolves to a non-empty value
  if (key.startsWith("env://")) {
    return (process.env[key.slice(6)] ?? "").length > 0;
  }
  if (key.startsWith("file://")) {
    return existsSync(expandPath(key.slice(7)));
  }
  return true;
}
