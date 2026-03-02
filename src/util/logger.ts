import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

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

  const write = (
    level: string,
    msg: string,
    data?: Record<string, unknown>,
  ) => {
    try {
      const logEntry = {
        ts: new Date().toISOString(),
        pid: process.pid,
        sid: sessionId,
        level,
        msg,
        ...(data && Object.keys(data).length > 0 ? data : {}),
      };

      appendFileSync(logPath, JSON.stringify(logEntry) + "\n", "utf-8");
    } catch {
      // Fallback to console if file write fails
      console.log(`[${level}] ${msg}`, data);
    }
  };

  return {
    debug: (msg, data) => write("DEBUG", msg, data),
    info: (msg, data) => write("INFO", msg, data),
    warn: (msg, data) => write("WARN", msg, data),
    error: (msg, data) => write("ERROR", msg, data),
  };
}
