import { mkdirSync } from "fs";
import { appendFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";
import type { LogLevel } from "../types.ts";
import { LOG_FILENAME } from "../consts.ts";

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let singleton: Logger = noopLogger;

const levelPriority: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(
  storagePath: string,
  sessionId: string,
  logLevel: LogLevel = "debug",
): Logger {
  const logPath = join(
    storagePath.startsWith("~")
      ? storagePath.replace("~", homedir())
      : storagePath,
    LOG_FILENAME,
  );

  // Ensure directory exists
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    // Ignore if directory already exists
  }

  let writeQueue = Promise.resolve();

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
      ...(data && Object.keys(data).length > 0 ? data : {}),
    };

    const payload = JSON.stringify(logEntry) + "\n";
    writeQueue = writeQueue
      .then(() => appendFile(logPath, payload, "utf-8"))
      .catch(() => {});
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
