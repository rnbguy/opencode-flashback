import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import type {
  LlmConfig,
  MemoryConfig,
  SearchConfig,
  StorageConfig,
  WebConfig,
} from "./types";

// -- JSONC comment stripping --------------------------------------------------

function stripJsoncComments(content: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let inSingleLineComment = false;
  let inMultiLineComment = false;

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (!inSingleLineComment && !inMultiLineComment) {
      if (char === '"') {
        let backslashCount = 0;
        let j = i - 1;
        while (j >= 0 && content[j] === "\\") {
          backslashCount++;
          j--;
        }
        if (backslashCount % 2 === 0) {
          inString = !inString;
        }
        result += char;
        i++;
        continue;
      }
    }

    if (inString) {
      result += char;
      i++;
      continue;
    }

    if (!inSingleLineComment && !inMultiLineComment) {
      if (char === "/" && nextChar === "/") {
        inSingleLineComment = true;
        i += 2;
        continue;
      }
      if (char === "/" && nextChar === "*") {
        inMultiLineComment = true;
        i += 2;
        continue;
      }
    }

    if (inSingleLineComment) {
      if (char === "\n") {
        inSingleLineComment = false;
        result += char;
      }
      i++;
      continue;
    }

    if (inMultiLineComment) {
      if (char === "*" && nextChar === "/") {
        inMultiLineComment = false;
        i += 2;
        continue;
      }
      if (char === "\n") {
        result += char;
      }
      i++;
      continue;
    }

    result += char;
    i++;
  }

  return result.replace(/,\s*([}\]])/g, "$1");
}

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

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~") {
    return homedir();
  }
  return path;
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
        ]),
        model: z.string(),
        apiUrl: z.string(),
        apiKey: z.string(),
      })
      .strict(),
    storage: z
      .object({
        path: z.string(),
      })
      .strict(),
    memory: z
      .object({
        maxResults: z.number(),
        autoCapture: z.boolean(),
        injection: z.enum(["first", "every"]),
        excludeCurrentSession: z.boolean(),
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
  })
  .strict();

export type PluginConfig = z.infer<typeof ConfigSchema>;

// -- Config loader -----------------------------------------------------------

function generateDefaultConfig(path: string, defaults: PluginConfig): void {
  const lines = [
    "{",
    "  // JSON Schema for validation and editor autocompletion",
    "  \"$schema\": \"https://raw.githubusercontent.com/rnbguy/opencode-flashback/main/schema.json\",",
    "",
    "  // LLM provider for auto-capture and summarization",
    "  \"llm\": {",
    `    \"provider\": \"${defaults.llm.provider}\",`,
    `    \"model\": \"${defaults.llm.model}\",`,
    `    \"apiUrl\": \"${defaults.llm.apiUrl}\",`,
    "    // Use \"env://OPENAI_API_KEY\" or \"file://~/.secrets/openai.txt\"",
    `    \"apiKey\": \"${defaults.llm.apiKey}\"`,
    "  },",
    "",
    "  // Local storage path for memories and database",
    "  \"storage\": {",
    "    \"path\": \"~/.local/share/opencode-flashback\"",
    "  },",
    "",
    "  // Memory retrieval settings",
    "  \"memory\": {",
    `    \"maxResults\": ${defaults.memory.maxResults},`,
    `    \"autoCapture\": ${defaults.memory.autoCapture},`,
    `    \"injection\": \"${defaults.memory.injection}\",`,
    `    \"excludeCurrentSession\": ${defaults.memory.excludeCurrentSession}`,
    "  },",
    "",
    "  // Web UI settings",
    "  \"web\": {",
    `    \"port\": ${defaults.web.port},`,
    `    \"enabled\": ${defaults.web.enabled}`,
    "  },",
    "",
    "  // Search quality preset: fast, balanced, thorough, custom",
    "  \"search\": {",
    `    \"retrievalQuality\": \"${defaults.search.retrievalQuality}\"`,
    "  }",
    "}",
  ];

  try {
    mkdirSync(path.replace(/\/[^\/]+$/, ""), { recursive: true });
    writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  } catch {
    // Best-effort -- read-only filesystem or permissions issue
  }
}

function loadConfigFile(): PluginConfig {
  const configDir = getConfigDir();
  const jsonPath = join(configDir, "opencode-flashback.json");
  const jsoncPath = join(configDir, "opencode-flashback.jsonc");

  const defaults: PluginConfig = {
    llm: {
      provider: "openai-chat",
      model: "gpt-4o-mini",
      apiUrl: "https://api.openai.com/v1",
      apiKey: "",
    },
    storage: {
      path: getDataDir(),
    },
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
  };

  const jsonExists = existsSync(jsonPath);
  const jsoncExists = existsSync(jsoncPath);

  if (!jsonExists && !jsoncExists) {
    generateDefaultConfig(jsoncPath, defaults);
    return defaults;
  }

  let config = { ...defaults };

  if (jsonExists && jsoncExists) {
    console.warn(
      "Both opencode-flashback.json and .jsonc found. Using .jsonc values where they overlap.",
    );

    try {
      const jsonContent = readFileSync(jsonPath, "utf-8");
      const jsonData = JSON.parse(jsonContent);
      config = deepMerge(config, jsonData);
    } catch (err) {
      console.error("Failed to parse opencode-flashback.json:", err);
    }

    try {
      const jsoncContent = readFileSync(jsoncPath, "utf-8");
      const cleanedContent = stripJsoncComments(jsoncContent);
      const jsoncData = JSON.parse(cleanedContent);
      config = deepMerge(config, jsoncData);
    } catch (err) {
      console.error("Failed to parse opencode-flashback.jsonc:", err);
    }
  } else if (jsoncExists) {
    try {
      const jsoncContent = readFileSync(jsoncPath, "utf-8");
      const cleanedContent = stripJsoncComments(jsoncContent);
      const jsoncData = JSON.parse(cleanedContent);
      config = deepMerge(config, jsoncData);
    } catch (err) {
      console.error("Failed to parse opencode-flashback.jsonc:", err);
    }
  } else if (jsonExists) {
    try {
      const jsonContent = readFileSync(jsonPath, "utf-8");
      const jsonData = JSON.parse(jsonContent);
      config = deepMerge(config, jsonData);
    } catch (err) {
      console.error("Failed to parse opencode-flashback.json:", err);
    }
  }

  // Expand storage path
  config.storage.path = expandPath(config.storage.path);

  // Validate against schema
  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    console.error("Config validation failed:", result.error.issues);
    return defaults;
  }

  return result.data;
}

function deepMerge(
  target: PluginConfig,
  source: Record<string, unknown>,
): PluginConfig {
  const result = { ...target } as Record<string, unknown>;

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = result[key];

      if (
        sourceValue &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMerge(
          targetValue as PluginConfig,
          sourceValue as Record<string, unknown>,
        );
      } else {
        result[key] = sourceValue;
      }
    }
  }

  return result as PluginConfig;
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
