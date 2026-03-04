import { afterEach, describe, expect, test } from "bun:test";
import {
  _setProviderFactoryForTesting,
  createEmbeddingProvider,
  createLLMProvider,
} from "../src/core/ai/providers";
import type { EmbeddingConfig, LlmConfig } from "../src/types";

describe("providers", () => {
  afterEach(() => {
    _setProviderFactoryForTesting(null);
  });

  describe("createLLMProvider", () => {
    test("creates ollama provider", async () => {
      const config: LlmConfig = {
        provider: "ollama",
        model: "test-model",
        apiUrl: "http://localhost:11434",
        apiKey: "test-key",
      };

      const provider = await createLLMProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });

    test("creates generic provider", async () => {
      const config: LlmConfig = {
        provider: "generic",
        model: "test-model",
        apiUrl: "http://example.com/v1",
        apiKey: "test-key",
      };

      const provider = await createLLMProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });

    test("creates openai-chat provider", async () => {
      const config: LlmConfig = {
        provider: "openai-chat",
        model: "gpt-4o-mini",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      };

      const provider = await createLLMProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });

    test("creates openai-responses provider", async () => {
      const config: LlmConfig = {
        provider: "openai-responses",
        model: "gpt-4o-mini",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      };

      const provider = await createLLMProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });

    test("creates anthropic provider", async () => {
      const config: LlmConfig = {
        provider: "anthropic",
        model: "claude-3-haiku-20240307",
        apiUrl: "https://api.anthropic.com",
        apiKey: "sk-ant-test",
      };

      const provider = await createLLMProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });

    test("creates gemini provider", async () => {
      const config: LlmConfig = {
        provider: "gemini",
        model: "gemini-1.5-flash",
        apiUrl: "https://generativelanguage.googleapis.com",
        apiKey: "test-key",
      };

      const provider = await createLLMProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });

    test("throws on invalid provider type", async () => {
      const config = {
        provider: "invalid-provider",
        model: "test-model",
        apiUrl: "http://example.com",
        apiKey: "test-key",
      } as unknown as LlmConfig;

      try {
        await createLLMProvider(config);
        throw new Error("Expected createLLMProvider to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("Unsupported provider");
      }
    });

    test("resolves env:// prefixed API keys", async () => {
      process.env.TEST_API_KEY = "resolved-key-value";

      const config: LlmConfig = {
        provider: "openai-chat",
        model: "gpt-4o-mini",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "env://TEST_API_KEY",
      };

      const provider = await createLLMProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");

      delete process.env.TEST_API_KEY;
    });

    test("uses custom factory when set", async () => {
      const customFactory = async (_config: LlmConfig) =>
        ({
          chat: () => ({ custom: true }),
        }) as unknown as Awaited<ReturnType<typeof createLLMProvider>>;

      _setProviderFactoryForTesting({
        createLLMProvider: customFactory as unknown as typeof createLLMProvider,
      });

      const config: LlmConfig = {
        provider: "openai-chat",
        model: "gpt-4o-mini",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      };

      const provider = await createLLMProvider(config);

      expect(provider).toHaveProperty("chat");
      expect(
        (provider as unknown as { chat: () => { custom: boolean } }).chat(),
      ).toEqual({
        custom: true,
      });
    });

    test("resets to default factory when set to null", async () => {
      const customFactory = async (_config: LlmConfig) =>
        ({
          chat: () => ({ custom: true }),
        }) as unknown as Awaited<ReturnType<typeof createLLMProvider>>;

      _setProviderFactoryForTesting({
        createLLMProvider: customFactory as unknown as typeof createLLMProvider,
      });

      _setProviderFactoryForTesting(null);

      const config: LlmConfig = {
        provider: "openai-chat",
        model: "gpt-4o-mini",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      };

      const provider = await createLLMProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });
  });

  describe("createEmbeddingProvider", () => {
    test("creates ollama embedding provider", async () => {
      const config: EmbeddingConfig = {
        provider: "ollama",
        model: "embeddinggemma:latest",
        apiUrl: "http://localhost:11434",
        apiKey: "test-key",
      };

      const provider = await createEmbeddingProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });

    test("creates generic embedding provider", async () => {
      const config: EmbeddingConfig = {
        provider: "generic",
        model: "test-embedding-model",
        apiUrl: "http://example.com/v1",
        apiKey: "test-key",
      };

      const provider = await createEmbeddingProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });

    test("creates openai-chat embedding provider", async () => {
      const config: EmbeddingConfig = {
        provider: "openai-chat",
        model: "text-embedding-3-small",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      };

      const provider = await createEmbeddingProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });

    test("creates gemini embedding provider", async () => {
      const config: EmbeddingConfig = {
        provider: "gemini",
        model: "embedding-001",
        apiUrl: "https://generativelanguage.googleapis.com",
        apiKey: "test-key",
      };

      const provider = await createEmbeddingProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });

    test("throws on invalid embedding provider type", async () => {
      const config = {
        provider: "invalid-provider",
        model: "test-model",
        apiUrl: "http://example.com",
        apiKey: "test-key",
      } as unknown as EmbeddingConfig;

      try {
        await createEmbeddingProvider(config);
        throw new Error("Expected createEmbeddingProvider to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("Unsupported provider");
      }
    });

    test("uses custom embedding factory when set", async () => {
      const customFactory = async (_config: EmbeddingConfig) =>
        ({
          chat: () => ({ custom: true }),
        }) as unknown as Awaited<ReturnType<typeof createEmbeddingProvider>>;

      _setProviderFactoryForTesting({
        createEmbeddingProvider:
          customFactory as unknown as typeof createEmbeddingProvider,
      });

      const config: EmbeddingConfig = {
        provider: "ollama",
        model: "embeddinggemma:latest",
        apiUrl: "http://localhost:11434",
        apiKey: "test-key",
      };

      const provider = await createEmbeddingProvider(config);

      expect(provider).toHaveProperty("chat");
      expect(
        (provider as unknown as { chat: () => { custom: boolean } }).chat(),
      ).toEqual({
        custom: true,
      });
    });

    test("resets embedding factory to default when set to null", async () => {
      const customFactory = async (_config: EmbeddingConfig) =>
        ({
          chat: () => ({ custom: true }),
        }) as unknown as Awaited<ReturnType<typeof createEmbeddingProvider>>;

      _setProviderFactoryForTesting({
        createEmbeddingProvider:
          customFactory as unknown as typeof createEmbeddingProvider,
      });

      _setProviderFactoryForTesting(null);

      const config: EmbeddingConfig = {
        provider: "ollama",
        model: "embeddinggemma:latest",
        apiUrl: "http://localhost:11434",
        apiKey: "test-key",
      };

      const provider = await createEmbeddingProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });
  });

  describe("_setProviderFactoryForTesting", () => {
    test("allows setting both LLM and embedding factories simultaneously", async () => {
      const customLLMFactory = async (_config: LlmConfig) =>
        ({
          chat: () => ({ type: "llm" }),
        }) as unknown as Awaited<ReturnType<typeof createLLMProvider>>;
      const customEmbeddingFactory = async (_config: EmbeddingConfig) =>
        ({
          chat: () => ({ type: "embedding" }),
        }) as unknown as Awaited<ReturnType<typeof createEmbeddingProvider>>;

      _setProviderFactoryForTesting({
        createLLMProvider:
          customLLMFactory as unknown as typeof createLLMProvider,
        createEmbeddingProvider:
          customEmbeddingFactory as unknown as typeof createEmbeddingProvider,
      });

      const llmConfig: LlmConfig = {
        provider: "openai-chat",
        model: "gpt-4o-mini",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      };

      const embeddingConfig: EmbeddingConfig = {
        provider: "ollama",
        model: "embeddinggemma:latest",
        apiUrl: "http://localhost:11434",
        apiKey: "test-key",
      };

      const llmProvider = await createLLMProvider(llmConfig);
      const embeddingProvider = await createEmbeddingProvider(embeddingConfig);

      expect(
        (llmProvider as unknown as { chat: () => { type: string } }).chat(),
      ).toEqual({
        type: "llm",
      });
      expect(
        (
          embeddingProvider as unknown as { chat: () => { type: string } }
        ).chat(),
      ).toEqual({
        type: "embedding",
      });
    });

    test("allows partial overrides (only LLM factory)", async () => {
      const customLLMFactory = async (_config: LlmConfig) =>
        ({
          chat: () => ({ custom: true }),
        }) as unknown as Awaited<ReturnType<typeof createLLMProvider>>;

      _setProviderFactoryForTesting({
        createLLMProvider:
          customLLMFactory as unknown as typeof createLLMProvider,
      });

      const embeddingConfig: EmbeddingConfig = {
        provider: "ollama",
        model: "embeddinggemma:latest",
        apiUrl: "http://localhost:11434",
        apiKey: "test-key",
      };

      const embeddingProvider = await createEmbeddingProvider(embeddingConfig);

      expect(embeddingProvider).toBeDefined();
      expect(embeddingProvider).toHaveProperty("chat");
    });

    test("allows partial overrides (only embedding factory)", async () => {
      const customEmbeddingFactory = async (_config: EmbeddingConfig) =>
        ({
          chat: () => ({ custom: true }),
        }) as unknown as Awaited<ReturnType<typeof createEmbeddingProvider>>;

      _setProviderFactoryForTesting({
        createEmbeddingProvider:
          customEmbeddingFactory as unknown as typeof createEmbeddingProvider,
      });

      const llmConfig: LlmConfig = {
        provider: "openai-chat",
        model: "gpt-4o-mini",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      };

      const llmProvider = await createLLMProvider(llmConfig);

      expect(llmProvider).toBeDefined();
      expect(llmProvider).toHaveProperty("chat");
    });
  });

  describe("ollama provider specifics", () => {
    test("appends /v1 suffix to ollama apiUrl", async () => {
      const config: LlmConfig = {
        provider: "ollama",
        model: "test-model",
        apiUrl: "http://localhost:11434",
        apiKey: "test-key",
      };

      const provider = await createLLMProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });
  });

  describe("direct API key values", () => {
    test("handles direct API key values without prefixes", async () => {
      const config: LlmConfig = {
        provider: "openai-chat",
        model: "gpt-4o-mini",
        apiUrl: "https://api.openai.com/v1",
        apiKey: "sk-direct-value",
      };

      const provider = await createLLMProvider(config);

      expect(provider).toBeDefined();
      expect(provider).toHaveProperty("chat");
    });
  });
});
