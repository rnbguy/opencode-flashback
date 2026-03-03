import { getDb } from "../db/database.ts";
import type { UserPrompt } from "../types.ts";
import { getLogger } from "../util/logger.ts";

// -- Prompt ID generation -----------------------------------------------------

function generatePromptId(): string {
  return `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// -- Row deserialization ------------------------------------------------------

interface PromptRow {
  id: string;
  session_id: string;
  message_id: string;
  content: string;
  directory: string | null;
  is_captured: number;
  is_user_learning_captured: number;
  linked_memory_id: string | null;
  created_at: number;
}

function rowToPrompt(row: PromptRow): UserPrompt {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    content: row.content,
    directory: row.directory ?? "",
    isCaptured: row.is_captured === 1,
    isUserLearningCaptured: row.is_user_learning_captured === 1,
    linkedMemoryId: row.linked_memory_id ?? undefined,
  };
}

// -- Prompt lifecycle operations ----------------------------------------------

/**
 * Store a new prompt in the database.
 * @param sessionId - Session identifier
 * @param messageId - Message identifier
 * @param content - Prompt content
 * @param directory - Working directory context
 * @returns Generated prompt ID
 */
export function storePrompt(
  sessionId: string,
  messageId: string,
  content: string,
  directory: string,
): string {
  const logger = getLogger();
  logger.debug("storePrompt start", { sessionId, messageId });
  const db = getDb();
  const promptId = generatePromptId();

  const prompt: UserPrompt = {
    id: promptId,
    sessionId,
    messageId,
    content,
    directory,
    isCaptured: false,
    isUserLearningCaptured: false,
  };

  db.query(
    `INSERT INTO user_prompts (
      id, session_id, message_id, content, directory,
      is_captured, is_user_learning_captured, linked_memory_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    prompt.id,
    prompt.sessionId,
    prompt.messageId,
    prompt.content,
    prompt.directory,
    prompt.isCaptured ? 1 : 0,
    prompt.isUserLearningCaptured ? 1 : 0,
    null,
    Date.now(),
  );

  return promptId;
}

/**
 * Get the most recent uncaptured prompt for a session.
 * @param sessionId - Session identifier
 * @returns UserPrompt or null if none found
 */
export function getLastUncapturedPrompt(sessionId: string): UserPrompt | null {
  const logger = getLogger();
  const db = getDb();
  const row = db
    .query(
      "SELECT * FROM user_prompts WHERE session_id = ? AND is_captured = 0 ORDER BY created_at DESC LIMIT 1",
    )
    .get(sessionId) as PromptRow | null;

  const prompt = row ? rowToPrompt(row) : null;
  logger.debug("getLastUncapturedPrompt completed", {
    sessionId,
    found: prompt !== null,
  });
  return prompt;
}

/**
 * Mark a prompt as captured and link it to a memory.
 * @param promptId - Prompt identifier
 * @param memoryId - Memory identifier to link
 */
export function markCaptured(promptId: string, memoryId: string): void {
  const logger = getLogger();
  logger.debug("markCaptured start", { promptId });
  const db = getDb();
  db.query(
    "UPDATE user_prompts SET is_captured = 1, linked_memory_id = ? WHERE id = ?",
  ).run(memoryId, promptId);
}

/**
 * Mark a prompt as analyzed for user learning.
 * @param promptId - Prompt identifier
 */
export function markAnalyzed(promptId: string): void {
  const logger = getLogger();
  logger.debug("markAnalyzed start", { promptId });
  const db = getDb();
  db.query(
    "UPDATE user_prompts SET is_user_learning_captured = 1 WHERE id = ?",
  ).run(promptId);
}

/**
 * Get unanalyzed prompts for user learning.
 * @param count - Maximum number of prompts to retrieve
 * @returns Array of UserPrompt objects
 */
export function getUnanalyzedPrompts(count: number): UserPrompt[] {
  const logger = getLogger();
  const db = getDb();
  const rows = db
    .query(
      "SELECT * FROM user_prompts WHERE is_user_learning_captured = 0 ORDER BY created_at ASC LIMIT ?",
    )
    .all(count) as PromptRow[];

  const prompts = rows.map(rowToPrompt);
  logger.debug("getUnanalyzedPrompts completed", { count: prompts.length });
  return prompts;
}
