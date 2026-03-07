import { readFileSync } from "fs";
import { join } from "path";
import { getConfig } from "../config.ts";
import { deriveUserId, type MemoryEngine } from "../engine.ts";
import type { DiagnosticsResponse, SubsystemState } from "../types.ts";
import { getLogger } from "../util/logger.ts";
import { isFullyPrivate, stripPrivate } from "../util/privacy.ts";

// -- State ------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve> | null = null;
let engine: MemoryEngine | null = null;
let serverState: SubsystemState = "uninitialized";
let csrfToken = "";
let cspScriptHash = "";
let csrfRotationInterval: ReturnType<typeof setInterval> | null = null;

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

export async function startServer(
  directory: string,
  engineInstance: MemoryEngine,
): Promise<number> {
  if (server) {
    stopServer();
  }
  engine = engineInstance;
  const logger = getLogger();
  csrfToken = crypto.randomUUID();
  cspScriptHash = computeCspHash();



  const config = getConfig();
  const basePort = config.web.port;

  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: basePort,
      fetch: (req) => handleRequest(req, directory),
    });
    // Set up CSRF token rotation every 5 minutes (after server succeeds to avoid leak on bind failure)
    csrfRotationInterval = setInterval(() => {
      csrfToken = crypto.randomUUID();
      logger.debug("CSRF token rotated");
    }, 300_000);
    serverState = "ready";
    logger.info(`Web UI available at http://127.0.0.1:${basePort}`);
    return server.port!;
  } catch (error: unknown) {
    if (csrfRotationInterval) {
      clearInterval(csrfRotationInterval);
      csrfRotationInterval = null;
    }
    serverState = "error";
    logger.error("startServer failed", { basePort });
    throw error;

  }
}

export function stopServer(): void {
  if (csrfRotationInterval) {
    clearInterval(csrfRotationInterval);
    csrfRotationInterval = null;
  }
  if (server) {
    server.stop();
    server = null;
    serverState = "uninitialized";
  }
  engine = null;
}

export function getServerState(): SubsystemState {
  return serverState;
}

// -- Request handler --------------------------------------------------------

