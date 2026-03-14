import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { _resetConfigForTesting, _setConfigForTesting } from "../src/config.ts";
import { DB_FILENAME } from "../src/consts.ts";
import {
  _resetEmbedDepsForTesting,
  _setEmbedDepsForTesting,
  resetEmbedder,
} from "../src/core/ai/embed.ts";
import type { createEmbeddingProvider } from "../src/core/ai/providers.ts";
import { addMemory } from "../src/core/memory.ts";
import { _resetTagCache, resolveContainerTag } from "../src/core/tags.ts";
import { _setDbForTesting, closeDb, getDb } from "../src/db/database.ts";
import { OpenCodeFlashbackPlugin } from "../src/plugin.ts";
import { initSearch } from "../src/search.ts";
import { makeTestConfig } from "./fixtures/config.ts";

type Hooks = {
  "chat.message": (
    args: { sessionID: string },
    output: {
      parts: Array<Record<string, unknown>>;
      message: { id: string };
    },
  ) => Promise<void>;
};

async function createHooks(directory: string): Promise<Hooks> {
  const hooks = await OpenCodeFlashbackPlugin({
    directory,
  } as unknown as never);
  return hooks as unknown as Hooks;
}

describe("regression: injected part IDs must start with 'prt'", () => {
  let tmpDir: string;

  beforeEach(async () => {
    closeDb();
    _resetConfigForTesting();
    _resetTagCache();

    tmpDir = mkdtempSync(join(tmpdir(), "flashback-partid-"));
    _setConfigForTesting(
      makeTestConfig({
        llm: { apiKey: "test-key" },
        storage: { path: tmpDir },
        memory: {
          injection: "every",
          autoCapture: false,
          excludeCurrentSession: false,
        },
      }),
    );
    _setEmbedDepsForTesting({
      embedMany: (async ({ values }: { values: string[] }) => ({
        embeddings: values.map((text) =>
          Array.from(
            { length: 768 },
            (_, index) => Math.sin(index + text.length) * 0.5,
          ),
        ),
      })) as unknown as typeof import("ai").embedMany,
      createEmbeddingProvider: (async () => ({
        embedding: (_id: string) => ({}),
      })) as unknown as typeof createEmbeddingProvider,
    });
    resetEmbedder();

    const db = getDb(join(tmpDir, DB_FILENAME));
    _setDbForTesting(db);
    await initSearch();
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetEmbedDepsForTesting();
    resetEmbedder();
    closeDb();
    _resetTagCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("chat.message injected part ID starts with 'prt'", async () => {
    const tag = resolveContainerTag(tmpDir).tag;
    await addMemory({
      content: "test memory for part ID validation",
      containerTag: tag,
      tags: ["test"],
    });

    const hooks = await createHooks(tmpDir);

    const output: {
      parts: Array<Record<string, unknown>>;
      message: { id: string };
    } = {
      parts: [],
      message: { id: "msg-1" },
    };
    await hooks["chat.message"]({ sessionID: "ses-partid-1" }, output);

    expect(output.parts.length).toBe(1);
    const partId = String(output.parts[0].id);
    expect(partId.startsWith("prt")).toBe(true);
  });
});
