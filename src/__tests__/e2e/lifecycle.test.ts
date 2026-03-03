import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  mock,
} from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { PluginConfig } from "../../config.ts";

const isDirectLifecycleRun =
  process.argv.some(
    (arg) =>
      arg.endsWith("src/__tests__/e2e/lifecycle.test.ts") ||
      arg.endsWith("lifecycle.test.ts"),
  ) && !process.argv.some((arg) => arg.endsWith("embedder.test.ts"));

if (isDirectLifecycleRun) {
  mock.module("../../embed/embedder.ts", () => ({
    embed: async (texts: string[]) =>
      texts.map((text) =>
        Array.from(
          { length: 768 },
          (_, index) => Math.sin(index + text.length) * 0.5,
        ),
      ),
    initEmbedder: async () => {},
    getEmbedderState: () => "ready" as const,
    resetEmbedder: () => {},
  }));
}

import { OpenCodeFlashbackPlugin } from "../../plugin.ts";
import {
  getDb,
  closeDb,
  _setDbForTesting,
  countMemories,
} from "../../db/database.ts";
import { _setConfigForTesting, _resetConfigForTesting } from "../../config.ts";
import { initSearch } from "../../search/index.ts";
import { startServer, stopServer } from "../../web/server.ts";
import { _resetTagCache, resolveContainerTag } from "../../core/tags.ts";
import { addMemory } from "../../core/memory.ts";

type ToolRunner = {
  execute: (
    args: Record<string, unknown>,
    context: { directory: string; sessionID: string },
  ) => Promise<string>;
};

type Hooks = {
  config: (cfg: { command?: Record<string, unknown> }) => Promise<void>;
  tool: { memory: ToolRunner };
  "chat.message": (
    args: { sessionID: string },
    output: {
      parts: Array<Record<string, unknown>>;
      message: { id: string };
    },
  ) => Promise<void>;
  event: (args: {
    event: { type: string; properties: { sessionID: string } };
  }) => Promise<void>;
};

type ConfigOverrides = {
  llm?: Partial<PluginConfig["llm"]>;
  storage?: Partial<PluginConfig["storage"]>;
  memory?: Partial<PluginConfig["memory"]>;
  web?: Partial<PluginConfig["web"]>;
  search?: Partial<PluginConfig["search"]>;
};

function makeTestConfig(
  storagePath: string,
  overrides?: ConfigOverrides,
): PluginConfig {
  return {
    memory: {
      maxResults: 10,
      autoCapture: true,
      injection: "first",
      excludeCurrentSession: false,
      ...(overrides?.memory ?? {}),
    },
    web: {
      port: 19848,
      enabled: true,
      ...(overrides?.web ?? {}),
    },
    search: {
      retrievalQuality: "balanced",
      ...(overrides?.search ?? {}),
    },
    llm: {
      provider: "openai-chat",
      model: "test",
      apiUrl: "http://localhost:9999",
      apiKey: "test-key",
      ...(overrides?.llm ?? {}),
    },
    storage: {
      path: storagePath,
      ...(overrides?.storage ?? {}),
    },
    toasts: {
      autoCapture: true,
      userProfile: true,
      errors: true,
    },
    compaction: {
      enabled: true,
      memoryLimit: 10,
    },
  };
}


async function createHooks(directory: string): Promise<Hooks> {
  const hooks = await OpenCodeFlashbackPlugin({ directory } as unknown as never);
  return hooks as unknown as Hooks;
}

async function runMemoryTool(
  hooks: Hooks,
  args: Record<string, unknown>,
  context: { directory: string; sessionID: string },
): Promise<Record<string, unknown>> {
  const raw = await hooks.tool.memory.execute(args, context);
  return JSON.parse(raw) as Record<string, unknown>;
}

function ensureStaticMirror(): () => void {
  const sourceDir = join(process.cwd(), "src", "web");
  const mirrorDir = join(sourceDir, "web");
  const created = !existsSync(mirrorDir);

  if (created) {
    mkdirSync(mirrorDir, { recursive: true });
    copyFileSync(join(sourceDir, "index.html"), join(mirrorDir, "index.html"));
    copyFileSync(join(sourceDir, "styles.css"), join(mirrorDir, "styles.css"));
  }

  return () => {
    if (created) {
      rmSync(mirrorDir, { recursive: true, force: true });
    }
  };
}

const lifecycleDescribe = isDirectLifecycleRun ? describe : describe.skip;

