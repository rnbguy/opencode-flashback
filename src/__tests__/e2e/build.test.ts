import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DIST_INDEX = join(import.meta.dir, "../../../dist/index.js");

describe("build output", () => {
  test("dist/index.js exists", () => {
    expect(existsSync(DIST_INDEX)).toBe(true);
  });

  test("does not inline onnxruntime-node native binding", () => {
    const content = readFileSync(DIST_INDEX, "utf-8");

    // onnxruntime-node/dist/binding.js uses require('../bin/napi-v3/...') which
    // resolves against dist/ at runtime instead of node_modules/, causing:
    //   ResolveMessage: Cannot find module '../bin/napi-v3/linux/x64/onnxruntime_binding.node'
    expect(content).not.toContain(
      "node_modules/onnxruntime-node/dist/binding.js",
    );
  });

  test("does not contain napi-v3 native binary path", () => {
    const content = readFileSync(DIST_INDEX, "utf-8");

    // The native binary path pattern that fails at runtime from dist/
    expect(content).not.toMatch(/napi-v3.*onnxruntime_binding/);
  });
});
