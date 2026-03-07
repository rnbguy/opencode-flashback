import { mkdirSync } from "fs";
import { appendFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { LOG_FILENAME } from "../consts.ts";
import type { LogLevel } from "../types.ts";

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export type ToastSink = (
  level: LogLevel,
  msg: string,
  data?: Record<string, unknown>,
) => void;

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let singleton: Logger = noopLogger;
let toastSink: ToastSink | null = null;

const levelPriority: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SENSITIVE_KEY_PATTERN =
  /^(api[_-]?key|secret|token|password|authorization|credential|auth)$/i;
const SENSITIVE_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9-]{20,}/, // OpenAI-style keys
  /^key-[a-zA-Z0-9-]{20,}/, // generic key prefixes
  /^AIza[a-zA-Z0-9_-]{30,}/, // Google API keys
  /^Bearer\s+\S{20,}/i, // Bearer tokens
];

export function sanitizeContext(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = "[REDACTED]";
      } else if (SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value))) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = value;
      }
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = sanitizeContext(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function setToastSink(sink: ToastSink | null): void {
  toastSink = sink;
}

export function createLogger(
  storagePath: string,
  sessionId: string,
  logLevel: LogLevel = "debug",
): Logger {
  const resolvedStoragePath = storagePath.startsWith("~")
    ? storagePath.replace("~", homedir())
    : storagePath;
  const logPath = join(resolvedStoragePath, LOG_FILENAME);
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const fallbackLogPath = join(
    tmpdir(),
    "opencode-flashback",
    "logs",
    String(process.pid),
    safeSessionId,
    LOG_FILENAME,
  );

  // Ensure directory exists
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    // Ignore if directory already exists
  }

  try {
    mkdirSync(dirname(fallbackLogPath), { recursive: true });
  } catch {
    /* ignore -- fallback dir creation is best-effort */
  }

  let logWriteWarned = false;
  let writeQueue = Promise.resolve();

  const getErrorCode = (err: unknown): string | null => {
    if (!(err instanceof Error)) {
      return null;
    }
    const maybeCode = (err as NodeJS.ErrnoException).code;
    return typeof maybeCode === "string" ? maybeCode : null;
  };

  const write = (
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>,
  ) => {
    if (levelPriority[level] < levelPriority[logLevel]) {
      return;
    }

    const logEntry = {
      ts: new Date().toISOString(),
      pid: process.pid,
      sid: sessionId,
      level: level.toUpperCase(),
      msg,
      ...(data && Object.keys(data).length > 0 ? sanitizeContext(data) : {}),
    };

    const payload = JSON.stringify(logEntry) + "\n";
    writeQueue = writeQueue
      .then(() => appendFile(logPath, payload, "utf-8"))
      .catch((err) => {
        if (getErrorCode(err) === "ENOENT") {
          return appendFile(fallbackLogPath, payload, "utf-8").catch(
            (fallbackErr) => {
              if (!logWriteWarned) {
                logWriteWarned = true;
                process.stderr.write(
                  `[flashback] log write failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}\n`,
                );
              }
            },
          );
        }

        // Fallback to stderr once so log failures are observable
        if (!logWriteWarned) {
          logWriteWarned = true;
          process.stderr.write(
            `[flashback] log write failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      });

    // Emit toast for non-debug levels
    if (level !== "debug" && toastSink) {
      toastSink(level, msg, data);
    }
  };

  const loggerInstance: Logger = {
    debug: (msg, data) => write("debug", msg, data),
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
  };

  singleton = loggerInstance;
  return loggerInstance;
}

export function getLogger(): Logger {
  return singleton;
}
