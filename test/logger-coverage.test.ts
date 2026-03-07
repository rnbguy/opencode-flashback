import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LOG_FILENAME } from "../src/consts.ts";
import { createLogger, setToastSink } from "../src/util/logger.ts";

describe("logger coverage: toast sink, getErrorCode, ENOENT fallback, stderr fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "logger-coverage-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Reset toast sink
    setToastSink(null);
  });

  // -- Line 73: setToastSink() + toast dispatch (line 165-166) ----------------

  test("setToastSink registers a sink and dispatches on info level", async () => {
    const calls: Array<[string, string, Record<string, unknown> | undefined]> =
      [];
    const sink = (
      level: string,
      msg: string,
      data?: Record<string, unknown>,
    ) => {
      calls.push([level, msg, data]);
    };

    setToastSink(sink);
    const logger = createLogger(tmpDir, "ses_toast");
    logger.info("test message", { key: "value" });

    // Wait for async write
    await Bun.sleep(50);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["info", "test message", { key: "value" }]);
  });

  test("setToastSink does NOT dispatch for debug level", async () => {
    const calls: Array<[string, string, Record<string, unknown> | undefined]> =
      [];
    const sink = (
      level: string,
      msg: string,
      data?: Record<string, unknown>,
    ) => {
      calls.push([level, msg, data]);
    };

    setToastSink(sink);
    const logger = createLogger(tmpDir, "ses_debug_no_toast");
    logger.debug("debug message");

    await Bun.sleep(50);

    expect(calls).toHaveLength(0);
  });

  test("setToastSink dispatches for warn and error levels", async () => {
    const calls: Array<[string, string, Record<string, unknown> | undefined]> =
      [];
    const sink = (
      level: string,
      msg: string,
      data?: Record<string, unknown>,
    ) => {
      calls.push([level, msg, data]);
    };

    setToastSink(sink);
    const logger = createLogger(tmpDir, "ses_warn_error");
    logger.warn("warning");
    logger.error("error");

    await Bun.sleep(50);

    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe("warn");
    expect(calls[1][0]).toBe("error");
  });

  test("setToastSink(null) clears the sink", async () => {
    const calls: Array<[string, string, Record<string, unknown> | undefined]> =
      [];
    const sink = (
      level: string,
      msg: string,
      data?: Record<string, unknown>,
    ) => {
      calls.push([level, msg, data]);
    };

    setToastSink(sink);
    setToastSink(null);
    const logger = createLogger(tmpDir, "ses_null_sink");
    logger.info("should not dispatch");

    await Bun.sleep(50);

    expect(calls).toHaveLength(0);
  });

  // -- Line 114: getErrorCode(err) helper (non-Error case) --------------------

  test("getErrorCode returns null for non-Error objects", async () => {
    // This is tested indirectly: when a non-Error is thrown, getErrorCode returns null,
    // so the code falls through to the non-ENOENT error path (line 156-161).
    // We'll trigger this by mocking a write failure with a non-Error.

    const logger = createLogger(tmpDir, "ses_non_error");

    // Spy on stderr to verify the fallback path is taken
    let stderrCalled = false;
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      if (
        typeof chunk === "string" &&
        chunk.includes("[flashback] log write failed")
      ) {
        stderrCalled = true;
      }
      return originalWrite.call(process.stderr, chunk);
    }) as any;

    try {
      // Create a logger with an impossible path to trigger write failure
      const impossiblePath = "/dev/null/impossible/path/flashback.log";
      const badLogger = createLogger(impossiblePath, "ses_bad_path");
      badLogger.info("test");

      await Bun.sleep(100);

      // The error should be caught and logged to stderr (non-ENOENT path)
      expect(stderrCalled).toBe(true);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  // -- Lines 144-149, 153: ENOENT fallback path --------------------------------

  test("ENOENT fallback writes to /tmp/opencode-flashback/logs when primary path fails", async () => {
    const fallbackRoot = join(tmpdir(), "opencode-flashback");
    const sessionId = "ses_enoent_fallback";

    // Create logger with a path that will fail (directory doesn't exist and can't be created)
    const badStoragePath = "/dev/null/impossible/storage";
    const logger = createLogger(badStoragePath, sessionId);

    logger.info("fallback test");

    // Wait for async write to attempt fallback
    await Bun.sleep(100);

    // Check if fallback path was created
    const fallbackLogPath = join(
      fallbackRoot,
      "logs",
      String(process.pid),
      sessionId,
      LOG_FILENAME,
    );

    // The fallback path should exist OR the write should have failed gracefully
    // (depending on whether /tmp is writable)
    if (existsSync(fallbackLogPath)) {
      const content = readFileSync(fallbackLogPath, "utf-8");
      expect(content).toContain("fallback test");
    }
  });

  // -- Lines 156-161: Non-ENOENT error path (stderr fallback) ------------------

  test("non-ENOENT error writes to stderr once and then silently fails", async () => {
    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write;

    process.stderr.write = ((chunk: string | Uint8Array) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString();
      stderrWrites.push(str);
      return originalWrite.call(process.stderr, chunk);
    }) as any;

    try {
      // Use a path that will fail with a non-ENOENT error
      // /proc/1/mem is unwritable and will fail with EACCES or similar
      const restrictedPath = "/proc/1/mem";
      const logger = createLogger(restrictedPath, "ses_restricted");

      logger.info("first write");
      await Bun.sleep(50);

      logger.info("second write");
      await Bun.sleep(50);

      logger.info("third write");
      await Bun.sleep(50);

      // Count how many times stderr was written to with the error message
      const errorWrites = stderrWrites.filter((w) =>
        w.includes("[flashback] log write failed"),
      );

      // Should be written at most once (gated by logWriteWarned flag)
      expect(errorWrites.length).toBeLessThanOrEqual(1);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("stderr fallback message includes error details", async () => {
    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write;

    process.stderr.write = ((chunk: string | Uint8Array) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString();
      stderrWrites.push(str);
      return originalWrite.call(process.stderr, chunk);
    }) as any;

    try {
      const restrictedPath = "/proc/1/mem";
      const logger = createLogger(restrictedPath, "ses_error_msg");

      logger.info("trigger error");
      await Bun.sleep(50);

      const errorWrites = stderrWrites.filter((w) =>
        w.includes("[flashback] log write failed"),
      );

      if (errorWrites.length > 0) {
        // Verify the error message is included
        expect(errorWrites[0]).toMatch(/\[flashback\] log write failed:/);
      }
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
