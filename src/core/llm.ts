import { getConfig } from "../config";
import type { LLMProvider } from "../types";
import { resolveSecret } from "../util/secrets";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TEMPERATURE = 0.3;
const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000] as const;

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

type LLMErrorCode = Exclude<LLMCallResult, { success: true }>["code"];

interface ProviderErrorResult {
  success: false;
  error: string;
  code: LLMErrorCode;
  statusCode?: number;
  retryAfterMs?: number;
}

type InternalLLMCallResult =
  | { success: true; data: Record<string, unknown> }
  | ProviderErrorResult;

interface PostJsonSuccessResult {
  success: true;
  response: Response;
  json: unknown;
  text: string;
}

type PostJsonResult = PostJsonSuccessResult | ProviderErrorResult;

export async function callLLMWithTool(
  options: LLMCallOptions,
): Promise<LLMCallResult> {
  const config = getConfig();
  const provider = options.provider ?? config.llm.provider;
  const model = options.model ?? config.llm.model;
  const apiUrl = options.apiUrl ?? config.llm.apiUrl;
  const rawApiKey = options.apiKey ?? config.llm.apiKey;
  const apiKey = await resolveSecret(rawApiKey);
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const nothink = options.nothink ?? true;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await callProvider({
      provider,
      model,
      apiUrl,
      apiKey,
      timeoutMs,
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      toolSchema: options.toolSchema,
      nothink,
      temperature,
    });

    if (result.success) {
      return result;
    }

    if (result.code === "parse_error") {
      return toPublicResult(result, apiKey);
    }

    if (result.code === "api_error" && !isRetryableStatus(result.statusCode)) {
      return toPublicResult(result, apiKey);
    }

    if (attempt === MAX_RETRIES) {
      return toPublicResult(result, apiKey);
    }

    if (result.statusCode === 429) {
      const delay = result.retryAfterMs ?? backoffForAttempt(attempt);
      await sleep(delay);
      continue;
    }

    if (typeof result.statusCode === "number" && result.statusCode >= 500) {
      await sleep(backoffForAttempt(attempt));
      continue;
    }

    if (result.code === "timeout" || result.code === "network_error") {
      await sleep(backoffForAttempt(attempt));
      continue;
    }

    return toPublicResult(result, apiKey);
  }

  return {
    success: false,
    error: "LLM request failed",
    code: "api_error",
  };
}

interface ProviderCallOptions {
  provider: LLMProvider;
  model: string;
  apiUrl: string;
  apiKey: string;
  timeoutMs: number;
  systemPrompt: string;
  userPrompt: string;
  toolSchema: ToolSchema;
  nothink: boolean;
  temperature: number;
}

async function callProvider(
  options: ProviderCallOptions,
): Promise<InternalLLMCallResult> {
  switch (options.provider) {
    case "openai-chat":
      return callOpenAIChat(options);
    case "openai-responses":
      return callOpenAIResponses(options);
    case "anthropic":
      return callAnthropic(options);
    case "gemini":
      return callGemini(options);
    case "generic":
    case "ollama":
      return callGeneric(options);
  }
}

async function callOpenAIChat(
  options: ProviderCallOptions,
): Promise<InternalLLMCallResult> {
  const payload = {
    model: options.model,
    messages: [
      { role: "system", content: options.systemPrompt },
      { role: "user", content: options.userPrompt },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: options.toolSchema.name,
          description: options.toolSchema.description,
          parameters: options.toolSchema.parameters,
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: options.toolSchema.name },
    },
    temperature: options.temperature,
  };

  const result = await postJson(
    buildApiUrl(options.apiUrl, "/chat/completions"),
    {
      "Content-Type": "application/json",
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    },
    payload,
    options.timeoutMs,
  );

  if (!result.success) {
    return result;
  }

  const data = result.json as OpenAIChatResponse;
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) {
    return parseError("Missing tool call arguments in OpenAI chat response");
  }

  return parseJsonObject(toolCall.function.arguments);
}

