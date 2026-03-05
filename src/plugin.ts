import type { Plugin, PluginInput, ToolContext } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import ms from "ms";
import { getConfig, getConfigErrors, isConfigured } from "./config.ts";
import { MEMORY_HEADER } from "./consts.ts";
import { getAvailableModels, validateLLMEndpoint } from "./core/ai/generate.ts";
import { analyzeAndUpdateProfile, decayConfidence } from "./core/profile.ts";
import { getUnanalyzedPrompts, storePrompt } from "./core/prompts.ts";
import { resolveContainerTag } from "./core/tags.ts";
import { createEngine } from "./engine.ts";
import type { ToolResult } from "./types.ts";
import { getLanguageName } from "./util/language.ts";
import { createLogger, setToastSink } from "./util/logger.ts";
import { isFullyPrivate, stripPrivate } from "./util/privacy.ts";
import { startServer, stopServer } from "./web/server.ts";

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
  | "rate"
  | "suspend"
  | "pin"
  | "unpin"
  | "clear"
  | "consolidate";

const injectedSessionIds = new Set<string>();
let warmupTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimeout: ReturnType<typeof setTimeout> | null = null;
let lifecycleInstalled = false;
const engine = createEngine({ resolve: resolveContainerTag });
const backoff = { delay: 0, maxDelay: 300_000, lastFailure: 0 };
let logger: ReturnType<typeof createLogger> | null = null;

function isInBackoff(): boolean {
  if (backoff.delay === 0) return false;
  return Date.now() - backoff.lastFailure < backoff.delay;
}

function applyBackoff(): void {
  backoff.delay =
    backoff.delay === 0
      ? 30_000
      : Math.min(backoff.delay * 2, backoff.maxDelay);
  backoff.lastFailure = Date.now();
}

function resetBackoff(): void {
  backoff.delay = 0;
  backoff.lastFailure = 0;
}

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
  const tagInfo = engine.resolveTag(context.directory || pluginInput.directory);
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
      if (isFullyPrivate(content)) {
        return {
          mode: "add",
          success: false,
          id: "",
          message: "Private content blocked",
        };
      }
      const sanitizedContent = stripPrivate(content);
      const result = await engine.addMemory({
        content: sanitizedContent,
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
      const results = await engine.searchMemories(
        asString(args.query),
        containerTag,
        asNumber(args.limit),
      );
      return { mode: "search", results, count: results.length };
    }
    case "recall": {
      const results = await engine.recallMemories(
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
      await engine.forgetMemory(id);
      return { mode: "forget", success: true, id };
    }
    case "list": {
      const limit = asNumber(args.limit) ?? 50;
      const offset = asNumber(args.offset) ?? 0;
      const page = await engine.listMemories(containerTag, limit, offset);
      return {
        mode: "list",
        memories: page.memories,
        total: page.total,
        offset,
      };
    }
    case "profile": {
      const profile = engine.getOrCreateProfile(tagInfo.userEmail || "default");
      return { mode: "profile", profile };
    }
    case "stats": {
      return {
        mode: "stats",
        stats: await engine.getDiagnostics(containerTag),
      };
    }
    case "context": {
      const contextText = await engine.getContext(
        containerTag,
        context.sessionID,
      );
      return { mode: "context", injected: contextText.length > 0 ? 1 : 0 };
    }
    case "help": {
      return { mode: "help", text: getHelpText() };
    }
    case "export": {
      const format = asString(args.format) === "markdown" ? "markdown" : "json";
      const result = await engine.exportMemories(containerTag, format);
      return { mode: "export", data: result.data, format, count: result.count };
    }
    case "related": {
      const query = asString(args.query);
      if (query.trim().length === 0) {
        return { mode: "related", results: [], count: 0 };
      }
      const results = await engine.findRelatedMemories(
        query,
        containerTag,
        asNumber(args.limit),
      );
      return { mode: "related", results, count: results.length };
    }
    case "review": {
      const memories = await engine.getMemoriesForReview(
        containerTag,
        asNumber(args.limit),
      );
      return { mode: "review", memories, count: memories.length };
    }
    case "rate": {
      const id = asString(args.id);
      if (id.length === 0) {
        return { error: "Missing memory id" };
      }
      const rating = asNumber(args.rating);
      if (
        rating === undefined ||
        rating < 1 ||
        rating > 5 ||
        !Number.isInteger(rating)
      ) {
        return { error: "Rating must be an integer from 1 to 5" };
      }
      const result = await engine.rateMemory(id, rating as 1 | 2 | 3 | 4 | 5);
      return {
        mode: "rate",
        success: result.success,
        id,
        nextReviewAt: result.nextReviewAt,
      };
    }
    case "suspend": {
      const id = asString(args.id);
      if (id.length === 0) {
        return { error: "Missing memory id" };
      }
      const success = await engine.suspendMemory(
        id,
        asString(args.reason) || null,
      );
      return { mode: "suspend", success, id };
    }
    case "pin": {
      const id = asString(args.id);
      if (id.length === 0) {
        return { error: "Missing memory id" };
      }
      const success = await engine.pinMemory(id);
      return { mode: "pin", success, id };
    }
    case "unpin": {
      const id = asString(args.id);
      if (id.length === 0) {
        return { error: "Missing memory id" };
      }
      const success = await engine.unpinMemory(id);
      return { mode: "unpin", success, id };
    }
    case "clear": {
      const confirmed = asBoolean(args.confirmed);
      const rawDuration = asString(args.duration);
      const durationMs = rawDuration
        ? ms(rawDuration as ms.StringValue)
        : undefined;
      if (rawDuration && !durationMs) {
        return {
          mode: "clear",
          success: false,
          message: `Invalid duration format: "${rawDuration}". Examples: "30sec", "2days", "1hour", "5min", "1w".`,
        };
      }
      const durationSecs = durationMs
        ? Math.round(durationMs / 1000)
        : undefined;
      if (!confirmed) {
        const durationNote = durationMs
          ? ` memories older than ${ms(durationMs, { long: true })}`
          : " ALL memories, profiles, and prompts";
        return {
          mode: "clear",
          success: false,
          message: `WARNING: This will permanently delete${durationNote}. This action cannot be undone. To proceed, call again with confirmed: true.`,
        };
      }
      engine.clearAllData(durationSecs);
      const message = durationMs
        ? `Cleared memories older than ${ms(durationMs, { long: true })}.`
        : "All data cleared. Database is now empty.";
      return {
        mode: "clear",
        success: true,
        message,
      };
    }
    case "consolidate": {
      const dryRun =
        typeof args.dryRun === "boolean"
          ? (asBoolean(args.dryRun) ?? true)
          : true;
      const confirmed = asBoolean(args.confirmed);
      if (!dryRun && !confirmed) {
        return {
          mode: "consolidate",
          candidates: [],
          merged: 0,
          dryRun: false,
          message:
            "WARNING: This will merge duplicate memories. To proceed, call again with confirmed: true.",
        };
      }
      const result = await engine.consolidateMemories(containerTag, dryRun);
      return {
        mode: "consolidate",
        candidates: result.candidates,
        merged: result.merged,
        dryRun,
      };
    }
    default:
      return { error: `Unknown mode: ${mode}` };
  }
}

