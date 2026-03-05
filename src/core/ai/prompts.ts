/**
 * Centralized LLM prompts and tool schemas.
 *
 * All strings that guide LLM behavior live here -- system prompts,
 * user prompt builders, tool schemas, and the structured-output wrapper.
 */

import type { ToolSchema } from "./generate.ts";

// -- Capture (memory extraction) ----------------------------------------------

export const getCaptureSystemPrompt = (langName: string): string =>
  `You are a technical memory recorder for a software development project.

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

export const getCaptureUserPrompt = (context: string): string =>
  `${context}

Analyze this conversation. If it contains technical work (code, bugs, features, decisions), create a concise summary and relevant tags. If it's non-technical (greetings, casual chat, incomplete requests), return type="skip" with empty summary.`;

export const captureToolSchema: ToolSchema = {
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

// -- Profile (user learning) --------------------------------------------------

export const PROFILE_SYSTEM_PROMPT = `You are a user behavior analyst for a coding assistant.
Analyze user prompts to extract preferences, patterns, and workflows.

RULES:
1. Extract ONLY factual observations from what the user explicitly states
2. Do NOT infer personality traits or speculate beyond the evidence
3. Focus on: programming languages, tools, frameworks, coding style, project patterns, workflows
4. If prompts contain no learnable information, return empty arrays
5. Detect the language used in the prompts and write all descriptions in that SAME language
6. Assign confidence 0.5-1.0 based on evidence strength
7. Include 1-3 example prompts as evidence for each preference`;

export const getProfileUserPrompt = (prompts: string[]): string => {
  const numbered = prompts.map((p, i) => `${i + 1}. ${p}`).join("\n\n");
  return `Analyze these ${prompts.length} user prompts to extract the user profile.

## User Prompts

${numbered}

## Guidelines

1. **Preferences**: Code style, tools, languages, frameworks the user prefers
   - Assign confidence 0.5-1.0 based on how explicit the evidence is
   - Include 1-3 example prompts as evidence

2. **Patterns**: Recurring topics, problem domains, technical interests

3. **Workflows**: Development sequences, habits, ordered steps`;
};

export const profileToolSchema: ToolSchema = {
  name: "update_profile",
  description:
    "Extract user preferences, patterns, and workflows from conversation prompts",
  parameters: {
    type: "object",
    properties: {
      preferences: {
        type: "array",
        description: "User preferences like coding style, tools, languages",
        items: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "Category name (e.g. Language, Editor, Testing)",
            },
            description: {
              type: "string",
              description: "What the user prefers",
            },
            confidence: {
              type: "number",
              description: "Confidence 0.0-1.0",
            },
            evidence: {
              type: "array",
              items: { type: "string" },
              description: "Supporting evidence for this preference",
            },
          },
          required: ["category", "description", "confidence"],
        },
      },
      patterns: {
        type: "array",
        description: "Recurring patterns in user behavior",
        items: {
          type: "object",
          properties: {
            category: { type: "string", description: "Pattern category" },
            description: {
              type: "string",
              description: "What the pattern is",
            },
          },
          required: ["category", "description"],
        },
      },
      workflows: {
        type: "array",
        description: "Common workflows and processes the user follows",
        items: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Workflow description",
            },
            steps: {
              type: "array",
              items: { type: "string" },
              description: "Ordered steps",
            },
          },
          required: ["description", "steps"],
        },
      },
    },
    required: ["preferences", "patterns", "workflows"],
  },
};

// -- Structured output wrapper ------------------------------------------------

export const buildStructuredPrompt = (
  userPrompt: string,
  toolSchema: ToolSchema,
): string => {
  const schemaJson = JSON.stringify(toolSchema.parameters);
  const lines = [
    userPrompt,
    "",
    `Return ONLY a raw JSON object for tool '${toolSchema.name}'. Do NOT wrap in markdown code fences.`,
    `Tool description: ${toolSchema.description}`,
    `JSON schema: ${schemaJson}`,
  ];
  return lines.join("\n");
};