async function callOpenAIResponses(
  options: ProviderCallOptions,
): Promise<InternalLLMCallResult> {
  const basePayload = {
    model: options.model,
    input: [
      { role: "system", content: options.systemPrompt },
      { role: "user", content: options.userPrompt },
    ],
    tools: [
      {
        type: "function",
        name: options.toolSchema.name,
        description: options.toolSchema.description,
        parameters: options.toolSchema.parameters,
      },
    ],
    tool_choice: {
      type: "function",
      name: options.toolSchema.name,
    },
    temperature: options.temperature,
  };

  const withReasoning = options.nothink
    ? { ...basePayload, reasoning: { effort: "none" as const } }
    : basePayload;

  const endpoint = buildApiUrl(options.apiUrl, "/responses");
  const headers = {
    "Content-Type": "application/json",
    ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
  };

  const result = await postJson(
    endpoint,
    headers,
    withReasoning,
    options.timeoutMs,
  );

  if (
    !result.success &&
    options.nothink &&
    result.statusCode === 400 &&
    /reasoning|effort/i.test(result.error)
  ) {
    const fallback = await postJson(
      endpoint,
      headers,
      basePayload,
      options.timeoutMs,
    );
    if (!fallback.success) {
      return fallback;
    }

    return parseResponsesFunctionCall(fallback.json);
  }

  if (!result.success) {
    return result;
  }

  return parseResponsesFunctionCall(result.json);
}

function parseResponsesFunctionCall(json: unknown): InternalLLMCallResult {
  const data = json as OpenAIResponsesResponse;
  const functionCall = data.output?.find(
    (item) => item.type === "function_call",
  );

  if (!functionCall?.arguments) {
    return parseError(
      "Missing function_call arguments in OpenAI responses output",
    );
  }

  return parseJsonObject(functionCall.arguments);
}

async function callAnthropic(
  options: ProviderCallOptions,
): Promise<InternalLLMCallResult> {
  const payload = {
    model: options.model,
    system: options.systemPrompt,
    messages: [{ role: "user", content: options.userPrompt }],
    tools: [
      {
        name: options.toolSchema.name,
        description: options.toolSchema.description,
        input_schema: options.toolSchema.parameters,
      },
    ],
    tool_choice: { type: "tool", name: options.toolSchema.name },
    max_tokens: 4096,
  };

  const result = await postJson(
    buildApiUrl(options.apiUrl, "/messages"),
    {
      "Content-Type": "application/json",
      ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
      "anthropic-version": "2023-06-01",
    },
    payload,
    options.timeoutMs,
  );

  if (!result.success) {
    return result;
  }

  const data = result.json as AnthropicResponse;
  const toolUse = data.content?.find((item) => item.type === "tool_use");
  if (!toolUse?.input || !isRecord(toolUse.input)) {
    return parseError("Missing tool_use input in Anthropic response");
  }

  return { success: true, data: toolUse.input };
}

async function callGemini(
  options: ProviderCallOptions,
): Promise<InternalLLMCallResult> {
  const payload = {
    system_instruction: {
      parts: [{ text: options.systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: options.userPrompt }],
      },
    ],
    tools: [
      {
        function_declarations: [
          {
            name: options.toolSchema.name,
            description: options.toolSchema.description,
            parameters: options.toolSchema.parameters,
          },
        ],
      },
    ],
    tool_config: {
      function_calling_config: {
        mode: "ANY",
        allowed_function_names: [options.toolSchema.name],
      },
    },
  };

  const apiBase = stripTrailingSlash(options.apiUrl);
  const endpoint = `${apiBase}/models/${encodeURIComponent(options.model)}:generateContent?key=${encodeURIComponent(options.apiKey)}`;
  const result = await postJson(
    endpoint,
    {
      "Content-Type": "application/json",
    },
    payload,
    options.timeoutMs,
  );

  if (!result.success) {
    return result;
  }

  const data = result.json as GeminiResponse;
  const part = data.candidates?.[0]?.content?.parts?.find(
    (p) => p.functionCall,
  );
  const args = part?.functionCall?.args;
  if (!args || !isRecord(args)) {
    return parseError("Missing functionCall.args in Gemini response");
  }

  return { success: true, data: args };
}

