import { join } from "path";
import { statSync } from "fs";
import { getDb, countMemories } from "../db/database.ts";
import {
  addMemory,
  searchMemories,
  forgetMemory,
  listMemories,
  getMemoryById,
  getContext,
} from "../core/memory.ts";
import { getOrCreateProfile } from "../core/profile.ts";
import { resolveContainerTag } from "../core/tags.ts";
import { getEmbedderState } from "../embed/embedder.ts";
import { getSearchState } from "../search/index.ts";
import { getCaptureState } from "../core/capture.ts";
import { getConfig } from "../config.ts";
import type { SubsystemState, DiagnosticsResponse } from "../types.ts";

// -- State ------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve> | null = null;
let serverState: SubsystemState = "uninitialized";
let csrfToken = "";

// -- Rate limiter (token bucket) --------------------------------------------

const rateLimiter = {
  tokens: 100,
  lastRefill: Date.now(),
  allow(): boolean {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= 1000) {
      this.tokens = 100;
      this.lastRefill = now;
    }
    if (this.tokens <= 0) return false;
    this.tokens--;
    return true;
  },
};

// -- Public API -------------------------------------------------------------

export async function startServer(directory: string): Promise<void> {
  csrfToken = crypto.randomUUID();

  const config = getConfig();
  const basePort = config.web.port;
  const MAX_PORT_ATTEMPTS = 3;

  let lastError: unknown;
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = basePort + i;
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: (req) => handleRequest(req, directory),
      });
      serverState = "ready";
      return;
    } catch (error: unknown) {
      lastError = error;
    }
  }

  serverState = "error";
  throw lastError;
}

export function stopServer(): void {
  if (server) {
    server.stop();
    server = null;
    serverState = "uninitialized";
  }
}

export function getServerState(): SubsystemState {
  return serverState;
}

// -- Request handler --------------------------------------------------------