lifecycleDescribe("e2e: plugin lifecycle and web api", () => {
  let tmpDir = "";
  let cleanupStaticMirror: (() => void) | null = null;
  let nextPort = 19848;

  beforeEach(async () => {
    stopServer();
    closeDb();
    _resetConfigForTesting();
    _resetTagCache();

    tmpDir = mkdtempSync(join(tmpdir(), "flashback-e2e-"));
    const config = makeTestConfig(tmpDir, {
      web: { port: nextPort++, enabled: true },
    });
    _setConfigForTesting(config);

    const db = getDb(join(tmpDir, "flashback.db"));
    _setDbForTesting(db);
    await initSearch();
  });

  afterEach(() => {
    stopServer();
    cleanupStaticMirror?.();
    cleanupStaticMirror = null;
    _resetConfigForTesting();
    closeDb();
    _resetTagCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    stopServer();
    closeDb();
    _resetConfigForTesting();
    _resetTagCache();
    if (isDirectLifecycleRun) {
      mock.restore();
    }
  });

  test("plugin factory returns hooks and config registers 14 commands", async () => {
    const hooks = await createHooks(tmpDir);
    expect(typeof hooks.config).toBe("function");
    expect(typeof hooks.tool.memory.execute).toBe("function");
    expect(typeof hooks["chat.message"]).toBe("function");
    expect(typeof hooks.event).toBe("function");

    const cfg: { command?: Record<string, unknown> } = { command: {} };
    await hooks.config(cfg);
    expect(cfg.command).toBeDefined();
    expect(Object.keys(cfg.command ?? {}).length).toBe(14);
  });

  test("tool execution handles all 14 modes and validation errors", async () => {
    const hooks = await createHooks(tmpDir);
    const context = { directory: tmpDir, sessionID: "test-session" };

    const addResult = await runMemoryTool(
      hooks,
      {
        mode: "add",
        content: "tool mode lifecycle test memory",
        tags: ["e2e"],
      },
      context,
    );
    expect(addResult.mode).toBe("add");
    expect(addResult.success).toBe(true);

    const memoryId = String(addResult.id ?? "");
    expect(memoryId.length).toBeGreaterThan(0);

    const searchResult = await runMemoryTool(
      hooks,
      { mode: "search", query: "lifecycle" },
      context,
    );
    expect(searchResult.mode).toBe("search");
    expect(Number(searchResult.count)).toBeGreaterThanOrEqual(1);

    const recallResult = await runMemoryTool(
      hooks,
      { mode: "recall" },
      context,
    );
    expect(recallResult.mode).toBe("recall");

    const listResult = await runMemoryTool(
      hooks,
      { mode: "list", limit: 10 },
      context,
    );
    expect(listResult.mode).toBe("list");

    const profileResult = await runMemoryTool(
      hooks,
      { mode: "profile" },
      context,
    );
    expect(profileResult.mode).toBe("profile");

    const statsResult = await runMemoryTool(hooks, { mode: "stats" }, context);
    expect(statsResult.mode).toBe("stats");

    const contextResult = await runMemoryTool(
      hooks,
      { mode: "context" },
      context,
    );
    expect(contextResult.mode).toBe("context");

    const helpResult = await runMemoryTool(hooks, { mode: "help" }, context);
    expect(helpResult.mode).toBe("help");

    const exportResult = await runMemoryTool(
      hooks,
      { mode: "export", format: "markdown" },
      context,
    );
    expect(exportResult.mode).toBe("export");

    const relatedResult = await runMemoryTool(
      hooks,
      { mode: "related" },
      context,
    );
    expect(relatedResult.mode).toBe("related");

    const reviewResult = await runMemoryTool(
      hooks,
      { mode: "review" },
      context,
    );
    expect(reviewResult.mode).toBe("review");

    const suspendResult = await runMemoryTool(
      hooks,
      { mode: "suspend", id: memoryId },
      context,
    );
    expect(suspendResult.mode).toBe("suspend");

    const consolidateResult = await runMemoryTool(
      hooks,
      { mode: "consolidate", dryRun: true },
      context,
    );
    expect(consolidateResult.mode).toBe("consolidate");

    const forgetResult = await runMemoryTool(
      hooks,
      { mode: "forget", id: memoryId },
      context,
    );
    expect(forgetResult.mode).toBe("forget");
    expect(forgetResult.success).toBe(true);

    const unknownMode = await runMemoryTool(
      hooks,
      { mode: "unknown-mode" },
      context,
    );
    expect(String(unknownMode.error ?? "")).toContain("Unknown mode");

    const missingForgetId = await runMemoryTool(
      hooks,
      { mode: "forget" },
      context,
    );
    expect(missingForgetId.error).toBe("Missing memory id");

    const missingAddContent = await runMemoryTool(
      hooks,
      { mode: "add" },
      context,
    );
    expect(missingAddContent.mode).toBe("add");
    expect(missingAddContent.success).toBe(false);
  });

  test("chat.message injects context once per session when injection is first", async () => {
    _setConfigForTesting(
      makeTestConfig(tmpDir, {
        memory: { injection: "first", autoCapture: true },
      }),
    );

    const tag = resolveContainerTag(tmpDir).tag;
    await addMemory({
      content: "Rust project context memory",
      containerTag: tag,
      tags: ["rust"],
    });

    const hooks = await createHooks(tmpDir);

    const output1: {
      parts: Array<Record<string, unknown>>;
      message: { id: string };
    } = {
      parts: [],
      message: { id: "msg-1" },
    };
    await hooks["chat.message"]({ sessionID: "ses-1" }, output1);

    expect(output1.parts.length).toBe(1);
    expect(output1.parts[0].synthetic).toBe(true);
    expect(String(output1.parts[0].text ?? "")).toContain("[MEMORY]");

    const output2: {
      parts: Array<Record<string, unknown>>;
      message: { id: string };
    } = {
      parts: [],
      message: { id: "msg-2" },
    };
    await hooks["chat.message"]({ sessionID: "ses-1" }, output2);
    expect(output2.parts.length).toBe(0);

    const output3: {
      parts: Array<Record<string, unknown>>;
      message: { id: string };
    } = {
      parts: [],
      message: { id: "msg-3" },
    };
    await hooks["chat.message"]({ sessionID: "ses-2" }, output3);
    expect(output3.parts.length).toBe(1);
    expect(output3.parts[0].synthetic).toBe(true);
  });

  test("event hook enqueues capture only when autoCapture is enabled", async () => {
    _setConfigForTesting(
      makeTestConfig(tmpDir, {
        memory: { autoCapture: true, injection: "first" },
      }),
    );

    const hooks = await createHooks(tmpDir);

    const originalSetTimeout = globalThis.setTimeout;
    const timerDelays: number[] = [];
    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (typeof timeout === "number") {
        timerDelays.push(timeout);
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses-1" } },
    });
    expect(timerDelays.includes(5000)).toBe(true);

    _setConfigForTesting(
      makeTestConfig(tmpDir, {
        memory: { autoCapture: false, injection: "first" },
      }),
    );

    const beforeDisabled = timerDelays.filter((delay) => delay === 5000).length;
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses-1" } },
    });
    const afterDisabled = timerDelays.filter((delay) => delay === 5000).length;
    expect(afterDisabled).toBe(beforeDisabled);

    globalThis.setTimeout = originalSetTimeout;
  });

  test("web server api responds across lifecycle endpoints", async () => {
    cleanupStaticMirror = ensureStaticMirror();

    const port = 19848 + Math.floor(Math.random() * 1000);
    _setConfigForTesting(
      makeTestConfig(tmpDir, { web: { port, enabled: true } }),
    );

    const tag = resolveContainerTag(tmpDir).tag;
    expect(countMemories(getDb(), tag)).toBe(0);

    await startServer(tmpDir);
    const baseUrl = `http://127.0.0.1:${port}`;
    const httpFetch = Bun.fetch;

    const csrfRes = await httpFetch(`${baseUrl}/api/csrf-token`);
    expect(csrfRes.status).toBe(200);
    const csrf = (await csrfRes.json()) as { token: string };
    expect(typeof csrf.token).toBe("string");
    expect(csrf.token.length).toBeGreaterThan(0);

    const diagnosticsRes = await httpFetch(`${baseUrl}/api/diagnostics`);
    expect(diagnosticsRes.status).toBe(200);
    const diagnostics = (await diagnosticsRes.json()) as {
      memoryCount: number;
    };
    expect(typeof diagnostics.memoryCount).toBe("number");

    const listRes = await httpFetch(`${baseUrl}/api/memories`);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { memories: unknown[] };
    expect(Array.isArray(listed.memories)).toBe(true);

    const createRes = await httpFetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf.token,
      },
      body: JSON.stringify({ content: "web api e2e memory", tags: ["api"] }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };
    expect(typeof created.id).toBe("string");

    const byIdRes = await httpFetch(`${baseUrl}/api/memories/${created.id}`);
    expect(byIdRes.status).toBe(200);
    const byId = (await byIdRes.json()) as { id: string };
    expect(byId.id).toBe(created.id);

    const searchRes = await httpFetch(`${baseUrl}/api/search?q=web%20api`);
    expect(searchRes.status).toBe(200);
    const searchData = (await searchRes.json()) as { results: unknown[] };
    expect(Array.isArray(searchData.results)).toBe(true);

    const deleteRes = await httpFetch(`${baseUrl}/api/memories/${created.id}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": csrf.token },
    });
    expect(deleteRes.status).toBe(200);

    const profileRes = await httpFetch(`${baseUrl}/api/profile`);
    expect(profileRes.status).toBe(200);

    const indexRes = await httpFetch(`${baseUrl}/`);
    expect(indexRes.status).toBe(200);
    expect(indexRes.headers.get("content-type") ?? "").toContain("text/html");

    const stylesRes = await httpFetch(`${baseUrl}/styles.css`);
    expect(stylesRes.status).toBe(200);
    expect(stylesRes.headers.get("content-type") ?? "").toContain("text/css");

    stopServer();
  });

  test("cold start plugin factory returns hooks under 50ms", async () => {
    const started = performance.now();
    const hooks = await createHooks(tmpDir);
    const elapsedMs = performance.now() - started;

    expect(hooks).toBeDefined();
    expect(elapsedMs).toBeLessThan(50);
  });
});