async function callGeneric(
  options: ProviderCallOptions,
): Promise<InternalLLMCallResult> {
  const payload: Record<string, unknown> = {
    model: options.model,
    messages: [
      { role: "system", content: options.systemPrompt },
      { role: "user", content: options.userPrompt },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: options.toolSchema.name,
          description: options.toolSchema.description,
          parameters: options.toolSchema.parameters,
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: options.toolSchema.name },
    },
    temperature: options.temperature,
  };

  if (options.nothink) {
    payload.think = false;
  }

  const result = await postJson(
    buildApiUrl(options.apiUrl, "/chat/completions"),
    {
      "Content-Type": "application/json",
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    },
    payload,
    options.timeoutMs,
  );

  if (!result.success) {
    return result;
  }

  const data = result.json as OpenAIChatResponse;
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) {
    return parseError(
      "Missing tool call arguments in generic provider response",
    );
  }

  return parseJsonObject(toolCall.function.arguments);
}

function toPublicResult(
  result: Exclude<InternalLLMCallResult, { success: true }>,
  apiKey: string,
): LLMCallResult {
  return {
    success: false,
    error: sanitizeError(result.error, apiKey),
    code: result.code,
  };
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<PostJsonResult> {
  const fetchResult = await fetchJson(url, headers, body, timeoutMs);
  if (!fetchResult.success) {
    return fetchResult;
  }

  if (!fetchResult.response.ok) {
    return {
      success: false,
      error: extractApiError(
        fetchResult.json,
        fetchResult.text,
        fetchResult.response.status,
      ),
      code: fetchResult.response.status === 429 ? "rate_limit" : "api_error",
      statusCode: fetchResult.response.status,
      retryAfterMs: parseRetryAfter(
        fetchResult.response.headers.get("Retry-After"),
      ),
    };
  }

  return {
    success: true,
    response: fetchResult.response,
    json: fetchResult.json,
    text: fetchResult.text,
  };
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<
  | PostJsonSuccessResult
  | {
      success: false;
      error: string;
      code: "timeout" | "network_error";
    }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();

    let json: unknown = {};
    if (text.trim().length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        // response body is not JSON -- use empty object fallback
        json = {};
      }
    }

    return {
      success: true,
      response,
      json,
      text,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        success: false,
        error: "Request timed out",
        code: "timeout",
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: "network_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(value: unknown): InternalLLMCallResult {
  if (isRecord(value)) {
    return { success: true, data: value };
  }

  if (typeof value !== "string") {
    return parseError("Tool arguments are not a JSON object");
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return parseError("Tool arguments JSON must be an object");
    }
    return { success: true, data: parsed };
  } catch (error) {
    return parseError(
      `Failed to parse tool arguments JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseError(error: string): InternalLLMCallResult {
  return {
    success: false,
    error,
    code: "parse_error",
  };
}

function extractApiError(
  json: unknown,
  text: string,
  statusCode: number,
): string {
  if (isRecord(json)) {
    const directMessage = readStringField(json, "message");
    if (directMessage) {
      return directMessage;
    }

    const errorField = json.error;
    if (isRecord(errorField)) {
      const nestedMessage = readStringField(errorField, "message");
      if (nestedMessage) {
        return nestedMessage;
      }
    }
  }

  if (text.trim().length > 0) {
    return `HTTP ${statusCode}: ${text.slice(0, 400)}`;
  }

  return `HTTP ${statusCode} from LLM provider`;
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

function readStringField(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function isRetryableStatus(statusCode?: number): boolean {
  return (
    statusCode === 429 || (typeof statusCode === "number" && statusCode >= 500)
  );
}

function backoffForAttempt(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }

  const delay = dateMs - Date.now();
  return delay > 0 ? delay : 0;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function buildApiUrl(baseUrl: string, path: string): string {
  return `${stripTrailingSlash(baseUrl)}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      tool_calls?: Array<{
        function?: {
          arguments?: string;
        };
      }>;
    };
  }>;
}

