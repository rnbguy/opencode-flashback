import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

const DIST_INDEX = join(import.meta.dir, "../../dist/index.js");

describe("build output", () => {
  test("dist/index.js exists", () => {
    expect(existsSync(DIST_INDEX)).toBe(true);
  });
});
