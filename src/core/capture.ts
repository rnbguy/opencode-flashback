import { addMemory } from "./memory.ts";
import { callLLMWithTool, type ToolSchema } from "./llm.ts";
import {
  storePrompt,
  getLastUncapturedPrompt,
  markCaptured,
  markAnalyzed,
} from "./prompts.ts";
import type { SubsystemState } from "../types.ts";
import {
  detectLanguage,
  getLanguageName,
  type LanguageDetectionResult,
} from "../util/language.ts";
import { getLogger } from "../util/logger.ts";
import { z } from "zod";

// -- State ---------------------------------------------------------------------

let state: SubsystemState = "uninitialized";
let queuePromise: Promise<void> = Promise.resolve();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 5_000;

type CaptureStatus = "stored" | "duplicate" | "skipped" | "failed";
let lastCaptureStatus: CaptureStatus = "skipped";

type CaptureNotifier = (status: CaptureStatus, error?: string) => void;
let notifier: CaptureNotifier | null = null;

type CaptureDeps = {
  addMemory: typeof addMemory;
  callLLMWithTool: typeof callLLMWithTool;
  storePrompt: typeof storePrompt;
  getLastUncapturedPrompt: typeof getLastUncapturedPrompt;
  markCaptured: typeof markCaptured;
  markAnalyzed: typeof markAnalyzed;
  detectLanguage: (text: string) => Promise<LanguageDetectionResult>;
  getLanguageName: (code: string) => string;
};

const defaultDeps: CaptureDeps = {
  addMemory,
  callLLMWithTool,
  storePrompt,
  getLastUncapturedPrompt,
  markCaptured,
  markAnalyzed,
  detectLanguage,
  getLanguageName,
};

let deps: CaptureDeps = { ...defaultDeps };

// -- Types ---------------------------------------------------------------------

export interface CaptureRequest {
  sessionId: string;
  containerTag: string;
  messages: Array<{ role: string; content: string }>;
  directory: string;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

// -- Extraction tool schema ----------------------------------------------------

const extractionToolSchema: ToolSchema = {
  name: "save_memory",
  description: "Save the conversation summary as a memory",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Markdown-formatted summary of the conversation",
      },
      type: {
        type: "string",
        enum: [
          "feature",
          "bug-fix",
          "refactor",
          "analysis",
          "configuration",
          "discussion",
          "skip",
          "other",
        ],
        description:
          "Type of memory. Use 'skip' for non-technical conversations.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "2-4 technical tags related to the memory",
      },
      importance: {
        type: "number",
        description:
          "Importance score 1-10 (10 = critical architectural decision, 1 = trivial)",
      },
      confidence: {
        type: "number",
        description: "Your confidence in this memory 0.0-1.0",
      },
      evidenceCount: {
        type: "integer",
        description: "How many conversation turns support this memory",
      },
    },
    required: ["summary", "type", "tags", "importance"],
  },
};

function getSystemPrompt(langName: string): string {
  return `You are a technical memory recorder for a software development project.

RULES:
1. ONLY capture technical work (code, bugs, features, architecture, config)
2. SKIP non-technical by returning type="skip"
3. NO meta-commentary or behavior analysis
4. Include specific file names, functions, technical details
5. Generate 2-4 technical tags (e.g., "react", "auth", "bug-fix")
6. You MUST write the summary in ${langName}.

FORMAT for summary:
## Request
[1-2 sentences: what was requested, in ${langName}]

## Outcome
[1-2 sentences: what was done, include files/functions, in ${langName}]

SKIP if: greetings, casual chat, no code/decisions made
CAPTURE if: code changed, bug fixed, feature added, decision made`;
}

// -- Core exports --------------------------------------------------------------

export function initCapture(): void {
  if (state === "uninitialized") {
    state = "ready";
    getLogger().debug("Capture subsystem initialized");
  }
}

export function setCaptureNotifier(fn: CaptureNotifier): void {
  notifier = fn;
}

export function enqueueCapture(opts: CaptureRequest): void {
  const existing = debounceTimers.get(opts.sessionId);
  if (existing) {
    clearTimeout(existing);
  }

  if (state === "uninitialized") {
    state = "ready";
  }

  const logger = getLogger();
  logger.debug("Capture enqueued", { sessionId: opts.sessionId });

  const timer = setTimeout(() => {
    debounceTimers.delete(opts.sessionId);
    queuePromise = queuePromise.then(() => runCapture(opts)).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Capture pipeline error (unhandled)", { error: msg, sessionId: opts.sessionId });
      notifier?.("failed", msg);
    });
  }, DEBOUNCE_MS);

  debounceTimers.set(opts.sessionId, timer);
}

