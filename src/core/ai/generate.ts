import {
  APICallError,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
} from "ai";
import { getConfig } from "../../config";
import type { LLMProvider } from "../../types";
import { resolveSecret } from "../../util/secrets";
import { buildStructuredPrompt } from "./prompts";
import { createLLMProvider } from "./providers";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TEMPERATURE = 0.3;
const MAX_RETRIES = 3;
const VALIDATE_TIMEOUT_MS = 5_000;

const ERROR_TIMEOUT = "timeout" as const;
const ERROR_RATE_LIMIT = "rate_limit" as const;
const ERROR_API = "api_error" as const;
const ERROR_PARSE = "parse_error" as const;
const ERROR_NETWORK = "network_error" as const;

const MESSAGE_REQUEST_TIMEOUT = "Request timed out";
const MESSAGE_LLM_REQUEST_FAILED = "LLM request failed";
const MESSAGE_VALIDATION_TIMEOUT = "LLM endpoint validation timed out";
const MESSAGE_VALIDATION_UNREACHABLE_PREFIX = "LLM endpoint unreachable: ";
const MESSAGE_INVALID_API_KEY = "Invalid or unauthorized API key";
const MESSAGE_MODEL_NOT_FOUND = "Model not found";

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMCallOptions {
  systemPrompt: string;
  userPrompt: string;
  toolSchema: ToolSchema;
  provider?: LLMProvider;
  model?: string;
  apiUrl?: string;
  apiKey?: string;
  timeout?: number;
  nothink?: boolean;
  temperature?: number;
}

export type LLMCallResult =
  | { success: true; data: Record<string, unknown> }
  | {
      success: false;
      error: string;
      code:
        | "timeout"
        | "rate_limit"
        | "api_error"
        | "parse_error"
        | "network_error";
    };

type LLMErrorCode =
  | "timeout"
  | "rate_limit"
  | "api_error"
  | "parse_error"
  | "network_error";

interface GenerateDeps {
  generateText: typeof generateText;
  createLLMProvider: typeof createLLMProvider;
  fetch: typeof fetch;
}

let deps: GenerateDeps = {
  generateText,
  createLLMProvider,
  fetch: globalThis.fetch,
};

export function _setGenerateDepsForTesting(
  overrides: Partial<GenerateDeps>,
): void {
  deps = { ...deps, ...overrides };
}

export function _resetGenerateDepsForTesting(): void {
  deps = {
    generateText,
    createLLMProvider,
    fetch: globalThis.fetch,
  };
}

export async function callLLMWithTool(
  options: LLMCallOptions,
): Promise<LLMCallResult> {
  const config = getConfig();
  const provider = options.provider ?? config.llm.provider;
  const model = options.model ?? config.llm.model;
  const apiUrl = options.apiUrl ?? config.llm.apiUrl;
  const rawApiKey = options.apiKey ?? config.llm.apiKey;
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const nothink = options.nothink ?? true;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const effectiveTemperature = nothink ? 0 : temperature;
  const resolvedApiKey = await resolveSecret(rawApiKey);

  try {
    const providerFactory = await deps.createLLMProvider({
      provider,
      model,
      apiUrl,
      apiKey: rawApiKey,
    });

    const prompt = buildStructuredPrompt(
      options.userPrompt,
      options.toolSchema,
    );

    const result = await deps.generateText({
      model: providerFactory.chat(model),
      system: options.systemPrompt,
      prompt,
      temperature: effectiveTemperature,
      maxRetries: MAX_RETRIES,
      abortSignal: AbortSignal.timeout(timeoutMs),
      output: Output.object({
        schema: jsonSchema(options.toolSchema.parameters),
      }),
    });

    if (!isRecord(result.output)) {
      return {
        success: false,
        error: "Generated output is not a JSON object",
        code: ERROR_PARSE,
      };
    }

    return {
      success: true,
      data: result.output,
    };
  } catch (error) {
    const mapped = mapGenerateError(error);
    return {
      success: false,
      error: sanitizeError(mapped.error, resolvedApiKey),
      code: mapped.code,
    };
  }
}

