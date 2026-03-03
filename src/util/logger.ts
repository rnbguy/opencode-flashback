import { mkdirSync } from "fs";
import { appendFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";

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

export function createLogger(storagePath: string, sessionId: string): Logger {
  const logPath = join(
    storagePath.startsWith("~")
      ? storagePath.replace("~", homedir())
      : storagePath,
    "flashback.log",
  );

  // Ensure directory exists
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    // Ignore if directory already exists
  }

  let writeQueue = Promise.resolve();

  const write = (
    level: string,
    msg: string,
    data?: Record<string, unknown>,
  ) => {
    const logEntry = {
      ts: new Date().toISOString(),
      pid: process.pid,
      sid: sessionId,
      level,
      msg,
      ...(data && Object.keys(data).length > 0 ? data : {}),
    };

    const payload = JSON.stringify(logEntry) + "\n";
    writeQueue = writeQueue
      .then(() => appendFile(logPath, payload, "utf-8"))
      .catch(() => {
        console.log(`[${level}] ${msg}`, data);
      });
  };

  const loggerInstance: Logger = {
    debug: (msg, data) => write("DEBUG", msg, data),
    info: (msg, data) => write("INFO", msg, data),
    warn: (msg, data) => write("WARN", msg, data),
    error: (msg, data) => write("ERROR", msg, data),
  };

  singleton = loggerInstance;
  return loggerInstance;
}

export function getLogger(): Logger {
  return singleton;
}