export function getCaptureState(): SubsystemState {
  return state;
}

export function getLastCaptureStatus(): CaptureStatus {
  return lastCaptureStatus;
}

export function resetCapture(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  state = "uninitialized";
  notifier = null;
}

export function _setCaptureDepsForTesting(
  overrides: Partial<CaptureDeps>,
): void {
  deps = { ...deps, ...overrides };
}

export function _resetCaptureDepsForTesting(): void {
  deps = { ...defaultDeps };
}

// -- Internal pipeline ---------------------------------------------------------

async function runCapture(opts: CaptureRequest): Promise<void> {
  const logger = getLogger();

  if (state === "uninitialized") {
    state = "ready";
  }

  const lastUserMessage = findLastUserMessage(opts.messages);
  if (!lastUserMessage) {
    lastCaptureStatus = "skipped";
    logger.debug("Capture skipped: no user message", { sessionId: opts.sessionId });
    return;
  }

  const languageResult = await deps.detectLanguage(lastUserMessage);
  const langName = deps.getLanguageName(languageResult.detectedLang ?? "en");

  const messageId = `msg_${Date.now()}`;
  deps.storePrompt(opts.sessionId, messageId, lastUserMessage, opts.directory);

  const uncaptured = deps.getLastUncapturedPrompt(opts.sessionId);
  if (!uncaptured) {
    lastCaptureStatus = "skipped";
    logger.debug("Capture skipped: no uncaptured prompt", { sessionId: opts.sessionId });
    return;
  }

  const context = opts.messages
    .slice(-15)
    .map((m) => `**${m.role}**: ${m.content.slice(0, 4000)}`)
    .join("\n\n");

  let lastError: string | undefined;
  const result = await deps.callLLMWithTool({
    systemPrompt: getSystemPrompt(langName),
    userPrompt: context,
    toolSchema: extractionToolSchema,
  });

  if (result.success) {
    await processResult(result.data, uncaptured.id, opts);
    logger.debug("Capture completed", { sessionId: opts.sessionId, status: lastCaptureStatus });
    notifier?.(lastCaptureStatus);
    return;
  }

  lastError = result.error;

  logger.error("Capture failed after retries", { error: lastError, sessionId: opts.sessionId });
  state = "degraded";
  lastCaptureStatus = "failed";
  notifier?.("failed", lastError);
}

const ExtractionResultSchema = z.object({
  summary: z.string(),
  type: z.string(),
  tags: z.array(z.string()).default([]),
  importance: z.number().optional(),
  confidence: z.number().optional(),
  evidenceCount: z.number().optional(),
});

async function processResult(
  data: Record<string, unknown>,
  promptId: string,
  opts: CaptureRequest,
): Promise<void> {
  const logger = getLogger();
  const parsed = ExtractionResultSchema.safeParse(data);
  if (!parsed.success) {
    logger.warn("Capture skipped: LLM output validation failed", {
      errors: parsed.error.issues.map((i) => i.message).join(", "),
    });
    lastCaptureStatus = "skipped";
    return;
  }

  const memoryType = parsed.data.type;

  if (memoryType === "skip") {
    deps.markCaptured(promptId, "");
    lastCaptureStatus = "skipped";
    return;
  }

  const result = await deps.addMemory({
    content: parsed.data.summary,
    containerTag: opts.containerTag,
    tags: parsed.data.tags,
    type: memoryType,
    importance: parsed.data.importance ?? 5,
    provenance: {
      sessionId: opts.sessionId,
      messageRange: [
        Math.max(0, opts.messages.length - 15),
        opts.messages.length - 1,
      ],
      toolCallIds: [],
    },
    epistemicStatus: {
      confidence: parsed.data.confidence ?? 0.7,
      evidenceCount: parsed.data.evidenceCount ?? 1,
    },
    displayName: opts.displayName,
    userName: opts.userName,
    userEmail: opts.userEmail,
    projectPath: opts.projectPath,
    projectName: opts.projectName,
    gitRepoUrl: opts.gitRepoUrl,
  });

  lastCaptureStatus = result.deduplicated ? "duplicate" : "stored";
  deps.markCaptured(promptId, result.id);
  deps.markAnalyzed(promptId);
}

// -- Helpers -------------------------------------------------------------------

function findLastUserMessage(
  messages: Array<{ role: string; content: string }>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && messages[i].content.trim().length > 0) {
      return messages[i].content;
    }
  }
  return undefined;
}

