import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  _resetConfigForTesting,
  _setConfigForTesting,
} from "../../src/config.ts";
import {
  _resetEmbedDepsForTesting,
  _setEmbedDepsForTesting,
  resetEmbedder,
} from "../../src/core/ai/embed.ts";
import {
  _resetGenerateDepsForTesting,
  _setGenerateDepsForTesting,
} from "../../src/core/ai/generate.ts";
import type {
  createEmbeddingProvider,
  createLLMProvider,
} from "../../src/core/ai/providers.ts";
import {
  addMemory,
  forgetMemory,
  getMemoryById,
  listMemories,
  searchMemories,
} from "../../src/core/memory.ts";
import { _resetTagCache } from "../../src/core/tags.ts";
import {
  _setDbForTesting,
  closeDb,
  countMemories,
  getDb,
} from "../../src/db/database.ts";
import {
  getSearchState,
  initSearch,
  markStale,
  rebuildIndex,
} from "../../src/search.ts";
import { _resetSecretCache } from "../../src/util/secrets.ts";
import {
  getServerState,
  startServer,
  stopServer,
} from "../../src/web/server.ts";
import { makeTestConfig } from "../fixtures/config.ts";
import { seededVector } from "../fixtures/vectors.ts";

function ensureStaticMirrorWithScript(): () => void {
  const sourceDir = join(process.cwd(), "src", "web");
  const mirrorDir = join(sourceDir, "web");
  const createdDir = !existsSync(mirrorDir);
  const scriptPath = join(mirrorDir, "test-script.js");

  if (createdDir) {
    mkdirSync(mirrorDir, { recursive: true });
    copyFileSync(join(sourceDir, "index.html"), join(mirrorDir, "index.html"));
    copyFileSync(join(sourceDir, "styles.css"), join(mirrorDir, "styles.css"));
  }

  writeFileSync(scriptPath, "window.__flashback_test = true;\n");

  return () => {
    rmSync(scriptPath, { force: true });
    if (createdDir) {
      rmSync(mirrorDir, { recursive: true, force: true });
    }
  };
}

