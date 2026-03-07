import { afterEach, describe, expect, test } from "bun:test";
import {
  _setProviderFactoryForTesting,
  createLLMProvider,
} from "../src/core/ai/providers";
import type { LlmConfig } from "../src/types";

describe("providers baseURL", () => {
  afterEach(() => {
    _setProviderFactoryForTesting(null);
  });

  describe("anthropic baseURL", () => {
    test("passes custom apiUrl as baseURL to createAnthropic", async () => {
      let capturedArgs: Record<string, unknown> | null = null;

      const mockCreateAnthropic = (args: Record<string, unknown>) => {
        capturedArgs = args;
        return {
          chat: () => ({ mock: "anthropic" }),
        };
      };

      _setProviderFactoryForTesting({
        createLLMProvider: async (config: LlmConfig) => {
          const apiUrl = config.apiUrl;
          const apiKey = config.apiKey;
          return mockCreateAnthropic({
            apiKey,
            baseURL: apiUrl,
          }) as unknown as Awaited<ReturnType<typeof createLLMProvider>>;
        },
      });

      const config: LlmConfig = {
        provider: "anthropic",
        model: "claude-3-haiku-20240307",
        apiUrl: "https://custom.anthropic.api.com",
        apiKey: "sk-ant-test",
      };

      await createLLMProvider(config);

      expect(capturedArgs).toBeDefined();
      expect((capturedArgs as unknown as Record<string, unknown>).baseURL).toBe(
        "https://custom.anthropic.api.com",
      );
      expect((capturedArgs as unknown as Record<string, unknown>).apiKey).toBe(
        "sk-ant-test",
      );
    });

    test("passes default apiUrl as baseURL when no custom URL provided", async () => {
      let capturedArgs: Record<string, unknown> | null = null;

      const mockCreateAnthropic = (args: Record<string, unknown>) => {
        capturedArgs = args;
        return {
          chat: () => ({ mock: "anthropic" }),
        };
      };

      _setProviderFactoryForTesting({
        createLLMProvider: async (config: LlmConfig) => {
          const apiUrl = config.apiUrl;
          const apiKey = config.apiKey;
          return mockCreateAnthropic({
            apiKey,
            baseURL: apiUrl,
          }) as unknown as Awaited<ReturnType<typeof createLLMProvider>>;
        },
      });

      const config: LlmConfig = {
        provider: "anthropic",
        model: "claude-3-haiku-20240307",
        apiUrl: "https://api.anthropic.com",
        apiKey: "sk-ant-test",
      };

      await createLLMProvider(config);

      expect(capturedArgs).toBeDefined();
      expect((capturedArgs as unknown as Record<string, unknown>).baseURL).toBe(
        "https://api.anthropic.com",
      );
    });
  });

  describe("gemini baseURL", () => {
    test("passes custom apiUrl as baseURL to createGoogleGenerativeAI", async () => {
      let capturedArgs: Record<string, unknown> | null = null;

      const mockCreateGoogleGenerativeAI = (args: Record<string, unknown>) => {
        capturedArgs = args;
        return {
          chat: () => ({ mock: "gemini" }),
        };
      };

      _setProviderFactoryForTesting({
        createLLMProvider: async (config: LlmConfig) => {
          const apiUrl = config.apiUrl;
          const apiKey = config.apiKey;
          return mockCreateGoogleGenerativeAI({
            apiKey,
            baseURL: apiUrl,
          }) as unknown as Awaited<ReturnType<typeof createLLMProvider>>;
        },
      });

      const config: LlmConfig = {
        provider: "gemini",
        model: "gemini-1.5-flash",
        apiUrl: "https://custom.gemini.api.com",
        apiKey: "test-key",
      };

      await createLLMProvider(config);

      expect(capturedArgs).toBeDefined();
      expect((capturedArgs as unknown as Record<string, unknown>).baseURL).toBe(
        "https://custom.gemini.api.com",
      );
      expect((capturedArgs as unknown as Record<string, unknown>).apiKey).toBe(
        "test-key",
      );
    });

    test("passes default apiUrl as baseURL to createGoogleGenerativeAI", async () => {
      let capturedArgs: Record<string, unknown> | null = null;

      const mockCreateGoogleGenerativeAI = (args: Record<string, unknown>) => {
        capturedArgs = args;
        return {
          chat: () => ({ mock: "gemini" }),
        };
      };

      _setProviderFactoryForTesting({
        createLLMProvider: async (config: LlmConfig) => {
          const apiUrl = config.apiUrl;
          const apiKey = config.apiKey;
          return mockCreateGoogleGenerativeAI({
            apiKey,
            baseURL: apiUrl,
          }) as unknown as Awaited<ReturnType<typeof createLLMProvider>>;
        },
      });

      const config: LlmConfig = {
        provider: "gemini",
        model: "gemini-1.5-flash",
        apiUrl: "https://generativelanguage.googleapis.com",
        apiKey: "test-key",
      };

      await createLLMProvider(config);

      expect(capturedArgs).toBeDefined();
      expect((capturedArgs as unknown as Record<string, unknown>).baseURL).toBe(
        "https://generativelanguage.googleapis.com",
      );
    });
  });
});
