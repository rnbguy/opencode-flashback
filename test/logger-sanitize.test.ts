import { describe, expect, test } from "bun:test";
import { sanitizeContext } from "../src/util/logger.ts";

describe("logger sanitizeContext", () => {
  test("redacts API key by key name", () => {
    const data = { apiKey: "sk-proj-abc123def456ghi789", count: 5 };
    const result = sanitizeContext(data);
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.count).toBe(5);
  });

  test("redacts OpenAI-style key by value pattern", () => {
    const data = { config: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx" };
    const result = sanitizeContext(data);
    expect(result.config).toBe("[REDACTED]");
  });

  test("redacts Google API key by value pattern", () => {
    const data = { key: "AIzaSyD-someGoogleApiKeyValueHere1234" };
    const result = sanitizeContext(data);
    expect(result.key).toBe("[REDACTED]");
  });

  test("redacts Bearer token by value pattern", () => {
    const data = {
      header: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.long.token",
    };
    const result = sanitizeContext(data);
    expect(result.header).toBe("[REDACTED]");
  });

  test("redacts sensitive key names case-insensitively", () => {
    const data = {
      SECRET: "my-secret-value",
      token: "my-token-value",
      PASSWORD: "my-password",
      authorization: "Basic dXNlcjpwYXNz",
    };
    const result = sanitizeContext(data);
    expect(result.SECRET).toBe("[REDACTED]");
    expect(result.token).toBe("[REDACTED]");
    expect(result.PASSWORD).toBe("[REDACTED]");
    expect(result.authorization).toBe("[REDACTED]");
  });

  test("preserves non-sensitive values", () => {
    const data = {
      query: "how to deploy",
      containerTag: "mem_project_abc123",
      resultCount: 10,
      enabled: true,
    };
    const result = sanitizeContext(data);
    expect(result).toEqual(data);
  });

  test("handles nested objects", () => {
    const data = {
      config: {
        apiKey: "sk-proj-secret123456789012345",
        model: "gpt-4o",
      },
    };
    const result = sanitizeContext(data) as { config: Record<string, unknown> };
    expect(result.config.apiKey).toBe("[REDACTED]");
    expect(result.config.model).toBe("gpt-4o");
  });
});