interface OpenAIResponsesResponse {
  output?: Array<{
    type?: string;
    arguments?: string;
  }>;
}

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    input?: unknown;
  }>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        functionCall?: {
          args?: unknown;
        };
      }>;
    };
  }>;
}

const VALIDATE_TIMEOUT_MS = 5000;

export async function validateLLMEndpoint(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const config = getConfig();
  const { provider, model, apiUrl } = config.llm;
  const apiKey = await resolveSecret(config.llm.apiKey);

  if (!apiKey) {
    return { ok: false, error: "LLM API key is not configured" };
  }

  try {
    const result = await validateProvider(provider, model, apiUrl, apiKey);
    return result;
  } catch (error) {
    return {
      ok: false,
      error: `LLM validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function validateProvider(
  provider: LLMProvider,
  model: string,
  apiUrl: string,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  switch (provider) {
    case "openai-chat":
    case "openai-responses":
    case "generic":
    case "ollama":
      return validateOpenAICompatible(apiUrl, apiKey, model);
    case "anthropic":
      return validateAnthropic(apiUrl, apiKey, model);
    case "gemini":
      return validateGemini(apiUrl, apiKey, model);
  }
}

async function validateOpenAICompatible(
  apiUrl: string,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = buildApiUrl(apiUrl, `/models/${encodeURIComponent(model)}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });

    if (response.ok) {
      return { ok: true };
    }

    const text = await response.text().catch(() => "");
    return {
      ok: false,
      error: formatValidationError(response.status, text, apiKey),
    };
  } catch (error) {
    return catchValidationError(error);
  } finally {
    clearTimeout(timer);
  }
}

async function validateAnthropic(
  apiUrl: string,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = buildApiUrl(apiUrl, "/models");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        error: formatValidationError(response.status, text, apiKey),
      };
    }

    const json = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    const models = json.data ?? [];
    const found = models.some((m) => m.id === model);
    if (!found) {
      return {
        ok: false,
        error: `Model "${model}" not found in Anthropic models list`,
      };
    }

    return { ok: true };
  } catch (error) {
    return catchValidationError(error);
  } finally {
    clearTimeout(timer);
  }
}

async function validateGemini(
  apiUrl: string,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; error?: string }> {
  const apiBase = stripTrailingSlash(apiUrl);
  const url = `${apiBase}/models/${encodeURIComponent(model)}?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });

    if (response.ok) {
      return { ok: true };
    }

    const text = await response.text().catch(() => "");
    return {
      ok: false,
      error: formatValidationError(response.status, text, apiKey),
    };
  } catch (error) {
    return catchValidationError(error);
  } finally {
    clearTimeout(timer);
  }
}

function formatValidationError(
  status: number,
  text: string,
  apiKey: string,
): string {
  let message = "";
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const errObj = json.error;
    if (typeof errObj === "object" && errObj !== null && "message" in errObj) {
      message = String((errObj as Record<string, unknown>).message);
    } else if (typeof json.message === "string") {
      message = json.message;
    }
  } catch {
    // not JSON -- use raw text
    if (text.length > 0) {
      message = text.slice(0, 200);
    }
  }

  const base =
    status === 401 || status === 403
      ? "Invalid or unauthorized API key"
      : status === 404
        ? "Model not found"
        : `HTTP ${status}`;

  const detail = message ? `: ${sanitizeError(message, apiKey)}` : "";
  return `${base}${detail}`;
}

function catchValidationError(error: unknown): {
  ok: false;
  error: string;
} {
  if (error instanceof Error && error.name === "AbortError") {
    return { ok: false, error: "LLM endpoint validation timed out" };
  }
  return {
    ok: false,
    error: `LLM endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`,
  };
}