describe("integration: memory pipeline", () => {
  let tmpDir = "";
  let dbPath = "";
  let cleanupStaticMirror: (() => void) | null = null;

  beforeEach(async () => {
    stopServer();
    closeDb();
    _resetTagCache();
    _resetSecretCache();

    tmpDir = mkdtempSync(join(tmpdir(), "flashback-int-"));
    dbPath = join(tmpDir, "test.db");
    _setConfigForTesting(
      makeTestConfig({
        storage: { path: tmpDir },
        web: { port: 19747 },
      }),
    );
    _setEmbedDepsForTesting({
      embedMany: (async ({ values }: { values: string[] }) => ({
        embeddings: values.map((value) => seededVector(value)),
      })) as unknown as typeof import("ai").embedMany,
      createEmbeddingProvider: (async () => ({
        embedding: (_id: string) => ({}),
      })) as unknown as typeof createEmbeddingProvider,
    });
    resetEmbedder();
    _setGenerateDepsForTesting({
      generateText: (async () => ({
        output: {},
      })) as unknown as typeof import("ai").generateText,
      createLLMProvider: (async () => ({
        chat: (_id: string) => ({}),
      })) as unknown as typeof createLLMProvider,
    });

    const db = getDb(dbPath);
    _setDbForTesting(db);
    await initSearch();
    await rebuildIndex();
  });

  afterEach(() => {
    stopServer();
    cleanupStaticMirror?.();
    cleanupStaticMirror = null;
    _resetConfigForTesting();
    _resetGenerateDepsForTesting();
    _resetEmbedDepsForTesting();
    resetEmbedder();
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

    const { results: searchResults } = await searchMemories(
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

    const { results: afterDelete } = await searchMemories(
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

    const { results } = await searchMemories("SQLite", containerTag, 10);
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
    _setConfigForTesting(
      makeTestConfig({
        storage: { path: tmpDir },
        web: { port },
      }),
    );

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

    const { results: searchA } = await searchMemories(
      "rust memory",
      containerTag,
      10,
    );
    const { results: searchB } = await searchMemories(
      "rust memory",
      containerTag,
      10,
    );

    expect(searchA.map((r) => r.memory.id)).toEqual(
      searchB.map((r) => r.memory.id),
    );
  });

  test("covers server error and validation paths", async () => {
    cleanupStaticMirror = ensureStaticMirrorWithScript();
    const port = 19748;
    _setConfigForTesting(
      makeTestConfig({
        storage: { path: tmpDir },
        web: { port },
      }),
    );

    await startServer(tmpDir);
    expect(getServerState()).toBe("ready");

    const base = `http://127.0.0.1:${port}`;
    const httpFetch = Bun.fetch;

    const csrfRes = await httpFetch(`${base}/api/csrf-token`);
    const csrf = (await csrfRes.json()) as { token: string };

    const forbiddenRes = await httpFetch(`${base}/api/csrf-token`, {
      headers: { Host: "example.com" },
    });
    expect(forbiddenRes.status).toBe(403);

    const missingContentRes = await httpFetch(`${base}/api/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf.token,
      },
      body: JSON.stringify({ tags: ["missing-content"] }),
    });
    expect(missingContentRes.status).toBe(400);

    const tooLargeRes = await httpFetch(`${base}/api/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf.token,
      },
      body: "x".repeat(1_048_577),
    });
    expect(tooLargeRes.status).toBe(413);

    let gotRateLimited = false;
    for (let i = 0; i < 120; i++) {
      const res = await httpFetch(`${base}/api/csrf-token`);
      if (res.status === 429) {
        gotRateLimited = true;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(gotRateLimited).toBe(true);

    await Bun.sleep(1100);
    const afterRefill = await httpFetch(`${base}/api/csrf-token`);
    expect(afterRefill.status).toBe(200);

    const missingIdGet = await httpFetch(`${base}/api/memories/`);
    expect(missingIdGet.status).toBe(400);

    const notFoundMemory = await httpFetch(`${base}/api/memories/not-real`);
    expect(notFoundMemory.status).toBe(404);

    const missingIdDelete = await httpFetch(`${base}/api/memories/`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrf.token },
    });
    expect(missingIdDelete.status).toBe(400);

    const missingSearchQ = await httpFetch(`${base}/api/search`);
    expect(missingSearchQ.status).toBe(400);

    const scriptRes = await httpFetch(`${base}/test-script.js`);
    expect(scriptRes.status).toBe(200);
    expect(scriptRes.headers.get("content-type") ?? "").toContain(
      "application/javascript",
    );

    const notFoundRoute = await httpFetch(`${base}/api/unknown`);
    expect(notFoundRoute.status).toBe(404);

    const originalFile = Bun.file;
    Bun.file = ((
      path: string | URL | ArrayBufferLike | Uint8Array<ArrayBuffer> | number,
    ) => {
      throw new Error(`forced static failure: ${path}`);
    }) as typeof Bun.file;

    try {
      const serverErrorRes = await httpFetch(`${base}/test-script.js`);
      expect(serverErrorRes.status).toBe(500);
    } finally {
      Bun.file = originalFile;
    }

    const profileRes = await httpFetch(`${base}/api/profile`);
    expect(profileRes.status).toBe(200);
  });

  test("sets error server state when port is unavailable", async () => {
    const originalServe = Bun.serve;
    let attempts = 0;

    Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
      attempts += 1;
      void options;
      throw new Error("EADDRINUSE simulated");
    }) as typeof Bun.serve;

    try {
      await expect(startServer(tmpDir)).rejects.toThrow("EADDRINUSE simulated");
    } finally {
      Bun.serve = originalServe;
    }

    expect(attempts).toBe(1);
    expect(getServerState()).toBe("error");
  });
});
