import type { AnthropicProvider } from "@ai-sdk/anthropic";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { GoogleGenerativeAIProvider } from "@ai-sdk/google";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { OpenAIProvider } from "@ai-sdk/openai";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingConfig, LLMProvider, LlmConfig } from "../../types";
import { resolveSecret } from "../../util/secrets";

// -- Provider name constants ------------------------------------------------

const PROVIDER_OLLAMA = "ollama" as const;
const PROVIDER_OPENAI_CHAT = "openai-chat" as const;
const PROVIDER_OPENAI_RESPONSES = "openai-responses" as const;
const PROVIDER_ANTHROPIC = "anthropic" as const;
const PROVIDER_GEMINI = "gemini" as const;
const PROVIDER_GENERIC = "generic" as const;

const OLLAMA_V1_SUFFIX = "/v1";

// -- Return type ------------------------------------------------------------

export type AIProvider =
  | OpenAIProvider
  | AnthropicProvider
  | GoogleGenerativeAIProvider;

// -- Internal provider builder ----------------------------------------------

async function buildProvider(
  provider: LLMProvider,
  apiKey: string,
  apiUrl: string,
): Promise<AIProvider> {
  const resolvedKey = await resolveSecret(apiKey);

  switch (provider) {
    case PROVIDER_OLLAMA:
      return createOpenAI({
        apiKey: resolvedKey,
        baseURL: apiUrl + OLLAMA_V1_SUFFIX,
      });
    case PROVIDER_OPENAI_CHAT:
    case PROVIDER_OPENAI_RESPONSES:
    case PROVIDER_GENERIC:
      return createOpenAI({
        apiKey: resolvedKey,
        baseURL: apiUrl,
      });
    case PROVIDER_ANTHROPIC:
      return createAnthropic({ apiKey: resolvedKey, baseURL: apiUrl });
    case PROVIDER_GEMINI:
      return createGoogleGenerativeAI({ apiKey: resolvedKey, baseURL: apiUrl });
    default: {
      const _unreachable: never = provider;
      throw new Error(`Unsupported provider: ${_unreachable}`);
    }
  }
}

// -- Default factory implementations ----------------------------------------

async function _defaultCreateLLMProvider(
  config: LlmConfig,
): Promise<AIProvider> {
  return buildProvider(config.provider, config.apiKey, config.apiUrl);
}

async function _defaultCreateEmbeddingProvider(
  config: EmbeddingConfig,
): Promise<AIProvider> {
  return buildProvider(config.provider, config.apiKey, config.apiUrl);
}

// -- DI hooks for testing ---------------------------------------------------

let _createLLMProviderFn = _defaultCreateLLMProvider;
let _createEmbeddingProviderFn = _defaultCreateEmbeddingProvider;

export async function createLLMProvider(
  config: LlmConfig,
): Promise<AIProvider> {
  return _createLLMProviderFn(config);
}

export async function createEmbeddingProvider(
  config: EmbeddingConfig,
): Promise<AIProvider> {
  return _createEmbeddingProviderFn(config);
}

/** @internal -- test-only */
export function _setProviderFactoryForTesting(
  overrides: {
    createLLMProvider?: typeof _defaultCreateLLMProvider;
    createEmbeddingProvider?: typeof _defaultCreateEmbeddingProvider;
  } | null,
): void {
  _createLLMProviderFn =
    overrides?.createLLMProvider ?? _defaultCreateLLMProvider;
  _createEmbeddingProviderFn =
    overrides?.createEmbeddingProvider ?? _defaultCreateEmbeddingProvider;
}
