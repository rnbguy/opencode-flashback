import { z } from "zod";
import type { SubsystemState } from "../types.ts";
import {
  detectLanguage,
  getLanguageName,
  type LanguageDetectionResult,
} from "../util/language.ts";
import { getLogger } from "../util/logger.ts";
import { callLLMWithTool } from "./ai/generate.ts";
import {
  captureToolSchema,
  getCaptureSystemPrompt,
  getCaptureUserPrompt,
} from "./ai/prompts.ts";
import { addMemory } from "./memory.ts";
import { getLastUncapturedPrompt, markCaptured } from "./prompts.ts";

// -- State ---------------------------------------------------------------------

let state: SubsystemState = "uninitialized";
let queuePromise: Promise<void> = Promise.resolve();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 5_000;

type CaptureStatus = "stored" | "duplicate" | "skipped" | "failed";
let lastCaptureStatus: CaptureStatus = "skipped";

type CaptureDeps = {
  addMemory: typeof addMemory;
  callLLMWithTool: typeof callLLMWithTool;
  getLastUncapturedPrompt: typeof getLastUncapturedPrompt;
  markCaptured: typeof markCaptured;
  detectLanguage: (text: string) => Promise<LanguageDetectionResult>;
  getLanguageName: (code: string) => string;
};

const defaultDeps: CaptureDeps = {
  addMemory,
  callLLMWithTool,
  getLastUncapturedPrompt,
  markCaptured,
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
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

// -- Core exports --------------------------------------------------------------

// -- Core exports --------------------------------------------------------------

export function initCapture(): void {
  if (state === "uninitialized") {
    state = "ready";
    getLogger().debug("Capture subsystem initialized");
  }
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
    queuePromise = queuePromise
      .then(() => runCapture(opts))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Capture pipeline error (unhandled)", {
          error: msg,
          sessionId: opts.sessionId,
        });
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
    logger.debug("Capture skipped: no user message", {
      sessionId: opts.sessionId,
    });
    return;
  }

  const languageResult = await deps.detectLanguage(lastUserMessage);
  const langName = deps.getLanguageName(languageResult.detectedLang ?? "en");

  const uncaptured = deps.getLastUncapturedPrompt(opts.sessionId);
  if (!uncaptured) {
    lastCaptureStatus = "skipped";
    logger.debug("Capture skipped: no uncaptured prompt", {
      sessionId: opts.sessionId,
    });
    return;
  }

  const context = opts.messages
    .slice(-15)
    .map((m) => `**${m.role}**: ${m.content.slice(0, 4000)}`)
    .join("\n\n");

  const result = await deps.callLLMWithTool({
    systemPrompt: getCaptureSystemPrompt(langName),
    userPrompt: getCaptureUserPrompt(context),
    toolSchema: captureToolSchema,
  });

  if (result.success) {
    await processResult(result.data, uncaptured.id, opts);
    logger.debug("Capture completed", {
      sessionId: opts.sessionId,
      status: lastCaptureStatus,
    });
    if (lastCaptureStatus === "stored") {
      logger.info("Memory auto-captured", { sessionId: opts.sessionId });
    }
    return;
  }

  const lastError = result.error;

  logger.error("Capture failed after retries", {
    error: lastError,
    sessionId: opts.sessionId,
  });
  state = "degraded";
  lastCaptureStatus = "failed";
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
    userName: opts.userName,
    userEmail: opts.userEmail,
    projectPath: opts.projectPath,
    projectName: opts.projectName,
    gitRepoUrl: opts.gitRepoUrl,
  });

  lastCaptureStatus = result.deduplicated ? "duplicate" : "stored";
  deps.markCaptured(promptId, result.id);
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
