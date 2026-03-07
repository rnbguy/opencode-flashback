import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  closeDb,
  getDb,
  getMemoriesByIds,
  getMemory,
  insertMemory,
} from "../src/db/database.ts";
import { makeTestMemory } from "./fixtures/memory.ts";

describe("getMemoriesByIds batch fetch", () => {
  let tmpDir: string;

  beforeEach(() => {
    closeDb();
    tmpDir = mkdtempSync(join(tmpdir(), "flashback-batch-"));
    getDb(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("batch fetch returns same results as individual fetches", () => {
    const db = getDb();
    const ids = ["m1", "m2", "m3", "m4", "m5"];
    for (const id of ids) {
      insertMemory(db, makeTestMemory(id, "test"));
    }

    const individual = ids
      .map((id) => getMemory(db, id))
      .filter((m): m is NonNullable<typeof m> => m !== null);
    const batch = getMemoriesByIds(db, ids);

    expect(batch.length).toBe(5);
    for (const mem of individual) {
      const match = batch.find((b) => b.id === mem.id);
      expect(match).toBeDefined();
      expect(match!.content).toBe(mem.content);
      expect(match!.containerTag).toBe(mem.containerTag);
    }
  });

  test("empty array returns empty result", () => {
    const db = getDb();
    const result = getMemoriesByIds(db, []);
    expect(result).toEqual([]);
  });

  test("missing ids are silently skipped", () => {
    const db = getDb();
    insertMemory(db, makeTestMemory("exists", "test"));

    const result = getMemoriesByIds(db, ["exists", "missing1", "missing2"]);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("exists");
  });
});
