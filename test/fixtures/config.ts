import { deepmerge } from "deepmerge-ts";
import type { PluginConfig } from "../../src/config.ts";

type DeepPartialValue<T> =
  T extends Array<infer U>
    ? Array<DeepPartialValue<U>>
    : T extends object
      ? DeepPartial<T>
      : T;

export type DeepPartial<T> = {
  [K in keyof T]?: DeepPartialValue<T[K]>;
};

export function makeTestConfig(
  overrides?: DeepPartial<PluginConfig>,
): PluginConfig {
  const base: PluginConfig = {
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
    web: { port: 4747 },
    search: { retrievalQuality: "balanced" },
    toasts: { autoCapture: true, userProfile: true, errors: true },
    compaction: { enabled: true, memoryLimit: 10 },
    consolidation: { maxCandidates: 500 },
  };
  if (!overrides) {
    return base;
  }

  return deepmerge(base, overrides) as PluginConfig;
}
