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
const _MESSAGE_VALIDATION_FAILED_PREFIX = "LLM validation failed: ";
const MESSAGE_VALIDATION_TIMEOUT = "LLM endpoint validation timed out";
const MESSAGE_VALIDATION_UNREACHABLE_PREFIX = "LLM endpoint unreachable: ";
const MESSAGE_INVALID_API_KEY = "Invalid or unauthorized API key";
const MESSAGE_MODEL_NOT_FOUND = "Model not found";

const VALIDATION_PROMPT = 'Return the JSON object {"ok":true}.';
const VALIDATION_SYSTEM_PROMPT = "You are a health check assistant.";

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
}

let deps: GenerateDeps = {
  generateText,
  createLLMProvider,
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

    const prompt = buildStructuredPrompt(options);

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

export async function validateLLMEndpoint(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const config = getConfig();
  const provider = config.llm.provider;
  const model = config.llm.model;
  const apiUrl = config.llm.apiUrl;
  const rawApiKey = config.llm.apiKey;
  const resolvedApiKey = await resolveSecret(rawApiKey);

  try {
    const providerFactory = await deps.createLLMProvider({
      provider,
      model,
      apiUrl,
      apiKey: rawApiKey,
    });

    await deps.generateText({
      model: providerFactory.chat(model),
      system: VALIDATION_SYSTEM_PROMPT,
      prompt: VALIDATION_PROMPT,
      maxRetries: 0,
      temperature: 0,
      abortSignal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
      output: Output.object({
        schema: jsonSchema({
          type: "object",
          properties: { ok: { type: "boolean" } },
        }),
      }),
    });

    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: MESSAGE_VALIDATION_TIMEOUT };
    }

    if (error instanceof APICallError && typeof error.statusCode === "number") {
      return {
        ok: false,
        error: formatValidationError(
          error.statusCode,
          error.message,
          resolvedApiKey,
        ),
      };
    }

    const message = sanitizeError(errorMessage(error), resolvedApiKey);
    return {
      ok: false,
      error: `${MESSAGE_VALIDATION_UNREACHABLE_PREFIX}${message}`,
    };
  }
}

function buildStructuredPrompt(options: LLMCallOptions): string {
  const schemaJson = JSON.stringify(options.toolSchema.parameters);
  const lines = [
    options.userPrompt,
    "",
    `Return only a JSON object for tool '${options.toolSchema.name}'.`,
    `Tool description: ${options.toolSchema.description}`,
    `JSON schema: ${schemaJson}`,
  ];
  return lines.join("\n");
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