// -- Lightweight fetch-based endpoint validation -----------------------------

const ANTHROPIC_VERSION = "2023-06-01";
const OLLAMA_V1_SUFFIX = "/v1";

function buildModelsRequest(
  provider: LLMProvider,
  apiUrl: string,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  switch (provider) {
    case "ollama":
      return {
        url: `${apiUrl}${OLLAMA_V1_SUFFIX}/models`,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      };
    case "openai-chat":
    case "openai-responses":
    case "generic":
      return {
        url: `${apiUrl}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    case "anthropic":
      return {
        url: `${apiUrl}/models`,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
      };
    case "gemini":
      return {
        url: `${apiUrl}/models?key=${apiKey}`,
        headers: {},
      };
    default: {
      const _unreachable: never = provider;
      throw new Error(`Unsupported provider: ${_unreachable}`);
    }
  }
}

export async function getAvailableModels(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const config = getConfig();
  const resolvedKey = await resolveSecret(config.llm.apiKey);
  const { url, headers } = buildModelsRequest(
    config.llm.provider,
    config.llm.apiUrl,
    resolvedKey,
  );

  try {
    const response = await deps.fetch(url, {
      headers,
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });

    if (response.ok) {
      return { ok: true };
    }

    return {
      ok: false,
      error: formatValidationError(
        response.status,
        response.statusText,
        resolvedKey,
      ),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return { ok: false, error: MESSAGE_VALIDATION_TIMEOUT };
    }

    const message = sanitizeError(errorMessage(error), resolvedKey);
    return {
      ok: false,
      error: `${MESSAGE_VALIDATION_UNREACHABLE_PREFIX}${message}`,
    };
  }
}

export async function validateLLMEndpoint(): Promise<{
  ok: boolean;
  error?: string;
}> {
  return getAvailableModels();
}

function mapGenerateError(error: unknown): {
  error: string;
  code: LLMErrorCode;
} {
  if (error instanceof Error && error.name === "AbortError") {
    return {
      error: MESSAGE_REQUEST_TIMEOUT,
      code: ERROR_TIMEOUT,
    };
  }

  if (NoObjectGeneratedError.isInstance(error)) {
    return {
      error: error.message,
      code: ERROR_PARSE,
    };
  }

  if (error instanceof APICallError) {
    if (error.statusCode === 429) {
      return {
        error: error.message,
        code: ERROR_RATE_LIMIT,
      };
    }

    if (typeof error.statusCode === "number") {
      return {
        error: error.message,
        code: ERROR_API,
      };
    }

    return {
      error: error.message,
      code: ERROR_NETWORK,
    };
  }

  const message = errorMessage(error);
  if (isLikelyNetworkError(message)) {
    return {
      error: message,
      code: ERROR_NETWORK,
    };
  }

  return {
    error: message || MESSAGE_LLM_REQUEST_FAILED,
    code: ERROR_API,
  };
}

function formatValidationError(
  status: number,
  text: string,
  apiKey: string,
): string {
  const base =
    status === 401 || status === 403
      ? MESSAGE_INVALID_API_KEY
      : status === 404
        ? MESSAGE_MODEL_NOT_FOUND
        : `HTTP ${status}`;

  const detail = text ? `: ${sanitizeError(text, apiKey)}` : "";
  return `${base}${detail}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isLikelyNetworkError(message: string): boolean {
  return /ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|socket|connect/i.test(
    message,
  );
}

function sanitizeError(error: string, apiKey: string): string {
  let sanitized = error;

  if (apiKey) {
    const escaped = escapeRegExp(apiKey);
    sanitized = sanitized.replace(
      new RegExp(escaped, "g"),
      redactApiKey(apiKey),
    );
  }

  sanitized = sanitized.replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, "$1[redacted]");
  sanitized = sanitized.replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]");
  return sanitized;
}

function redactApiKey(apiKey: string): string {
  if (apiKey.length <= 4) {
    return "[redacted]";
  }

  return `[redacted:${apiKey.slice(-4)}]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