async function handleRequest(
  req: Request,
  directory: string,
): Promise<Response> {
  const logger = getLogger();
  const url = new URL(req.url);
  const method = req.method;
  logger.debug("handleRequest received", { method, path: url.pathname });

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

    if (path.match(/^\/api\/memories\/[^/]+\/star$/) && method === "POST") {
      return handleStarMemory(path);
    }

    if (path.match(/^\/api\/memories\/[^/]+\/unstar$/) && method === "POST") {
      return handleUnstarMemory(path);
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

    if (
      path.match(
        /^\/api\/profile\/items\/(preferences|patterns|workflows)\/\d+\/star$/,
      ) &&
      method === "POST"
    ) {
      return handleStarProfileItem(path, directory);
    }

    if (
      path.match(
        /^\/api\/profile\/items\/(preferences|patterns|workflows)\/\d+\/unstar$/,
      ) &&
      method === "POST"
    ) {
      return handleUnstarProfileItem(path, directory);
    }

    if (
      path.match(
        /^\/api\/profile\/items\/(preferences|patterns|workflows)\/\d+$/,
      ) &&
      method === "DELETE"
    ) {
      return handleDeleteProfileItem(path, directory);
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

async function handleDiagnostics(directory: string): Promise<Response> {
  const containerTag = getContainerTag(directory);
  const result = await getEngine().getDiagnostics(containerTag);
  result.subsystems.server = serverState;
  return jsonResponse(result as DiagnosticsResponse);
}

async function handleListMemories(
  url: URL,
  directory: string,
): Promise<Response> {
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "50");
  const limit = Number.isNaN(rawLimit)
    ? 50
    : Math.max(1, Math.min(100, rawLimit));
  const rawOffset = parseInt(url.searchParams.get("offset") ?? "0");
  const offset = Number.isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);
  const containerTag = getContainerTag(directory);

  const result = await getEngine().listMemories(containerTag, limit, offset);
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

  // Verify actual body size (prevent header spoofing)
  const bodySize = JSON.stringify(body).length;
  if (bodySize > 1_048_576) {
    return jsonResponse({ error: "Request body too large" }, 413);
  }
  if (!body.content || typeof body.content !== "string") {
    return jsonResponse({ error: "Missing required field: content" }, 400);
  }

  if (isFullyPrivate(body.content)) {
    return jsonResponse({ error: "Private content blocked" }, 400);
  }
  const sanitizedContent = stripPrivate(body.content);

  const containerTag = getContainerTag(directory);
  const result = await getEngine().addMemory({
    content: sanitizedContent,
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

  const memory = await getEngine().getMemoryById(id);
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

  await getEngine().forgetMemory(id);
  return jsonResponse({ success: true, id });
}

async function handleStarMemory(path: string): Promise<Response> {
  const parts = path.split("/");
  const id = parts[3];
  if (!id || id.length === 0) {
    return jsonResponse({ error: "Missing memory ID" }, 400);
  }
  const success = await getEngine().starMemory(id);
  if (!success) {
    return jsonResponse({ error: "Memory not found" }, 404);
  }
  return jsonResponse({ success: true, id });
}

async function handleUnstarMemory(path: string): Promise<Response> {
  const parts = path.split("/");
  const id = parts[3];
  if (!id || id.length === 0) {
    return jsonResponse({ error: "Missing memory ID" }, 400);
  }
  const success = await getEngine().unstarMemory(id);
  if (!success) {
    return jsonResponse({ error: "Memory not found" }, 404);
  }
  return jsonResponse({ success: true, id });
}

async function handleSearch(url: URL, directory: string): Promise<Response> {
  const query = url.searchParams.get("q") ?? "";
  if (query.trim().length === 0) {
    return jsonResponse({ error: "Missing required parameter: q" }, 400);
  }

  const rawLimit = parseInt(url.searchParams.get("limit") ?? "10");
  const limit = Number.isNaN(rawLimit)
    ? 10
    : Math.max(1, Math.min(100, rawLimit));
  const rawOffset = parseInt(url.searchParams.get("offset") ?? "0");
  const offset = Number.isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);
  const containerTag = getContainerTag(directory);

  const { results, totalCount } = await getEngine().searchMemories(
    query,
    containerTag,
    limit,
    offset,
  );
  return jsonResponse({ results, count: totalCount });
}

function handleGetProfile(directory: string): Response {
  const tagInfo = getEngine().resolveTag(directory);
  const userId = deriveUserId(tagInfo);
  const profile = getEngine().getOrCreateProfile(userId);
  return jsonResponse(profile);
}

function handleStarProfileItem(path: string, directory: string): Response {
  const parsed = parseProfileItemPath(path, true);
  if (!parsed) {
    return jsonResponse({ error: "Invalid section or index" }, 400);
  }

  const tagInfo = getEngine().resolveTag(directory);
  const userId = deriveUserId(tagInfo);
  const success = getEngine().starProfileItem(
    userId,
    parsed.section,
    parsed.index,
  );
  if (!success) {
    return jsonResponse({ error: "Profile item not found" }, 404);
  }

  return jsonResponse({ success: true });
}

function handleUnstarProfileItem(path: string, directory: string): Response {
  const parsed = parseProfileItemPath(path, true);
  if (!parsed) {
    return jsonResponse({ error: "Invalid section or index" }, 400);
  }

  const tagInfo = getEngine().resolveTag(directory);
  const userId = deriveUserId(tagInfo);
  const success = getEngine().unstarProfileItem(
    userId,
    parsed.section,
    parsed.index,
  );
  if (!success) {
    return jsonResponse({ error: "Profile item not found" }, 404);
  }

  return jsonResponse({ success: true });
}

function handleDeleteProfileItem(path: string, directory: string): Response {
  const parsed = parseProfileItemPath(path, false);
  if (!parsed) {
    return jsonResponse({ error: "Invalid section or index" }, 400);
  }

  const tagInfo = getEngine().resolveTag(directory);
  const userId = deriveUserId(tagInfo);
  const success = getEngine().deleteProfileItem(
    userId,
    parsed.section,
    parsed.index,
  );
  if (!success) {
    return jsonResponse({ error: "Profile item not found" }, 404);
  }

  return jsonResponse({ success: true });
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

function computeCspHash(): string {
  const logger = getLogger();
  try {
    const htmlPath = join(import.meta.dir, "web", "index.html");
    const html = readFileSync(htmlPath, "utf-8");
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!match) {
      logger.warn("CSP hash: no inline script found in index.html");
      return "";
    }
    const hash = new Bun.CryptoHasher("sha256")
      .update(match[1])
      .digest("base64");
    return `sha256-${hash}`;
  } catch {
    // HTML file not readable (e.g. test environment) -- fall back to unsafe-inline
    logger.warn("CSP hash: failed to read index.html, using unsafe-inline");
    return "";
  }
}

// -- Response helpers -------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store",
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
  headers["X-Frame-Options"] = "DENY";
  if (filePath.endsWith(".html")) {
    headers["Content-Security-Policy"] = cspScriptHash
      ? `script-src 'self' '${cspScriptHash}'`
      : "script-src 'self' 'unsafe-inline'";
    headers["Content-Type"] = "text/html; charset=utf-8";
  } else if (filePath.endsWith(".css")) {
    headers["Content-Type"] = "text/css; charset=utf-8";
  } else if (filePath.endsWith(".js")) {
    headers["Content-Type"] = "application/javascript; charset=utf-8";
  }

  return new Response(file, { headers });
}

// -- Path / tag helpers -----------------------------------------------------

function getContainerTag(directory: string): string {
  return getEngine().resolveTag(directory).tag;
}

function getEngine(): MemoryEngine {
  if (!engine) {
    throw new Error("Server engine is not initialized");
  }
  return engine;
}

function extractIdFromPath(path: string): string | null {
  // /api/memories/:id
  const parts = path.split("/");
  const id = parts[3];
  return id && id.length > 0 ? id : null;
}

function parseProfileItemPath(
  path: string,
  hasActionSuffix: boolean,
): {
  section: "preferences" | "patterns" | "workflows";
  index: number;
} | null {
  const parts = path.split("/");
  const section = parts[4];
  const indexRaw = parts[5];
  const suffix = hasActionSuffix ? parts[6] : "";
  if (
    section !== "preferences" &&
    section !== "patterns" &&
    section !== "workflows"
  ) {
    return null;
  }

  const index = Number.parseInt(indexRaw ?? "", 10);
  if (!Number.isInteger(index) || index < 0) {
    return null;
  }
  if (hasActionSuffix && suffix !== "star" && suffix !== "unstar") {
    return null;
  }

  return { section, index };
}
