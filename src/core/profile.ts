import type { Database } from "bun:sqlite";
import {
  getDb,
  getProfile,
  insertProfile,
  updateProfile,
} from "../db/database.ts";
import { getLogger } from "../util/logger.ts";
import { callLLMWithTool } from "./llm.ts";
import type {
  ProfilePattern,
  ProfilePreference,
  ProfileWorkflow,
  UserProfile,
  UserProfileChangelog,
} from "../types.ts";

// -- Constants ----------------------------------------------------------------

const ANALYSIS_THRESHOLD = 10;

const PROFILE_SYSTEM_PROMPT = `You are analyzing user conversation prompts to learn about their preferences, patterns, and workflows.
Extract ONLY factual observations. Do NOT infer personality traits.
Focus on: programming languages, tools, frameworks, coding style, project patterns, common workflows.
If a prompt contains no learnable information, return empty arrays.`;

const profileToolSchema = {
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

type ProfileDeps = {
  callLLMWithTool: typeof callLLMWithTool;
};

type NormalizedProfileData = {
  preferences: ProfilePreference[];
  patterns: ProfilePattern[];
  workflows: ProfileWorkflow[];
};

const defaultDeps: ProfileDeps = {
  callLLMWithTool,
};

let deps: ProfileDeps = { ...defaultDeps };

// -- Exported functions -------------------------------------------------------

export function getOrCreateProfile(userId: string): UserProfile {
  const logger = getLogger();
  const db = getDb();
  const existing = getProfile(db, userId);
  if (existing) {
    const normalized = normalizeProfileData(existing.profileData);
    logger.debug("getOrCreateProfile completed", { userId, status: "found" });
    return { ...existing, profileData: normalized };
  }

  const profile: UserProfile = {
    id: crypto.randomUUID(),
    userId,
    profileData: { preferences: [], patterns: [], workflows: [] },
    version: 1,
    createdAt: Date.now(),
    lastAnalyzedAt: Date.now(),
    totalPromptsAnalyzed: 0,
  };
  insertProfile(db, profile);
  logger.debug("getOrCreateProfile completed", { userId, status: "created" });
  return profile;
}

export async function analyzeAndUpdateProfile(
  userId: string,
  prompts: string[],
): Promise<{ updated: boolean; version: number }> {
  const logger = getLogger();
  const profile = getOrCreateProfile(userId);

  if (prompts.length < ANALYSIS_THRESHOLD) {
    logger.debug("analyzeAndUpdateProfile completed", {
      userId,
      promptCount: prompts.length,
      status: "skipped",
    });
    return { updated: false, version: profile.version };
  }

  const result = await deps.callLLMWithTool({
    systemPrompt: PROFILE_SYSTEM_PROMPT,
    userPrompt: `Analyze these user prompts:\n${prompts.join("\n---\n")}`,
    toolSchema: profileToolSchema,
  });

  if (!result.success) {
    logger.debug("analyzeAndUpdateProfile completed", {
      userId,
      promptCount: prompts.length,
      status: "skipped",
    });
    return { updated: false, version: profile.version };
  }

  const extracted = extractProfileData(result.data);

  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read profile inside transaction (prevents TOCTOU)
    const current = getProfile(db, userId)!;
    const currentData = normalizeProfileData(current.profileData);
    const merged = mergeProfileData(currentData, extracted);

    const newVersion = current.version + 1;
    const updated: UserProfile = {
      ...current,
      profileData: merged,
      version: newVersion,
      lastAnalyzedAt: Date.now(),
      totalPromptsAnalyzed: current.totalPromptsAnalyzed + prompts.length,
    };

    updateProfile(db, updated);

    const changelog: UserProfileChangelog = {
      id: crypto.randomUUID(),
      profileId: current.id,
      version: newVersion,
      changeSummary: summarizeChanges(currentData, merged),
      profileDataSnapshot: merged,
    };
    insertChangelog(db, changelog);

    db.exec("COMMIT");
    logger.debug("analyzeAndUpdateProfile completed", {
      userId,
      promptCount: prompts.length,
      status: "updated",
    });
    return { updated: true, version: newVersion };
  } catch (error) {
    db.exec("ROLLBACK");
    logger.error("analyzeAndUpdateProfile failed", { userId });
    throw error;
  }
}