function getHelpText(): string {
  return [
    "## Flashback Tool Modes",
    "",
    "| Mode | Description |",
    "|------|-------------|",
    "| search <query> | Search memories semantically |",
    "| add <content> | Store a new memory |",
    "| recall | Auto-recall relevant memories |",
    "| list | Browse stored memories |",
    "| forget <id> | Delete a memory |",
    "| profile | View learned user profile |",
    "| stats | Show diagnostics |",
    "| context | Inject project context |",
    "| help | Show this help |",
    "| export [json|markdown] | Export memories |",
    "| related <topic> | Find related memories |",
    "| review | Review stale memories |",
    "| rate <id> <rating> | Rate a memory (1-5) to schedule next review |",
    "| suspend <id> [reason] | Suspend a memory |",
    "| pin <id> | Pin a memory (protected from eviction) |",
    "| unpin <id> | Unpin a memory |",
    "| clear [duration] | Clear all data or memories older than duration (e.g. 30sec, 2days, 1hour) |",
    "| consolidate [--dry-run] | Merge duplicates |",
  ].join("\n");
}

function _scheduleWarmup(): void {
  if (warmupTimer) {
    return;
  }
  warmupTimer = setTimeout(async () => {
    warmupTimer = null;
    try {
      await engine.warmup();
    } catch {
      // Warmup is best-effort -- lazy init handles failures
    }
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
    if (idleTimeout) {
      clearTimeout(idleTimeout);
      idleTimeout = null;
    }
    stopServer();
    engine.shutdown();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export const OpenCodeFlashbackPlugin: Plugin = async (input) => {
  const config = getConfig();
  logger = createLogger(
    config.storage.path,
    "plugin",
    config.logLevel ?? "info",
  );

  // Wire toast sink: non-debug logs trigger TUI toasts
  if (input.client?.tui) {
    const tui = input.client.tui;
    setToastSink((level, msg) => {
      const variant =
        level === "error" || level === "warn" ? "error" : "success";
      const duration = level === "error" ? 10000 : 5000;
      tui
        .showToast({
          body: { title: "Flashback", message: msg, variant, duration },
        })
        .catch(() => undefined);
    });
  }

  const configErrors = getConfigErrors();
  if (configErrors.length > 0) {
    logger.error(`Config errors: ${configErrors.join(" | ")}`);
  }

  if (isConfigured()) {
    validateLLMEndpoint()
      .then((result) => {
        if (!result.ok) {
          logger?.error("LLM endpoint validation failed", {
            error: result.error,
          });
        } else {
          logger?.info("LLM endpoint validated");
        }
      })
      .catch(() => undefined);

    getAvailableModels(config.embedding)
      .then((result) => {
        if (!result.ok) {
          logger?.error("Embedding endpoint validation failed", {
            error: result.error,
          });
        } else {
          logger?.info("Embedding endpoint validated");
        }
      })
      .catch(() => undefined);
  }

  installLifecycleHooks();

  if (!isConfigured()) {
    logger.warn("Plugin is not fully configured");
  }

  const GLOBAL_PLUGIN_WARMUP_KEY = Symbol.for("opencode-flashback.warmedup");
  if (
    isConfigured() &&
    !(globalThis as Record<PropertyKey, unknown>)[GLOBAL_PLUGIN_WARMUP_KEY]
  ) {
    try {
      await engine.warmup();
      (globalThis as Record<PropertyKey, unknown>)[GLOBAL_PLUGIN_WARMUP_KEY] =
        true;
      logger.info("Plugin warmup completed");
    } catch (error) {
      logger.error("Plugin warmup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (config.web.enabled) {
    startServer(input.directory).catch((error) => {
      logger?.error("Web server failed to start", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return {
    tool: {
      flashback: tool({
        description: `Manage and query project memory (MATCH USER LANGUAGE: ${getLanguageName("en")}). Use 'search' with keywords, 'add' to store, 'profile' for preferences.`,
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
            "rate",
            "suspend",
            "pin",
            "unpin",
            "clear",
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
          confirmed: tool.schema.boolean().optional(),
          rating: tool.schema.number().optional(),
          duration: tool.schema.string().optional(),
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
      if (!isConfigured()) {
        return;
      }

      const config = getConfig();
      try {
        // Save user prompt if text parts present
        const textParts = output.parts.filter(
          (part): part is Part & { type: "text"; text: string } =>
            part.type === "text" && typeof part.text === "string",
        );
        const userMessage = textParts
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (userMessage.length > 0) {
          storePrompt(
            sessionID,
            output.message.id,
            userMessage,
            input.directory,
          );
        }

        // Fetch session messages for compaction detection (if client available)
        let isAfterCompaction = false;
        let _nonSyntheticUserMessageCount = 0;
        if (input.client?.session) {
          try {
            const messagesResponse = await input.client.session.messages({
              path: { id: sessionID },
            });
            const messages = messagesResponse.data || [];
            _nonSyntheticUserMessageCount = messages.filter(
              (message) =>
                message.info.role === "user" &&
                message.parts.some(
                  (part) =>
                    part.type === "text" &&
                    typeof part.text === "string" &&
                    part.synthetic !== true,
                ),
            ).length;
            const lastMessage =
              messages.length > 0 ? messages[messages.length - 1] : null;
            isAfterCompaction = lastMessage?.info?.summary === true;
          } catch {
            // SDK call failed -- fall back to simple injection logic
          }
        }

        // Determine whether to inject
        let shouldInject = false;
        if (config.memory.injection === "every") {
          shouldInject = true;
        } else {
          // "first" mode: inject on first user message or after compaction
          if (injectedSessionIds.has(sessionID) && !isAfterCompaction) {
            shouldInject = false;
          } else {
            shouldInject = true;
          }
          if (isAfterCompaction) {
            injectedSessionIds.delete(sessionID);
          }
        }

        if (!shouldInject) {
          return;
        }

        // Build context with filtering
        const tagInfo = engine.resolveTag(input.directory);
        let contextText = "";

        if (
          config.memory.excludeCurrentSession ||
          typeof config.memory.maxAgeDays === "number"
        ) {
          const listPage = await engine.listMemories(
            tagInfo.tag,
            config.memory.maxResults,
            0,
          );

          let filteredMemories = listPage.memories;
          if (config.memory.excludeCurrentSession) {
            filteredMemories = filteredMemories.filter(
              (memory) => memory.provenance.sessionId !== sessionID,
            );
          }

          if (typeof config.memory.maxAgeDays === "number") {
            const cutoff = Date.now() - config.memory.maxAgeDays * 86_400_000;
            filteredMemories = filteredMemories.filter(
              (memory) => memory.createdAt >= cutoff,
            );
          }

          if (filteredMemories.length > 0) {
            const memoryLines = filteredMemories
              .slice(0, config.memory.maxResults)
              .map((memory) => {
                const compact = memory.content.replace(/\s+/g, " ").trim();
                const summary =
                  compact.length > 180
                    ? `${compact.slice(0, 179)}...`
                    : compact;
                const confidencePct = Math.round(
                  memory.epistemicStatus.confidence * 100,
                );
                return `- [${confidencePct}%] ${summary}`;
              });
            contextText = [
              MEMORY_HEADER,
              "",
              "User Preferences:",
              "- see stored profile",
              "",
              `Project Knowledge (session ${sessionID}):`,
              ...memoryLines,
            ].join("\n");
          }
        } else {
          contextText = await engine.getContext(tagInfo.tag, sessionID);
        }

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

        if (config.memory.injection === "first") {
          injectedSessionIds.add(sessionID);
        }
      } catch (error) {
        logger?.error("chat.message handler failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionID,
        });
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const config = getConfig();
        if (!isConfigured() || !config.memory.autoCapture) {
          return;
        }
        const sessionID = asString(event.properties?.sessionID);
        if (!sessionID) {
          return;
        }

        if (isInBackoff()) {
          logger?.debug("Skipping idle processing due to backoff", {
            sessionID,
            delay: backoff.delay,
          });
          return;
        }

        const tagInfo = engine.resolveTag(input.directory);

        // Fetch session messages via SDK if available; fall back to empty
        let extractedMessages: Array<{ role: string; content: string }> = [];
        if (input.client?.session) {
          try {
            const response = await input.client.session.messages({
              path: { id: sessionID },
            });
            const sessionMessages = response.data || [];
            extractedMessages = sessionMessages
              .map((message) => {
                const content = message.parts
                  .map((part) => {
                    if (
                      part.type === "text" &&
                      "text" in part &&
                      typeof part.text === "string" &&
                      part.synthetic !== true
                    ) {
                      return part.text;
                    }
                    return "";
                  })
                  .filter((text) => text.length > 0)
                  .join("\n")
                  .trim();

                return {
                  role: message.info.role,
                  content,
                };
              })
              .filter((message) => message.content.length > 0);
          } catch {
            // SDK call failed -- proceed with empty messages
          }
        }

        engine.enqueueCapture({
          sessionId: sessionID,
          containerTag: tagInfo.tag,
          messages: extractedMessages,
          directory: input.directory,
          userName: tagInfo.userName,
          userEmail: tagInfo.userEmail,
          projectPath: tagInfo.projectPath,
          projectName: tagInfo.projectName,
          gitRepoUrl: tagInfo.gitRepoUrl,
        });

        // Profile learning on idle (best-effort)
        try {
          const userId = tagInfo.userEmail || "default";
          const prompts = getUnanalyzedPrompts(50).map(
            (prompt) => prompt.content,
          );
          if (prompts.length > 0) {
            const profileResult = await analyzeAndUpdateProfile(
              userId,
              prompts,
            );
            if (profileResult.updated) {
              decayConfidence(userId);
              logger?.info("Profile updated");
            }
          }
          resetBackoff();
        } catch (error) {
          applyBackoff();
          logger?.error("Idle profile learning failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionID,
            nextRetryMs: backoff.delay,
          });
        }
      }

      if (event.type === "session.compacted") {
        const config = getConfig();
        if (!isConfigured() || !config.compaction.enabled) {
          return;
        }

        const sessionID = asString(event.properties?.sessionID);
        if (!sessionID) {
          return;
        }

        try {
          const tagInfo = engine.resolveTag(input.directory);
          const results = await engine.searchMemories(
            sessionID,
            tagInfo.tag,
            config.compaction.memoryLimit,
          );
          if (results.length === 0) {
            return;
          }

          const contextText = [
            "## Restored Session Memory",
            "",
            ...results.map((result, index) => {
              const memory = result.memory;
              const tags =
                memory.tags.length > 0
                  ? `\nTags: ${memory.tags.join(", ")}`
                  : "";
              return `### Memory ${index + 1}\n${memory.content}${tags}\n`;
            }),
          ].join("\n");

          await input.client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [{ type: "text", text: contextText }],
              noReply: true,
            },
          });

          logger?.info(`${results.length} memories restored after compaction`);
        } catch (error) {
          logger?.error("session.compacted handler failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionID,
          });
        }
      }
    },
  };
};
