import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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

  if (value.startsWith("file://")) {
    const filePath = expandPath(value.slice(7));

    if (!existsSync(filePath)) {
      return "";
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      return content.trim();
    } catch {
      return "";
    }
  }

  if (value.startsWith("env://")) {
    const envVar = value.slice(6);
    return process.env[envVar] ?? "";
  }

  return value;
}
