import type { Plugin, PluginInput, ToolContext } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { registerCommands } from "./commands.ts";
import { getConfig } from "./config.ts";
import { getDb, countMemories, closeDb } from "./db/database.ts";
import { resolveContainerTag } from "./core/tags.ts";
import {
  addMemory,
  searchMemories,
  recallMemories,
  forgetMemory,
  listMemories,
  getContext,
} from "./core/memory.ts";
import { getOrCreateProfile } from "./core/profile.ts";
import {
  enqueueCapture,
  getCaptureState,
  resetCapture,
} from "./core/capture.ts";
import { embed, getEmbedderState, resetEmbedder } from "./embed/embedder.ts";
import { initSearch, getSearchState } from "./search/index.ts";
import type { DiagnosticsResponse, ToolResult } from "./types.ts";

type ToolMode =
  | "search"
  | "add"
  | "recall"
  | "list"
  | "forget"
  | "profile"
  | "stats"
  | "context"
  | "help"
  | "export"
  | "related"
  | "review"
  | "suspend"
  | "consolidate";

const injectedSessionIds = new Set<string>();
let warmupTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleInstalled = false;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

async function handleToolCall(
  args: Record<string, unknown>,
  pluginInput: PluginInput,
  context: ToolContext,
): Promise<ToolResult | { error: string }> {
  const tagInfo = resolveContainerTag(
    context.directory || pluginInput.directory,
  );
  const containerTag = tagInfo.tag;
  const mode = asString(args.mode) as ToolMode;

  switch (mode) {
    case "add": {
      const content = asString(args.content) || asString(args.query);
      if (content.trim().length === 0) {
        return {
          mode: "add",
          success: false,
          id: "",
          message: "Content is required",
        };
      }
      const result = await addMemory({
        content,
        containerTag,
        tags: asStringArray(args.tags),
      });
      return {
        mode: "add",
        success: true,
        id: result.id,
        message: result.deduplicated ? "Duplicate detected" : "Memory stored",
      };
    }
    case "search": {
      const results = await searchMemories(
        asString(args.query),
        containerTag,
        asNumber(args.limit),
      );
      return { mode: "search", results, count: results.length };
    }
    case "recall": {
      const results = await recallMemories(
        [],
        containerTag,
        asNumber(args.limit),
      );
      return { mode: "recall", results, count: results.length };
    }
    case "forget": {
      const id = asString(args.id);
      if (id.length === 0) {
        return { error: "Missing memory id" };
      }
      await forgetMemory(id);
      return { mode: "forget", success: true, id };
    }
    case "list": {
      const limit = asNumber(args.limit) ?? 50;
      const offset = asNumber(args.offset) ?? 0;
      const page = await listMemories(containerTag, limit, offset);
      return {
        mode: "list",
        memories: page.memories,
        total: page.total,
        offset,
      };
    }
    case "profile": {
      const profile = getOrCreateProfile(tagInfo.userEmail || "default");
      return { mode: "profile", profile };
    }
    case "stats": {
      return { mode: "stats", stats: await getDiagnostics(containerTag) };
    }
    case "context": {
      const contextText = await getContext(containerTag, context.sessionID);
      return { mode: "context", injected: contextText.length > 0 ? 1 : 0 };
    }
    case "help": {
      return { mode: "help", text: getHelpText() };
    }
    case "export": {
      const format = asString(args.format) === "markdown" ? "markdown" : "json";
      return { mode: "export", data: "[]", format, count: 0 };
    }
    case "related": {
      return { mode: "related", results: [], count: 0 };
    }
    case "review": {
      return { mode: "review", memories: [], count: 0 };
    }
    case "suspend": {
      return { mode: "suspend", success: false, id: asString(args.id) };
    }
    case "consolidate": {
      return {
        mode: "consolidate",
        candidates: [],
        merged: 0,
        dryRun: asBoolean(args.dryRun) || true,
      };
    }
    default:
      return { error: `Unknown mode: ${mode}` };
  }
}

