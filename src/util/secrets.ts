import { existsSync, readFileSync } from "fs";
import { expandPath } from "./path";

export async function resolveSecret(value: string): Promise<string> {
  if (!value) {
    return "";
  }

  if (value.startsWith("file://")) {
    const filePath = expandPath(value.slice(7));

    if (!existsSync(filePath)) {
      return "";
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      return content.trim();
    } catch {
      // file read failed -- secret is unavailable, return empty string
      return "";
    }
  }

  if (value.startsWith("env://")) {
    const envVar = value.slice(6);
    return process.env[envVar] ?? "";
  }

  return value;
}

/** @internal -- test-only */
export function _resetSecretCache(): void {
  // No-op: cache removed. Kept for backward compatibility with existing tests.
}