export function _setProfileDepsForTesting(
  overrides: Partial<ProfileDeps>,
): void {
  deps = { ...deps, ...overrides };
}

export function _resetProfileDepsForTesting(): void {
  deps = { ...defaultDeps };
}

export function decayConfidence(userId: string, decayFactor = 0.95): void {
  const logger = getLogger();
  logger.debug("decayConfidence start", { userId });
  const db = getDb();
  const profile = getProfile(db, userId);
  if (!profile) return;
  const normalized = normalizeProfileData(profile.profileData);

  const decayed = {
    preferences: normalized.preferences.map((preference) => ({
      ...preference,
      confidence: preference.confidence * decayFactor,
    })),
    patterns: normalized.patterns,
    workflows: normalized.workflows,
  };

  updateProfile(db, { ...profile, profileData: decayed });
}

// -- Internal helpers ---------------------------------------------------------

function extractProfileData(
  data: Record<string, unknown>,
): NormalizedProfileData {
  return {
    preferences: toPreferenceArray(data.preferences),
    patterns: toPatternArray(data.patterns),
    workflows: toWorkflowArray(data.workflows),
  };
}

function normalizeProfileData(
  profileData: UserProfile["profileData"],
): NormalizedProfileData {
  const data = profileData as unknown as Record<string, unknown>;
  return {
    preferences: toPreferenceArray(data.preferences),
    patterns: toPatternArray(data.patterns),
    workflows: toWorkflowArray(data.workflows),
  };
}

function toPreferenceArray(value: unknown): ProfilePreference[] {
  const isCorruptedPreference = (item: ProfilePreference): boolean => {
    const hasNumericCategory = /^\d+$/.test(item.category);
    const hasCorruptedDescription =
      item.description === "[object Object]" || item.description.trim() === "";
    return hasNumericCategory && hasCorruptedDescription;
  };

  if (Array.isArray(value)) {
    return value
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
      .map((item) => ({
        category: String(item.category ?? "General"),
        description: String(item.description ?? ""),
        confidence: typeof item.confidence === "number" ? item.confidence : 0.7,
        ...(Array.isArray(item.evidence)
          ? { evidence: item.evidence.map(String) }
          : {}),
      }))
      .filter((item) => !isCorruptedPreference(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        if (typeof v === "object" && v !== null) {
          const obj = v as Record<string, unknown>;
          return {
            category: String(obj.category ?? k),
            description: String(obj.description ?? ""),
            confidence: typeof obj.confidence === "number" ? obj.confidence : 0.7,
          };
        }

        return {
          category: k,
          description: String(v ?? ""),
          confidence: typeof v === "number" ? v : 0.7,
        };
      })
      .filter((item) => !isCorruptedPreference(item));
  }
  return [];
}

function toPatternArray(value: unknown): ProfilePattern[] {
  const isCorruptedPattern = (item: ProfilePattern): boolean => {
    const hasNumericCategory = /^\d+$/.test(item.category);
    const hasCorruptedDescription =
      item.description === "[object Object]" || item.description.trim() === "";
    return hasNumericCategory && hasCorruptedDescription;
  };

  if (Array.isArray(value)) {
    return value
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
      .map((item) => ({
        category: String(item.category ?? "General"),
        description: String(item.description ?? ""),
      }))
      .filter((item) => !isCorruptedPattern(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        if (typeof v === "object" && v !== null) {
          const obj = v as Record<string, unknown>;
          return {
            category: String(obj.category ?? k),
            description: String(obj.description ?? ""),
          };
        }

        return {
          category: k,
          description: String(v ?? ""),
        };
      })
      .filter((item) => !isCorruptedPattern(item));
  }
  return [];
}