function getHelpText(): string {
  return [
    "## Memory Commands",
    "",
    "| Command | Description |",
    "|---------|-------------|",
    "| /memory:search <query> | Search memories semantically |",
    "| /memory:add <content> | Store a new memory |",
    "| /memory:recall | Auto-recall relevant memories |",
    "| /memory:list | Browse stored memories |",
    "| /memory:forget <id> | Delete a memory |",
    "| /memory:profile | View learned user profile |",
    "| /memory:stats | Show diagnostics |",
    "| /memory:context | Inject project context |",
    "| /memory:help | Show this help |",
    "| /memory:export [json|markdown] | Export memories |",
    "| /memory:related <topic> | Find related memories |",
    "| /memory:review | Review stale memories |",
    "| /memory:suspend <id> [reason] | Suspend a memory |",
    "| /memory:consolidate [--dry-run] | Merge duplicates |",
  ].join("\n");
}

async function getDiagnostics(
  containerTag: string,
): Promise<DiagnosticsResponse> {
  const db = getDb();
  const dbPath = db.filename ?? "";
  const memoryCount = countMemories(db, containerTag);

  let dbSizeBytes = 0;
  try {
    if (dbPath) {
      dbSizeBytes = Bun.file(dbPath).size;
    }
  } catch {}

  return {
    memoryCount,
    dbSizeBytes,
    dbPath,
    embeddingModel: "onnx-community/embeddinggemma-300m-ONNX",
    subsystems: {
      embedder: getEmbedderState(),
      search: getSearchState(),
      capture: getCaptureState(),
    },
    version: "0.1.0",
  };
}

function scheduleWarmup(): void {
  if (warmupTimer) {
    return;
  }
  warmupTimer = setTimeout(async () => {
    warmupTimer = null;
    try {
      await Promise.all([initSearch(), embed(["warmup"], "query")]);
    } catch {}
  }, 30_000);
}

function installLifecycleHooks(): void {
  if (lifecycleInstalled) {
    return;
  }
  lifecycleInstalled = true;

  const shutdown = () => {
    if (warmupTimer) {
      clearTimeout(warmupTimer);
      warmupTimer = null;
    }
    resetCapture();
    resetEmbedder();
    closeDb();
  };

  process.on("beforeExit", shutdown);
  process.on("exit", shutdown);
}

const flashback: Plugin = async (input) => {
  scheduleWarmup();
  installLifecycleHooks();

  return {
    config: async (cfg) => {
      registerCommands(cfg);
    },
    tool: {
      memory: tool({
        description: "Persistent memory system for AI coding agents",
        args: {
          mode: tool.schema.enum([
            "search",
            "add",
            "recall",
            "list",
            "forget",
            "profile",
            "stats",
            "context",
            "help",
            "export",
            "related",
            "review",
            "suspend",
            "consolidate",
          ]),
          query: tool.schema.string().optional(),
          content: tool.schema.string().optional(),
          id: tool.schema.string().optional(),
          tags: tool.schema.array(tool.schema.string()).optional(),
          limit: tool.schema.number().optional(),
          offset: tool.schema.number().optional(),
          format: tool.schema.enum(["json", "markdown"]).optional(),
          reason: tool.schema.string().optional(),
          dryRun: tool.schema.boolean().optional(),
        },
        execute: async (args, context) => {
          try {
            const result = await handleToolCall(
              args as Record<string, unknown>,
              input,
              context,
            );
            return JSON.stringify(result);
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Memory tool execution failed";
            return JSON.stringify({ error: message });
          }
        },
      }),
    },
    "chat.message": async ({ sessionID }, output) => {
      const config = getConfig();
      if (config.memory.injection === "first") {
        if (injectedSessionIds.has(sessionID)) {
          return;
        }
        injectedSessionIds.add(sessionID);
      }

      const containerTag = resolveContainerTag(input.directory).tag;
      const contextText = await getContext(containerTag, sessionID);
      if (contextText.length === 0) {
        return;
      }

      output.parts.unshift({
        id: crypto.randomUUID(),
        sessionID,
        messageID: output.message.id,
        type: "text",
        text: contextText,
        synthetic: true,
      });
    },
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        if (!getConfig().memory.autoCapture) {
          return;
        }
        const tagInfo = resolveContainerTag(input.directory);
        enqueueCapture({
          sessionId: event.properties.sessionID,
          containerTag: tagInfo.tag,
          messages: [],
          directory: input.directory,
          displayName: tagInfo.displayName,
          userName: tagInfo.userName,
          userEmail: tagInfo.userEmail,
          projectPath: tagInfo.projectPath,
          projectName: tagInfo.projectName,
          gitRepoUrl: tagInfo.gitRepoUrl,
        });
      }
    },
  };
};

export default flashback;
