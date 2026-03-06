import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { _resetConfigForTesting, _setConfigForTesting } from "../src/config.ts";
import { LOG_FILENAME } from "../src/consts.ts";
import { closeDb } from "../src/db/database.ts";
import { OpenCodeFlashbackPlugin } from "../src/plugin.ts";
import { getServerState, stopServer } from "../src/web/server.ts";
import { makeTestConfig } from "./fixtures/config.ts";

type ToolRunner = {
  execute: (
    args: Record<string, unknown>,
    context: { directory: string; sessionID: string },
  ) => Promise<string>;
};

type Hooks = {
  tool: { flashback: ToolRunner };
};

async function createHooks(directory: string): Promise<Hooks> {
  const hooks = await OpenCodeFlashbackPlugin({
    directory,
  } as unknown as never);
  return hooks as unknown as Hooks;
}

async function runMemoryTool(
  hooks: Hooks,
  args: Record<string, unknown>,
  context: { directory: string; sessionID: string },
): Promise<Record<string, unknown>> {
  const raw = await hooks.tool.flashback.execute(args, context);
  return JSON.parse(raw) as Record<string, unknown>;
}

async function waitForLogLine(
  directory: string,
  level: "INFO" | "WARN" | "ERROR",
  msg: string,
): Promise<void> {
  const logPath = join(directory, LOG_FILENAME);
  for (let i = 0; i < 100; i++) {
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf-8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
      const found = lines.some((line) => {
        const entry = JSON.parse(line) as { level?: string; msg?: string };
        return entry.level === level && entry.msg === msg;
      });
      if (found) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Missing log line [${level}] ${msg}`);
}

describe("webui tool mode", () => {
  let tmpDir = "";
  let nextPort = 20500;

  beforeEach(() => {
    stopServer();
    closeDb();
    _resetConfigForTesting();
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-webui-tool-"));
  });

  afterEach(() => {
    stopServer();
    closeDb();
    _resetConfigForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("plugin init does not auto-start server", async () => {
    const port = nextPort++;
    _setConfigForTesting(
      makeTestConfig({
        storage: { path: tmpDir },
        web: { port },
      }),
    );

    await createHooks(tmpDir);
    expect(getServerState()).not.toBe("ready");
  });

  test("start returns started=true", async () => {
    const port = nextPort++;
    _setConfigForTesting(
      makeTestConfig({
        storage: { path: tmpDir },
        web: { port },
      }),
    );
    const hooks = await createHooks(tmpDir);

    const result = await runMemoryTool(
      hooks,
      { mode: "webui", action: "start" },
      { directory: tmpDir, sessionID: "ses-webui-start" },
    );

    expect(result.mode).toBe("webui");
    expect(result.action).toBe("start");
    expect(result.started).toBe(true);
    expect(result.port).toBe(port);
    expect(result.text).toBe(`Web UI started at http://127.0.0.1:${port}`);
    expect(getServerState()).toBe("ready");
  });

  test("restart does not start when server is not running", async () => {
    const port = nextPort++;
    _setConfigForTesting(
      makeTestConfig({
        storage: { path: tmpDir },
        web: { port },
      }),
    );
    const hooks = await createHooks(tmpDir);

    const result = await runMemoryTool(
      hooks,
      { mode: "webui", action: "restart" },
      { directory: tmpDir, sessionID: "ses-webui-restart-stopped" },
    );

    expect(result.mode).toBe("webui");
    expect(result.action).toBe("restart");
    expect(result.restarted).toBe(false);
    expect(result.error).toBe("Server is not running");
    expect(result.text).toBe("Web UI restart skipped: server is not running");
    expect(getServerState()).not.toBe("ready");
    await waitForLogLine(
      tmpDir,
      "WARN",
      "Web UI restart skipped: server is not running",
    );
  });

  test("stop returns stopped=true after start", async () => {
    const port = nextPort++;
    _setConfigForTesting(
      makeTestConfig({
        storage: { path: tmpDir },
        web: { port },
      }),
    );
    const hooks = await createHooks(tmpDir);

    await runMemoryTool(
      hooks,
      { mode: "webui", action: "start" },
      { directory: tmpDir, sessionID: "ses-webui-stop-start" },
    );

    const result = await runMemoryTool(
      hooks,
      { mode: "webui", action: "stop" },
      { directory: tmpDir, sessionID: "ses-webui-stop" },
    );

    expect(result.mode).toBe("webui");
    expect(result.action).toBe("stop");
    expect(result.stopped).toBe(true);
    expect(result.text).toBe("Web UI stopped");
    expect(getServerState()).toBe("uninitialized");
    await waitForLogLine(tmpDir, "INFO", "Web UI stopped");
  });
});
