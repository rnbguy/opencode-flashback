import { z } from "zod";
import {
  getDb,
  getProfile,
  insertProfile,
  updateProfile,
} from "../db/database.ts";
import type {
  ProfilePattern,
  ProfilePreference,
  ProfileWorkflow,
  UserProfile,
} from "../types.ts";
import { getLogger } from "../util/logger.ts";
import { callLLMWithTool } from "./ai/generate.ts";
import {
  getProfileUserPrompt,
  PROFILE_SYSTEM_PROMPT,
  profileToolSchema,
} from "./ai/prompts.ts";

// -- Constants ----------------------------------------------------------------

const ANALYSIS_THRESHOLD = 10;

// -- Zod schemas for profile validation --------------------------------------

const PreferenceSchema = z.object({
  category: z.string().min(1),
  description: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).optional(),
});

const PatternSchema = z.object({
  category: z.string().min(1),
  description: z.string().min(1),
});

const WorkflowSchema = z.object({
  description: z.string().min(1),
  steps: z.array(z.string().min(1)).min(2),
});

const ProfileDataSchema = z.object({
  preferences: z.array(PreferenceSchema),
  patterns: z.array(PatternSchema),
  workflows: z.array(WorkflowSchema),
});

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
): Promise<{ updated: boolean }> {
  const logger = getLogger();
  const _profile = getOrCreateProfile(userId);

  if (prompts.length < ANALYSIS_THRESHOLD) {
    logger.debug("analyzeAndUpdateProfile completed", {
      userId,
      promptCount: prompts.length,
      status: "skipped",
    });
    return { updated: false };
  }

  const result = await deps.callLLMWithTool({
    systemPrompt: PROFILE_SYSTEM_PROMPT,
    userPrompt: getProfileUserPrompt(prompts),
    toolSchema: profileToolSchema,
  });

  if (!result.success) {
    logger.debug("analyzeAndUpdateProfile completed", {
      userId,
      promptCount: prompts.length,
      status: "skipped",
    });
    return { updated: false };
  }

  const extracted = extractProfileData(result.data);

  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read profile inside transaction (prevents TOCTOU)
    const current = getProfile(db, userId)!;
    const currentData = normalizeProfileData(current.profileData);
    const merged = mergeProfileData(currentData, extracted);

    const updated: UserProfile = {
      ...current,
      profileData: merged,
      lastAnalyzedAt: Date.now(),
      totalPromptsAnalyzed: current.totalPromptsAnalyzed + prompts.length,
    };

    updateProfile(db, updated);

    db.exec("COMMIT");
    logger.debug("analyzeAndUpdateProfile completed", {
      userId,
      promptCount: prompts.length,
      status: "updated",
    });
    return { updated: true };
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
  const logger = getLogger();
  const raw = {
    preferences: toPreferenceArray(data.preferences),
    patterns: toPatternArray(data.patterns),
    workflows: toWorkflowArray(data.workflows),
  };

  const result = ProfileDataSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  // Validation failed -- log errors, filter invalid entries, notify
  const errors = result.error.issues.map(
    (i) => `${i.path.join(".")}: ${i.message}`,
  );
  logger.error("Profile validation errors", { errors });

  // Fall back: validate each item individually, keep only valid ones
  const preferences = raw.preferences.filter(
    (p) => PreferenceSchema.safeParse(p).success,
  );
  const patterns = raw.patterns.filter(
    (p) => PatternSchema.safeParse(p).success,
  );
  const workflows = raw.workflows.filter(
    (w) => WorkflowSchema.safeParse(w).success,
  );
  return { preferences, patterns, workflows };
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
            confidence:
              typeof obj.confidence === "number" ? obj.confidence : 0.7,
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
      const current = merged[index];
      // Only overwrite if the new entry has a non-empty description
      if (!item.description.trim()) continue;
      merged[index] = {
        ...item,
        confidence: Math.max(item.confidence, current.confidence),
        evidence: [
          ...new Set([...(current.evidence ?? []), ...(item.evidence ?? [])]),
        ].slice(0, 5),
      };
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
      // Only overwrite if the new entry has a non-empty description
      if (!item.description.trim()) continue;
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
