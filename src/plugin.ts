import type { Plugin, PluginInput, ToolContext } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin";
import { registerCommands } from "./commands.ts";
import { getConfig, isConfigured } from "./config.ts";
import { resolveContainerTag } from "./core/tags.ts";
import { analyzeAndUpdateProfile, decayConfidence } from "./core/profile.ts";
import { getUnanalyzedPrompts, storePrompt } from "./core/prompts.ts";
import { createEngine } from "./engine.ts";
import type { ToolResult } from "./types.ts";
import { getLanguageName } from "./util/language.ts";
import { createLogger } from "./util/logger.ts";
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
  | "suspend"
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
    case "consolidate": {
      const dryRun = asBoolean(args.dryRun) || true;
      return {
        mode: "consolidate",
        candidates: [],
        merged: 0,
        dryRun,
      };
    }
    default:
      return { error: `Unknown mode: ${mode}` };
  }
}

function getHelpText(): string {
  return [
    "## Flashback Commands",
    "",
    "| Command | Description |",
    "|---------|-------------|",
    "| /flashback:search <query> | Search memories semantically |",
    "| /flashback:add <content> | Store a new memory |",
    "| /flashback:recall | Auto-recall relevant memories |",
    "| /flashback:list | Browse stored memories |",
    "| /flashback:forget <id> | Delete a memory |",
    "| /flashback:profile | View learned user profile |",
    "| /flashback:stats | Show diagnostics |",
    "| /flashback:context | Inject project context |",
    "| /flashback:help | Show this help |",
    "| /flashback:export [json|markdown] | Export memories |",
    "| /flashback:related <topic> | Find related memories |",
    "| /flashback:review | Review stale memories |",
    "| /flashback:suspend <id> [reason] | Suspend a memory |",
    "| /flashback:consolidate [--dry-run] | Merge duplicates |",
  ].join("\n");
}

function scheduleWarmup(): void {
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
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export const OpenCodeFlashbackPlugin: Plugin = async (input) => {
  const config = getConfig();
  logger = createLogger(config.storage.path, "plugin");

  scheduleWarmup();
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
    startServer(input.directory)
      .then(() => {
        logger?.info("Web server started", { port: config.web.port });
        if (input.client?.tui) {
          input.client.tui
            .showToast({
              body: {
                title: "Flashback",
                message: `Web UI started on 127.0.0.1:${config.web.port}`,
                variant: "success",
                duration: 5000,
              },
            })
            .catch(() => undefined);
        }
      })
      .catch((error) => {
        logger?.error("Web server failed to start", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (input.client?.tui && config.toasts.errors) {
          input.client.tui
            .showToast({
              body: {
                title: "Flashback Error",
                message: `Web UI failed to start: ${String(error)}`,
                variant: "error",
                duration: 5000,
              },
            })
            .catch(() => undefined);
        }
      });
  }

  return {
    config: async (cfg) => {
      registerCommands(cfg);
    },
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
        let nonSyntheticUserMessageCount = 0;
        if (input.client?.session) {
          try {
            const messagesResponse = await input.client.session.messages({
              path: { id: sessionID },
            });
            const messages = messagesResponse.data || [];
            nonSyntheticUserMessageCount = messages.filter(
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
              "[MEMORY]",
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
        if (input.client?.tui && config.toasts.errors) {
          input.client.tui
            .showToast({
              body: {
                title: "Flashback Error",
                message: "Failed to inject memory context",
                variant: "error",
                duration: 4000,
              },
            })
            .catch(() => undefined);
        }
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
          displayName: tagInfo.displayName,
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
              if (input.client?.tui && config.toasts.userProfile) {
                input.client.tui
                  .showToast({
                    body: {
                      title: "Flashback",
                      message: `Profile updated to v${profileResult.version}`,
                      variant: "success",
                      duration: 3000,
                    },
                  })
                  .catch(() => undefined);
              }
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

          if (input.client?.tui && config.toasts.autoCapture) {
            input.client.tui
              .showToast({
                body: {
                  title: "Flashback",
                  message: `${results.length} memories restored after compaction`,
                  variant: "success",
                  duration: 3000,
                },
              })
              .catch(() => undefined);
          }
        } catch (error) {
          logger?.error("session.compacted handler failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionID,
          });
          if (input.client?.tui && config.toasts.errors) {
            input.client.tui
              .showToast({
                body: {
                  title: "Flashback Error",
                  message: "Failed to restore memories after compaction",
                  variant: "error",
                  duration: 4000,
                },
              })
              .catch(() => undefined);
          }
        }
      }
    },
  };
};