function toWorkflowArray(value: unknown): ProfileWorkflow[] {
  const isCorruptedWorkflow = (item: ProfileWorkflow): boolean => {
    return /^\d+$/.test(item.description);
  };

  if (Array.isArray(value)) {
    return value
      .filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
      .map((item) => ({
        description: String(item.description ?? ""),
        steps: Array.isArray(item.steps) ? item.steps.map(String) : [],
      }))
      .filter((item) => !isCorruptedWorkflow(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => {
        if (typeof v === "object" && v !== null) {
          const obj = v as Record<string, unknown>;
          return {
            description: String(obj.description ?? k),
            steps: Array.isArray(obj.steps) ? obj.steps.map(String) : [],
          };
        }

        return {
          description: k,
          steps: typeof v === "string" ? [v] : [],
        };
      })
      .filter((item) => !isCorruptedWorkflow(item));
  }
  return [];
}

function mergeProfileData(
  existing: NormalizedProfileData,
  extracted: NormalizedProfileData,
): NormalizedProfileData {
  return {
    preferences: mergePreferences(existing.preferences, extracted.preferences),
    patterns: mergePatterns(existing.patterns, extracted.patterns),
    workflows: mergeWorkflows(existing.workflows, extracted.workflows),
  };
}

function mergePreferences(
  existing: ProfilePreference[],
  extracted: ProfilePreference[],
): ProfilePreference[] {
  const merged = [...existing];
  for (const item of extracted) {
    const index = merged.findIndex((entry) => entry.category === item.category);
    if (index >= 0) {
      merged[index] = item;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

function mergePatterns(
  existing: ProfilePattern[],
  extracted: ProfilePattern[],
): ProfilePattern[] {
  const merged = [...existing];
  for (const item of extracted) {
    const index = merged.findIndex((entry) => entry.category === item.category);
    if (index >= 0) {
      merged[index] = item;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

function mergeWorkflows(
  existing: ProfileWorkflow[],
  extracted: ProfileWorkflow[],
): ProfileWorkflow[] {
  const merged = [...existing];
  for (const item of extracted) {
    const index = merged.findIndex(
      (entry) => entry.description === item.description,
    );
    if (index >= 0) {
      merged[index] = item;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

function summarizeChanges(
  old: NormalizedProfileData,
  updated: NormalizedProfileData,
): string {
  const changes: string[] = [];

  const oldPreferenceCategories = new Set(old.preferences.map((item) => item.category));
  const newPreferenceCategories = updated.preferences.map((item) => item.category);
  const addedPreferences = newPreferenceCategories.filter(
    (category) => !oldPreferenceCategories.has(category),
  );
  const updatedPreferences = newPreferenceCategories.filter((category) =>
    oldPreferenceCategories.has(category),
  );
  if (addedPreferences.length > 0) {
    changes.push(`preferences: added ${addedPreferences.join(", ")}`);
  }
  if (updatedPreferences.length > 0) {
    changes.push(`preferences: updated ${updatedPreferences.join(", ")}`);
  }

  const oldPatternCategories = new Set(old.patterns.map((item) => item.category));
  const newPatternCategories = updated.patterns.map((item) => item.category);
  const addedPatterns = newPatternCategories.filter(
    (category) => !oldPatternCategories.has(category),
  );
  if (addedPatterns.length > 0) {
    changes.push(`patterns: added ${addedPatterns.join(", ")}`);
  }

  const oldWorkflowDescriptions = new Set(
    old.workflows.map((item) => item.description),
  );
  const newWorkflowDescriptions = updated.workflows.map(
    (item) => item.description,
  );
  const addedWorkflows = newWorkflowDescriptions.filter(
    (description) => !oldWorkflowDescriptions.has(description),
  );
  if (addedWorkflows.length > 0) {
    changes.push(`workflows: added ${addedWorkflows.join(", ")}`);
  }

  return changes.length > 0 ? changes.join("; ") : "no changes";
}

function insertChangelog(db: Database, changelog: UserProfileChangelog): void {
  db.query(
    `INSERT INTO user_profile_changelogs (id, profile_id, version, change_summary, profile_data_snapshot, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    changelog.id,
    changelog.profileId,
    changelog.version,
    changelog.changeSummary,
    JSON.stringify(changelog.profileDataSnapshot),
    Date.now(),
  );
}
