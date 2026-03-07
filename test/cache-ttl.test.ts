import { afterEach, describe, expect, test } from "bun:test";
import { _resetTagCache, resolveContainerTag } from "../src/core/tags.ts";
import { _resetSecretCache, resolveSecret } from "../src/util/secrets.ts";

describe("cache-ttl", () => {
  afterEach(() => {
    _resetTagCache();
    _resetSecretCache();
  });

  test("resolveContainerTag returns cached result within TTL", () => {
    const result1 = resolveContainerTag(process.cwd());
    const result2 = resolveContainerTag(process.cwd());
    expect(result1).toBe(result2);
  });

  test("_resetTagCache clears cache", () => {
    const result1 = resolveContainerTag(process.cwd());
    _resetTagCache();
    const result2 = resolveContainerTag(process.cwd());
    expect(result1).not.toBe(result2);
    expect(result1.tag).toBe(result2.tag);
  });

  test("resolveSecret resolves env var without caching", async () => {
    process.env.TEST_SECRET_CACHE = "value1";
    const result1 = await resolveSecret("env://TEST_SECRET_CACHE");
    expect(result1).toBe("value1");

    process.env.TEST_SECRET_CACHE = "value2";
    const result2 = await resolveSecret("env://TEST_SECRET_CACHE");
    expect(result2).toBe("value2");

    delete process.env.TEST_SECRET_CACHE;
  });
});
