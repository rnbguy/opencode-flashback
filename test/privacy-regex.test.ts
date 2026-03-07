import { describe, expect, test } from "bun:test";
import { stripPrivate } from "../src/util/privacy";

// -- Base64 Regex Tightening Tests -----------------------------------------------

describe("stripPrivate - base64 regex tightening", () => {
  test("detects base64 with + character (real API key pattern)", () => {
    // Real base64 keys often have + and / characters
    const token = "dGVzdGtleXdpdGhwbHVzK2FuZHNsYXNo/3Rlc3Q=";
    const input = `secret: ${token}`;
    const result = stripPrivate(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(token);
  });

  test("detects base64 with / character (real API key pattern)", () => {
    // Real base64 keys often have / character
    const token = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij/klmnop";
    const input = `token: ${token}`;
    const result = stripPrivate(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(token);
  });

  test("detects base64 with = padding at end (real API key pattern)", () => {
    // Real base64 keys often end with = or == padding
    const token = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD==";
    const input = `key: ${token}`;
    const result = stripPrivate(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(token);
  });

  test("does NOT redact long English text without special chars", () => {
    // Normal English sentence with no +, /, or = padding
    const text =
      "The authentication middleware validates the incoming request headers";
    const result = stripPrivate(text);
    expect(result).toBe(text);
  });

  test("does NOT redact long alphanumeric string without +, /, or =", () => {
    // 50+ chars of pure alphanumeric (no special chars, no padding)
    const text = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = stripPrivate(text);
    expect(result).toBe(text);
  });

  test("does NOT redact camelCase code identifiers", () => {
    // Common code pattern: camelCase variable names
    const text =
      "const myAuthenticationTokenValidationFunctionNameIsVeryLong = 42;";
    const result = stripPrivate(text);
    expect(result).toBe(text);
  });

  test("detects base64 with both + and / characters", () => {
    // Real base64 with multiple special chars
    const token = "dGVzdGtleXdpdGhwbHVzK2FuZHNsYXNoL3Rlc3Q=";
    const input = `api_key: ${token}`;
    const result = stripPrivate(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain(token);
  });

  test("preserves text with base64-like prefix but no special chars", () => {
    // URL-like text that is 40+ chars but has no +, /, or = padding
    const text = "https://example.com/path/to/resource/with/many/segments/here";
    const result = stripPrivate(text);
    expect(result).toBe(text);
  });
});
