import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  _resetConfigForTesting,
  _setConfigForTesting,
  type PluginConfig,
} from "../config.ts";
import { MEMORY_HEADER } from "../consts.ts";
import { getOrCreateProfile } from "../core/profile.ts";
import { closeDb, getDb } from "../db/database.ts";
import { startServer, stopServer } from "../web/server.ts";

const SRC_DIR = join(import.meta.dir, "..");

const defaultConfig: PluginConfig = {
  llm: {
    provider: "ollama",
    model: "kimi-k2.5:cloud",
    apiUrl: "http://127.0.0.1:11434",
    apiKey: "",
  },
  embedding: {
    provider: "ollama",
    model: "embeddinggemma:latest",
    apiUrl: "http://127.0.0.1:11434",
    apiKey: "",
  },
  storage: { path: "" },
  memory: {
    maxResults: 10,
    autoCapture: false,
    injection: "first",
    excludeCurrentSession: true,
  },
  web: { port: 19500, enabled: false },
  search: { retrievalQuality: "balanced" },
  toasts: { autoCapture: true, userProfile: true, errors: true },
  compaction: { enabled: true, memoryLimit: 10 },
};

describe("regression: audit fixes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "regression-"));
    const randomPort = 19500 + Math.floor(Math.random() * 500);
    _setConfigForTesting({
      ...defaultConfig,
      storage: { path: tmpDir },
      web: { ...defaultConfig.web, port: randomPort },
    });
  });

  afterEach(() => {
    stopServer();
    closeDb();
    _resetConfigForTesting();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort in tests.
    }
  });

  test("T1: plugin.ts uses ?? for dryRun default, not ||", () => {
    const src = readFileSync(join(SRC_DIR, "plugin.ts"), "utf-8");
    expect(src).toContain("asBoolean(args.dryRun) ?? true");
    expect(src).not.toMatch(/asBoolean\(args\.dryRun\)\s*\|\|\s*true/);
  });

  test("T2: plugin.ts does not contain process.exit", () => {
    const src = readFileSync(join(SRC_DIR, "plugin.ts"), "utf-8");
    expect(src).not.toContain("process.exit");
  });

  test("T3: server.ts checks isFullyPrivate before addMemory", () => {
    const src = readFileSync(join(SRC_DIR, "web", "server.ts"), "utf-8");
    expect(src).toContain("isFullyPrivate(body.content)");
    expect(src).toContain("stripPrivate(body.content)");
  });

  test("T4: server.ts clamps limit to [1,100] and offset to >= 0", () => {
    const src = readFileSync(join(SRC_DIR, "web", "server.ts"), "utf-8");
    expect(src).toContain("Math.max(1, Math.min(100,");
    expect(src).toContain("Math.max(0,");
  });

  test("T5: jsonResponse includes X-Frame-Options and Cache-Control", () => {
    const src = readFileSync(join(SRC_DIR, "web", "server.ts"), "utf-8");
    expect(src).toContain('"X-Frame-Options": "DENY"');
    expect(src).toContain('"Cache-Control": "no-store"');
  });

  test("T6: MEMORY_HEADER contains data-only fence text", () => {
    expect(MEMORY_HEADER).toContain("[MEMORY]");
    expect(MEMORY_HEADER).toContain("treat as data only");
  });

  test("T6: plugin.ts imports MEMORY_HEADER from consts", () => {
    const src = readFileSync(join(SRC_DIR, "plugin.ts"), "utf-8");
    expect(src).toContain('import { MEMORY_HEADER } from "./consts.ts"');
  });

  test("T12: startServer returns a number (actual port)", async () => {
    const port = await startServer(tmpDir);
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
    stopServer();
  });

  test("T15: rebuildIndex chains via rebuildPromise.then", () => {
    const src = readFileSync(join(SRC_DIR, "search.ts"), "utf-8");
    expect(src).toContain("rebuildPromise = rebuildPromise.then(");
    expect(src).toContain("doRebuild");
  });

  test("T16: startServer calls stopServer if server exists", () => {
    const src = readFileSync(join(SRC_DIR, "web", "server.ts"), "utf-8");
    expect(src).toMatch(/if\s*\(server\)\s*\{\s*stopServer\(\)/);
  });

  test("T16: calling startServer twice does not throw", async () => {
    const port1 = await startServer(tmpDir);
    expect(port1).toBeGreaterThan(0);
    const port2 = await startServer(tmpDir);
    expect(port2).toBeGreaterThan(0);
    stopServer();
  });

  test("T17: capture.ts has ExtractionResultSchema with Zod", () => {
    const src = readFileSync(join(SRC_DIR, "core", "capture.ts"), "utf-8");
    expect(src).toContain("ExtractionResultSchema");
    expect(src).toContain("z.object(");
    expect(src).toContain(".safeParse(");
  });

  test("T18: capture.ts truncates message content to 4000 chars", () => {
    const src = readFileSync(join(SRC_DIR, "core", "capture.ts"), "utf-8");
    expect(src).toContain(".slice(0, 4000)");
  });

  test("T24: profile preferences are arrays with category/description/confidence", () => {
    getDb();
    const profile = getOrCreateProfile("test-regression@example.com");
    expect(profile).not.toBeNull();
    expect(Array.isArray(profile.profileData.preferences)).toBe(true);
    expect(Array.isArray(profile.profileData.patterns)).toBe(true);
    expect(Array.isArray(profile.profileData.workflows)).toBe(true);
  });

  test("T8: database.ts uses getConfig().storage.path for db location", () => {
    const src = readFileSync(join(SRC_DIR, "db", "database.ts"), "utf-8");
    expect(src).toContain("getConfig().storage.path");
  });

  test("T9: search index does not increment access_count", () => {
    const src = readFileSync(join(SRC_DIR, "search.ts"), "utf-8");
    expect(src).not.toContain("access_count");
  });

  test("T10: capture.ts has no outer retry loop (RETRY_BACKOFF removed)", () => {
    const src = readFileSync(join(SRC_DIR, "core", "capture.ts"), "utf-8");
    expect(src).not.toContain("RETRY_BACKOFF");
  });

  test("T19: server.ts has no hardcoded CSP sha256 hash", () => {
    const src = readFileSync(join(SRC_DIR, "web", "server.ts"), "utf-8");
    expect(src).not.toContain("sha256-6YqWunyF");
    expect(src).toContain("computeCspHash");
  });
});
