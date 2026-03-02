import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const secretCache = new Map<string, string>();

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~") {
    return homedir();
  }
  return path;
}

export async function resolveSecret(value: string): Promise<string> {
  if (!value) {
    return "";
  }

  const cached = secretCache.get(value);
  if (cached !== undefined) return cached;

  if (value.startsWith("file://")) {
    const filePath = expandPath(value.slice(7));

    if (!existsSync(filePath)) {
      return "";
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      const result = content.trim();
      secretCache.set(value, result);
      return result;
    } catch {
      return "";
    }
  }

  if (value.startsWith("env://")) {
    const envVar = value.slice(6);
    const envResult = process.env[envVar] ?? "";
    secretCache.set(value, envResult);
    return envResult;
  }

  secretCache.set(value, value);
  return value;
}

/** @internal -- test-only */
export function _resetSecretCache(): void {
  secretCache.clear();
}