async function handleRequest(
  req: Request,
  directory: string,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  // Security: localhost validation
  if (!isLocalhostRequest(req)) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  // CSRF check for mutations
  if (["POST", "PUT", "DELETE"].includes(method)) {
    if (!validateCsrf(req)) {
      return jsonResponse({ error: "Invalid CSRF token" }, 403);
    }
  }

  // Rate limiting
  if (!rateLimiter.allow()) {
    return jsonResponse({ error: "Too many requests" }, 429);
  }

  // Body size limit (1MB)
  if (
    req.body &&
    parseInt(req.headers.get("content-length") ?? "0") > 1_048_576
  ) {
    return jsonResponse({ error: "Request body too large" }, 413);
  }

  // Route
  const path = url.pathname;

  try {
    // API routes
    if (path === "/api/csrf-token" && method === "GET") {
      return jsonResponse({ token: csrfToken });
    }

    if (path === "/api/diagnostics" && method === "GET") {
      return handleDiagnostics(directory);
    }

    if (path === "/api/memories" && method === "GET") {
      return handleListMemories(url, directory);
    }

    if (path === "/api/memories" && method === "POST") {
      return handleAddMemory(req, directory);
    }

    if (path.startsWith("/api/memories/") && method === "GET") {
      return handleGetMemory(path);
    }

    if (path.startsWith("/api/memories/") && method === "DELETE") {
      return handleDeleteMemory(path);
    }

    if (path === "/api/search" && method === "GET") {
      return handleSearch(url, directory);
    }

    if (path === "/api/profile" && method === "GET") {
      return handleGetProfile(directory);
    }

    // Static files
    if (path === "/" || path === "/index.html") {
      return serveStatic("index.html");
    }
    if (path.startsWith("/") && !path.startsWith("/api/")) {
      const filePath = path.slice(1);
      return serveStatic(filePath);
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
}

// -- API handlers -----------------------------------------------------------

function handleDiagnostics(directory: string): Response {
  const db = getDb();
  const containerTag = getContainerTag(directory);
  const memCount = countMemories(db, containerTag);

  const config = getConfig();
  const dbPath = join(config.storage.path, "flashback.db");

  let dbSizeBytes = 0;
  try {
    const stat = statSync(dbPath);
    dbSizeBytes = stat.size;
  } catch {
    // DB file may not exist yet
  }

  const subsystems: Record<string, SubsystemState> = {
    embedder: getEmbedderState(),
    search: getSearchState(),
    capture: getCaptureState(),
    server: serverState,
  };

  const diagnostics: DiagnosticsResponse = {
    memoryCount: memCount,
    dbSizeBytes,
    dbPath,
    embeddingModel: "onnx-community/embeddinggemma-300m-ONNX",
    subsystems,
    version: "0.1.0",
  };

  return jsonResponse(diagnostics);
}

async function handleListMemories(
  url: URL,
  directory: string,
): Promise<Response> {
  const limit = parseInt(url.searchParams.get("limit") ?? "50");
  const offset = parseInt(url.searchParams.get("offset") ?? "0");
  const containerTag = getContainerTag(
    directory,
    url.searchParams.get("containerTag") ?? undefined,
  );

  const result = await listMemories(containerTag, limit, offset);
  return jsonResponse(result);
}

async function handleAddMemory(
  req: Request,
  directory: string,
): Promise<Response> {
  const body = (await req.json()) as {
    content?: string;
    tags?: string[];
    type?: string;
  };

  if (!body.content || typeof body.content !== "string") {
    return jsonResponse({ error: "Missing required field: content" }, 400);
  }

  const containerTag = getContainerTag(directory);
  const result = await addMemory({
    content: body.content,
    containerTag,
    tags: body.tags,
    type: body.type,
  });

  return jsonResponse(result, 201);
}

async function handleGetMemory(path: string): Promise<Response> {
  const id = extractIdFromPath(path);
  if (!id) {
    return jsonResponse({ error: "Missing memory ID" }, 400);
  }

  const memory = await getMemoryById(id);
  if (!memory) {
    return jsonResponse({ error: "Memory not found" }, 404);
  }

  return jsonResponse(memory);
}

async function handleDeleteMemory(path: string): Promise<Response> {
  const id = extractIdFromPath(path);
  if (!id) {
    return jsonResponse({ error: "Missing memory ID" }, 400);
  }

  await forgetMemory(id);
  return jsonResponse({ success: true, id });
}

async function handleSearch(url: URL, directory: string): Promise<Response> {
  const query = url.searchParams.get("q") ?? "";
  if (query.trim().length === 0) {
    return jsonResponse({ error: "Missing required parameter: q" }, 400);
  }

  const limit = parseInt(url.searchParams.get("limit") ?? "10");
  const containerTag = getContainerTag(
    directory,
    url.searchParams.get("containerTag") ?? undefined,
  );

  const results = await searchMemories(query, containerTag, limit);
  return jsonResponse({ results, count: results.length });
}

function handleGetProfile(directory: string): Response {
  const tagInfo = resolveContainerTag(directory);
  const userId = tagInfo.userEmail || tagInfo.userName || "anonymous";
  const profile = getOrCreateProfile(userId);
  return jsonResponse(profile);
}

// -- Security helpers -------------------------------------------------------

function isLocalhostRequest(req: Request): boolean {
  const url = new URL(req.url);
  const host = url.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function validateCsrf(req: Request): boolean {
  const token = req.headers.get("X-CSRF-Token");
  return token === csrfToken;
}

// -- Response helpers -------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function serveStatic(filePath: string): Response {
  const fullPath = join(import.meta.dir, "web", filePath);
  const file = Bun.file(fullPath);
  if (!file.size) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
  };
  if (filePath.endsWith(".html")) {
    headers["Content-Security-Policy"] = "script-src 'self' 'sha256-6YqWunyF9B6avn1g4fXCrUMdPPmQylnakcaAKaAyMjk='";
    headers["Content-Type"] = "text/html; charset=utf-8";
  } else if (filePath.endsWith(".css")) {
    headers["Content-Type"] = "text/css; charset=utf-8";
  } else if (filePath.endsWith(".js")) {
    headers["Content-Type"] = "application/javascript; charset=utf-8";
  }

  return new Response(file, { headers });
}

// -- Path / tag helpers -----------------------------------------------------

function getContainerTag(directory: string, urlTag?: string): string {
  if (urlTag) return urlTag;
  return resolveContainerTag(directory).tag;
}

function extractIdFromPath(path: string): string | null {
  // /api/memories/:id
  const parts = path.split("/");
  const id = parts[3];
  return id && id.length > 0 ? id : null;
}
