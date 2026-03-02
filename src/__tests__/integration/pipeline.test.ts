import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { PluginConfig } from "../../config.ts";

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

function deterministicVector(text: string): number[] {
  let seed = hashCode(text);
  const vec = new Array(768);
  for (let i = 0; i < 768; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    vec[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vec.map((value) => value / norm) : vec;
}

mock.module("../../embed/embedder.ts", () => ({
  embed: async (texts: string[], _mode: string) =>
    texts.map((t) => deterministicVector(t)),
  initEmbedder: async () => {},
  getEmbedderState: () => "ready" as const,
  resetEmbedder: () => {},
}));

mock.module("../../core/llm.ts", () => ({
  callLLMWithTool: async () => ({ success: true as const, data: {} }),
}));

import {
  addMemory,
  searchMemories,
  forgetMemory,
  listMemories,
  getMemoryById,
} from "../../core/memory.ts";
import {
  initSearch,
  markStale,
  rebuildIndex,
  getSearchState,
} from "../../search/index.ts";
import {
  getDb,
  closeDb,
  countMemories,
  _setDbForTesting,
} from "../../db/database.ts";
import { _setConfigForTesting, _resetConfigForTesting } from "../../config.ts";
import { _resetTagCache } from "../../core/tags.ts";
import { _resetSecretCache } from "../../util/secrets.ts";
import { startServer, stopServer } from "../../web/server.ts";

function makeTestConfig(tmpPath: string, port = 19747): PluginConfig {
  return {
    llm: {
      provider: "openai-chat",
      model: "test",
      apiUrl: "http://localhost:9999",
      apiKey: "test-key",
    },
    storage: { path: tmpPath },
    memory: {
      maxResults: 10,
      autoCapture: true,
      injection: "first",
      excludeCurrentSession: true,
    },
    web: { port, enabled: true },
    search: { retrievalQuality: "balanced" },
  };
}

describe("integration: memory pipeline", () => {
  let tmpDir = "";
  let dbPath = "";

  beforeEach(async () => {
    stopServer();
    closeDb();
    _resetTagCache();
    _resetSecretCache();

    tmpDir = mkdtempSync(join(tmpdir(), "flashback-int-"));
    dbPath = join(tmpDir, "test.db");
    _setConfigForTesting(makeTestConfig(tmpDir));

    const db = getDb(dbPath);
    _setDbForTesting(db);
    await initSearch();
    await rebuildIndex();
  });

  afterEach(() => {
    stopServer();
    _resetConfigForTesting();
    closeDb();
    _resetTagCache();
    _resetSecretCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("full pipeline: add -> store -> search -> recall/list -> forget", async () => {
    const containerTag = "pipeline-tag";

    const added = await Promise.all([
      addMemory({
        content: "Rust ownership model prevents data races",
        containerTag,
      }),
      addMemory({
        content: "WASM modules run fast in browser environments",
        containerTag,
      }),
      addMemory({
        content: "SQLite WAL mode improves write concurrency",
        containerTag,
      }),
      addMemory({
        content: "Orama hybrid search combines vector and keyword ranking",
        containerTag,
      }),
    ]);

    for (const result of added) {
      expect(result.deduplicated).toBe(false);
      expect(result.id).toBeTruthy();
    }

    expect(countMemories(getDb(), containerTag)).toBe(4);

    const searchResults = await searchMemories(
      "WASM modules run fast",
      containerTag,
      10,
    );
    expect(searchResults.length).toBeGreaterThan(0);
    expect(
      searchResults.some((r) =>
        r.memory.content.includes("WASM modules run fast in browser"),
      ),
    ).toBe(true);

    const recalled = await getMemoryById(added[1].id);
    expect(recalled).not.toBeNull();
    expect(recalled!.content).toBe(
      "WASM modules run fast in browser environments",
    );

    const listed = await listMemories(containerTag, 10, 0);
    expect(listed.total).toBe(4);
    expect(listed.memories.length).toBe(4);

    await forgetMemory(added[1].id);
    expect(await getMemoryById(added[1].id)).toBeNull();

    const afterDelete = await searchMemories(
      "WASM modules run fast",
      containerTag,
      10,
    );
    expect(afterDelete.some((r) => r.memory.id === added[1].id)).toBe(false);
  });

  test("deduplicates identical memory in same container", async () => {
    const containerTag = "dedup-tag";
    const content = "Repeated memory content for deduplication";

    const first = await addMemory({ content, containerTag });
    const second = await addMemory({ content, containerTag });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
    expect(countMemories(getDb(), containerTag)).toBe(1);
  });

  test("rebuilds stale index and preserves search correctness", async () => {
    const containerTag = "stale-tag";

    await addMemory({
      content: "First stale-index test memory about Rust",
      containerTag,
    });
    await addMemory({
      content: "Second stale-index test memory about SQLite",
      containerTag,
    });

    markStale();
    await rebuildIndex();

    const results = await searchMemories("SQLite", containerTag, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((r) =>
        r.memory.content.includes(
          "Second stale-index test memory about SQLite",
        ),
      ),
    ).toBe(true);
    expect(getSearchState()).toBe("ready");
  });

  test("enforces csrf token for mutation endpoints", async () => {
    const port = 19747;
    _setConfigForTesting(makeTestConfig(tmpDir, port));

    await startServer(tmpDir);
    const base = `http://127.0.0.1:${port}`;
    const httpFetch = Bun.fetch;

    const tokenRes = await httpFetch(`${base}/api/csrf-token`);
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    const missingTokenRes = await httpFetch(`${base}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "csrf missing token" }),
    });
    expect(missingTokenRes.status).toBe(403);

    const wrongTokenRes = await httpFetch(`${base}/api/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": "wrong-token",
      },
      body: JSON.stringify({ content: "csrf wrong token" }),
    });
    expect(wrongTokenRes.status).toBe(403);

    const okRes = await httpFetch(`${base}/api/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": token,
      },
      body: JSON.stringify({ content: "csrf valid token", tags: ["web"] }),
    });
    expect([200, 201]).toContain(okRes.status);
  });

  test("keeps deterministic ordering for list and repeated search", async () => {
    const containerTag = "order-tag";

    await addMemory({ content: "alpha rust memory", containerTag });
    await Bun.sleep(2);
    await addMemory({ content: "beta rust memory", containerTag });
    await Bun.sleep(2);
    await addMemory({ content: "gamma rust memory", containerTag });

    const listedA = await listMemories(containerTag, 10, 0);
    const listedB = await listMemories(containerTag, 10, 0);

    expect(listedA.memories.map((m) => m.id)).toEqual(
      listedB.memories.map((m) => m.id),
    );

    const searchA = await searchMemories("rust memory", containerTag, 10);
    const searchB = await searchMemories("rust memory", containerTag, 10);

    expect(searchA.map((r) => r.memory.id)).toEqual(
      searchB.map((r) => r.memory.id),
    );
  });
});
