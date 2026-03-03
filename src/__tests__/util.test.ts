import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveSecret } from "../util/secrets";
import { stripPrivate } from "../util/privacy";
import { createLogger } from "../util/logger";
import { getLanguageName } from "../util/language";
import { LOG_FILENAME } from "../consts.ts";

// -- resolveSecret ------------------------------------------------------------

describe("resolveSecret", () => {
  test("returns empty string for empty value", async () => {
    expect(await resolveSecret("")).toBe("");
  });

  test("returns direct value for non-prefixed string", async () => {
    expect(await resolveSecret("sk-abc123")).toBe("sk-abc123");
  });

  test("resolves env:// from environment variable", async () => {
    const key = `TEST_SECRET_${Date.now()}`;
    process.env[key] = "secret-value";
    try {
      expect(await resolveSecret(`env://${key}`)).toBe("secret-value");
    } finally {
      delete process.env[key];
    }
  });

  test("env:// returns empty string for missing var", async () => {
    expect(await resolveSecret("env://NONEXISTENT_VAR_12345")).toBe("");
  });

  test("resolves file:// from filesystem", async () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-test-"));
    const filePath = join(dir, "key.txt");
    writeFileSync(filePath, "  file-secret-value  \n");
    try {
      expect(await resolveSecret(`file://${filePath}`)).toBe(
        "file-secret-value",
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("file:// returns empty string for missing file", async () => {
    expect(await resolveSecret("file:///tmp/nonexistent-file-12345")).toBe("");
  });

  test("file:// with tilde expansion", async () => {
    // We can't easily test ~ expansion to a real file without side effects,
    // but we can verify a missing ~ path returns empty
    expect(await resolveSecret("file://~/nonexistent-secret-file")).toBe("");
  });

  test("returns value with special characters", async () => {
    expect(await resolveSecret("p@ss=w0rd!#$%")).toBe("p@ss=w0rd!#$%");
  });
});

describe("getLanguageName", () => {
  test("returns known language names", () => {
    expect(getLanguageName("en")).toBe("English");
    expect(getLanguageName("fr")).toBe("French");
    expect(getLanguageName("ja")).toBe("Japanese");
  });

  test("falls back to English for unknown code", () => {
    expect(getLanguageName("xx")).toBe("English");
  });

  test("falls back to English for empty string", () => {
    expect(getLanguageName("")).toBe("English");
  });
});

// -- stripPrivate -------------------------------------------------------------

describe("stripPrivate", () => {
  test("returns unchanged text with no secrets", () => {
    expect(stripPrivate("hello world")).toBe("hello world");
  });

  test("returns empty string unchanged", () => {
    expect(stripPrivate("")).toBe("");
  });

  test("strips <private> XML blocks", () => {
    const input = "before <private>secret data</private> after";
    const result = stripPrivate(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("secret data");
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  test("strips multiline <private> blocks", () => {
    const input = `start
<private>
line1
line2
</private>
end`;
    const result = stripPrivate(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("line1");
    expect(result).not.toContain("line2");
  });

  test("strips OpenAI keys (sk-...)", () => {
    const input = "key: sk-abcdefghijklmnopqrstuvwxyz1234567890";
    const result = stripPrivate(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
  });

  test("strips GitHub PATs (ghp_...)", () => {
    const input = "token: ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const result = stripPrivate(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });

  test("strips AWS access keys (AKIA...)", () => {
    const input = "aws: AKIAIOSFODNN7EXAMPLE";
    const result = stripPrivate(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("strips PEM private key blocks", () => {
    const input = `text
-----BEGIN RSA PRIVATE KEY-----
MIIBogIBAAJBALRiMLAH
-----END RSA PRIVATE KEY-----
more text`;
    const result = stripPrivate(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("MIIBogIBAAJBALRiMLAH");
  });

  test("strips Slack tokens (xoxb-...)", () => {
    const input = "slack: xoxb-123456789012-abcdefghij";
    const result = stripPrivate(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("xoxb-123456789012");
  });

  test("strips base64-like high-entropy tokens", () => {
    // 40+ chars of base64-like content
    const token = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop";
    const input = `token: ${token}`;
    const result = stripPrivate(input);
    expect(result).toContain("[REDACTED]");
  });

  test("strips multiple secrets in same text", () => {
    const input =
      "keys: sk-abcdefghijklmnopqrstuvwxyz1234567890 and ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const result = stripPrivate(input);
    // Both should be redacted
    expect(result).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });

  test("handles xoxp- and xoxs- Slack token variants", () => {
    expect(stripPrivate("xoxp-1234567890-abc")).toContain("[REDACTED]");
    expect(stripPrivate("xoxs-1234567890-abc")).toContain("[REDACTED]");
  });

  test("preserves short non-secret text", () => {
    const input = "user said hello";
    expect(stripPrivate(input)).toBe("user said hello");
  });
});

// -- createLogger -------------------------------------------------------------

describe("createLogger", () => {
  let tmpDir: string;

  async function waitForLogFlush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "logger-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test("creates log file on first write", async () => {
    const logger = createLogger(tmpDir, "test-session");
    logger.info("hello");
    await waitForLogFlush();

    const logPath = join(tmpDir, LOG_FILENAME);
    expect(existsSync(logPath)).toBe(true);
  });

  test("writes JSON-L format", async () => {
    const logger = createLogger(tmpDir, "ses_001");
    logger.info("test message");
    await waitForLogFlush();

    const logPath = join(tmpDir, LOG_FILENAME);
    const content = readFileSync(logPath, "utf-8").trim();
    const entry = JSON.parse(content);

    expect(entry.level).toBe("INFO");
    expect(entry.msg).toBe("test message");
    expect(entry.sid).toBe("ses_001");
    expect(entry.ts).toBeDefined();
    expect(entry.pid).toBe(process.pid);
  });

  test("all log levels write correctly", async () => {
    const logger = createLogger(tmpDir, "ses_levels");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    await waitForLogFlush();

    const logPath = join(tmpDir, LOG_FILENAME);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(4);

    const levels = lines.map((l) => JSON.parse(l).level);
    expect(levels).toEqual(["DEBUG", "INFO", "WARN", "ERROR"]);
  });

  test("includes extra data fields", async () => {
    const logger = createLogger(tmpDir, "ses_data");
    logger.info("with data", { count: 42, tag: "test" });
    await waitForLogFlush();

    const logPath = join(tmpDir, LOG_FILENAME);
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(entry.count).toBe(42);
    expect(entry.tag).toBe("test");
  });

  test("omits data field when empty object", async () => {
    const logger = createLogger(tmpDir, "ses_empty");
    logger.info("no data", {});
    await waitForLogFlush();

    const logPath = join(tmpDir, LOG_FILENAME);
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    // Should not spread empty object keys
    expect(Object.keys(entry).sort()).toEqual(
      ["level", "msg", "pid", "sid", "ts"].sort(),
    );
  });

  test("appends multiple entries (not overwrite)", async () => {
    const logger = createLogger(tmpDir, "ses_append");
    logger.info("first");
    logger.info("second");
    logger.info("third");
    await waitForLogFlush();

    const logPath = join(tmpDir, LOG_FILENAME);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).msg).toBe("first");
    expect(JSON.parse(lines[2]).msg).toBe("third");
  });

  test("each line is valid JSON", async () => {
    const logger = createLogger(tmpDir, "ses_json");
    logger.info("msg1", { a: 1 });
    logger.warn("msg2");
    logger.error("msg3", { err: "boom" });
    await waitForLogFlush();

    const logPath = join(tmpDir, LOG_FILENAME);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("handles data=undefined gracefully", async () => {
    const logger = createLogger(tmpDir, "ses_undef");
    logger.info("no extra");
    await waitForLogFlush();

    const logPath = join(tmpDir, LOG_FILENAME);
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(entry.msg).toBe("no extra");
  });
});
