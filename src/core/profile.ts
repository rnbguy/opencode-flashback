import type { Database } from "bun:sqlite";
import {
  getDb,
  getProfile,
  insertProfile,
  updateProfile,
} from "../db/database.ts";
import { callLLMWithTool } from "./llm.ts";
import type { UserProfile, UserProfileChangelog } from "../types.ts";

// ── Constants ────────────────────────────────────────────────────────────────

const ANALYSIS_THRESHOLD = 10;

const PROFILE_SYSTEM_PROMPT = `You are analyzing user conversation prompts to learn about their preferences, patterns, and workflows.
Extract ONLY factual observations. Do NOT infer personality traits.
Focus on: programming languages, tools, frameworks, coding style, project patterns, common workflows.
If a prompt contains no learnable information, return empty objects.`;

const profileToolSchema = {
  name: "update_profile",
  description:
    "Extract user preferences, patterns, and workflows from conversation prompts",
  parameters: {
    type: "object",
    properties: {
      preferences: {
        type: "object",
        description: "User preferences like coding style, tools, languages",
        additionalProperties: { type: "string" },
      },
      patterns: {
        type: "object",
        description: "Recurring patterns in user behavior",
        additionalProperties: { type: "string" },
      },
      workflows: {
        type: "object",
        description: "Common workflows and processes the user follows",
        additionalProperties: { type: "string" },
      },
    },
    required: ["preferences", "patterns", "workflows"],
  },
};

type ProfileDeps = {
  callLLMWithTool: typeof callLLMWithTool;
};

const defaultDeps: ProfileDeps = {
  callLLMWithTool,
};

let deps: ProfileDeps = { ...defaultDeps };

// ── Exported functions ───────────────────────────────────────────────────────

export function getOrCreateProfile(userId: string): UserProfile {
  const db = getDb();
  const existing = getProfile(db, userId);
  if (existing) return existing;

  const profile: UserProfile = {
    id: crypto.randomUUID(),
    userId,
    profileData: { preferences: {}, patterns: {}, workflows: {} },
    version: 1,
    createdAt: Date.now(),
    lastAnalyzedAt: Date.now(),
    totalPromptsAnalyzed: 0,
  };
  insertProfile(db, profile);
  return profile;
}

export async function analyzeAndUpdateProfile(
  userId: string,
  prompts: string[],
): Promise<{ updated: boolean; version: number }> {
  const profile = getOrCreateProfile(userId);

  if (prompts.length < ANALYSIS_THRESHOLD) {
    return { updated: false, version: profile.version };
  }

  const result = await deps.callLLMWithTool({
    systemPrompt: PROFILE_SYSTEM_PROMPT,
    userPrompt: `Analyze these user prompts:\n${prompts.join("\n---\n")}`,
    toolSchema: profileToolSchema,
  });

  if (!result.success) {
    return { updated: false, version: profile.version };
  }

  const extracted = extractProfileData(result.data);

  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read profile inside transaction (prevents TOCTOU)
    const current = getProfile(db, userId)!;
    const merged = mergeProfileData(current.profileData, extracted);

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
      changeSummary: summarizeChanges(current.profileData, merged),
      profileDataSnapshot: merged,
    };
    insertChangelog(db, changelog);

    db.exec("COMMIT");
    return { updated: true, version: newVersion };
  } catch (error) {
    db.exec("ROLLBACK");
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
  const db = getDb();
  const profile = getProfile(db, userId);
  if (!profile) return;

  const decayed = {
    preferences: decaySection(profile.profileData.preferences, decayFactor),
    patterns: decaySection(profile.profileData.patterns, decayFactor),
    workflows: decaySection(profile.profileData.workflows, decayFactor),
  };

  updateProfile(db, { ...profile, profileData: decayed });
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function extractProfileData(
  data: Record<string, unknown>,
): UserProfile["profileData"] {
  return {
    preferences: toSectionRecord(data.preferences),
    patterns: toSectionRecord(data.patterns),
    workflows: toSectionRecord(data.workflows),
  };
}

function toSectionRecord(
  value: unknown,
): Record<string, string | number | boolean | null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      v === null
    ) {
      result[k] = v;
    }
  }
  return result;
}

function mergeProfileData(
  existing: UserProfile["profileData"],
  extracted: UserProfile["profileData"],
): UserProfile["profileData"] {
  return {
    preferences: mergeSection(existing.preferences, extracted.preferences),
    patterns: mergeSection(existing.patterns, extracted.patterns),
    workflows: mergeSection(existing.workflows, extracted.workflows),
  };
}

function mergeSection(
  existing: Record<string, string | number | boolean | null>,
  extracted: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(extracted)) {
    if (value !== null && value !== undefined && value !== "") {
      merged[key] = value;
    }
  }
  return merged;
}

function summarizeChanges(
  old: UserProfile["profileData"],
  updated: UserProfile["profileData"],
): string {
  const changes: string[] = [];
  for (const section of ["preferences", "patterns", "workflows"] as const) {
    const oldKeys = Object.keys(old[section]);
    const newKeys = Object.keys(updated[section]);
    const added = newKeys.filter((k) => !oldKeys.includes(k));
    const modified = newKeys.filter(
      (k) => oldKeys.includes(k) && old[section][k] !== updated[section][k],
    );
    if (added.length > 0) changes.push(`${section}: added ${added.join(", ")}`);
    if (modified.length > 0)
      changes.push(`${section}: updated ${modified.join(", ")}`);
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

function decaySection(
  section: Record<string, string | number | boolean | null>,
  factor: number,
): Record<string, string | number | boolean | null> {
  const result = { ...section };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "number") {
      result[key] = value * factor;
    }
  }
  return result;
}
