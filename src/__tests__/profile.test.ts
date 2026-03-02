import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LLMCallResult } from "../core/llm";

// ── Mock functions ───────────────────────────────────────────────────────────

const mockCallLLM = mock(
  async (_opts: unknown): Promise<LLMCallResult> => ({
    success: true,
    data: {
      preferences: { language: "Rust" },
      patterns: { commit_style: "conventional" },
      workflows: { review: "PR-based" },
    },
  }),
);

// ── Module mocks (hoisted) ───────────────────────────────────────────────────

mock.module("../core/llm.ts", () => ({
  callLLMWithTool: ((...args: unknown[]) => mockCallLLM(args[0] as any)) as any,
}));

// ── Imports (resolved after mocks) ───────────────────────────────────────────

import { getDb, closeDb, getProfile, updateProfile } from "../db/database";
import {
  getOrCreateProfile,
  analyzeAndUpdateProfile,
  decayConfidence,
} from "../core/profile";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  closeDb();
  tmpDir = mkdtempSync(join(tmpdir(), "flashback-prof-"));
  getDb(join(tmpDir, "test.db"));
  mockCallLLM.mockReset();
  mockCallLLM.mockImplementation(async () => ({
    success: true,
    data: {
      preferences: { language: "Rust" },
      patterns: { commit_style: "conventional" },
      workflows: { review: "PR-based" },
    },
  }));
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── getOrCreateProfile ───────────────────────────────────────────────────────

describe("getOrCreateProfile", () => {
  test("creates default profile on first call", () => {
    const profile = getOrCreateProfile("user-1");

    expect(profile.userId).toBe("user-1");
    expect(profile.version).toBe(1);
    expect(profile.totalPromptsAnalyzed).toBe(0);
    expect(profile.profileData).toEqual({
      preferences: {},
      patterns: {},
      workflows: {},
    });
  });

  test("returns existing profile on subsequent calls", () => {
    const first = getOrCreateProfile("user-2");
    const second = getOrCreateProfile("user-2");

    expect(first.id).toBe(second.id);
    expect(first.version).toBe(second.version);
  });

  test("creates separate profiles for different users", () => {
    const a = getOrCreateProfile("user-a");
    const b = getOrCreateProfile("user-b");

    expect(a.id).not.toBe(b.id);
    expect(a.userId).toBe("user-a");
    expect(b.userId).toBe("user-b");
  });
});

// ── analyzeAndUpdateProfile ──────────────────────────────────────────────────

describe("analyzeAndUpdateProfile", () => {
  test("skips analysis when prompts < threshold (10)", async () => {
    getOrCreateProfile("user-skip");

    const result = await analyzeAndUpdateProfile("user-skip", [
      "prompt 1",
      "prompt 2",
    ]);

    expect(result.updated).toBe(false);
    expect(result.version).toBe(1);
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  test("analyzes and updates profile with 10+ prompts", async () => {
    getOrCreateProfile("user-analyze");

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile("user-analyze", prompts);

    expect(result.updated).toBe(true);
    expect(result.version).toBe(2);
    expect(mockCallLLM).toHaveBeenCalledTimes(1);

    const db = getDb();
    const profile = getProfile(db, "user-analyze");
    expect(profile!.profileData.preferences.language).toBe("Rust");
    expect(profile!.profileData.patterns.commit_style).toBe("conventional");
    expect(profile!.profileData.workflows.review).toBe("PR-based");
    expect(profile!.totalPromptsAnalyzed).toBe(10);
  });

  test("merges new preferences with existing", async () => {
    const userId = "user-merge";
    getOrCreateProfile(userId);

    mockCallLLM.mockImplementation(async () => ({
      success: true,
      data: {
        preferences: { language: "Rust" },
        patterns: {},
        workflows: {},
      },
    }));
    await analyzeAndUpdateProfile(
      userId,
      Array.from({ length: 10 }, (_, i) => `batch1-${i}`),
    );

    mockCallLLM.mockImplementation(async () => ({
      success: true,
      data: {
        preferences: { editor: "neovim" },
        patterns: { testing: "TDD" },
        workflows: {},
      },
    }));
    const result = await analyzeAndUpdateProfile(
      userId,
      Array.from({ length: 10 }, (_, i) => `batch2-${i}`),
    );

    expect(result.version).toBe(3);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.preferences.language).toBe("Rust");
    expect(profile!.profileData.preferences.editor).toBe("neovim");
    expect(profile!.profileData.patterns.testing).toBe("TDD");
    expect(profile!.totalPromptsAnalyzed).toBe(20);
  });

  test("does not update on LLM failure", async () => {
    getOrCreateProfile("user-fail");

    mockCallLLM.mockImplementation(async () => ({
      success: false,
      error: "api error",
      code: "api_error" as const,
    }));

    const result = await analyzeAndUpdateProfile(
      "user-fail",
      Array.from({ length: 10 }, (_, i) => `prompt-${i}`),
    );

    expect(result.updated).toBe(false);
    expect(result.version).toBe(1);
  });

  test("performs atomic transaction with changelog", async () => {
    const userId = "user-atomic";
    getOrCreateProfile(userId);

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    await analyzeAndUpdateProfile(userId, prompts);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.version).toBe(2);
    expect(profile!.profileData.preferences.language).toBe("Rust");

    const changelog = db
      .query("SELECT * FROM user_profile_changelogs WHERE profile_id = ?")
      .get(profile!.id) as {
      version: number;
      change_summary: string;
      profile_data_snapshot: string;
    } | null;

    expect(changelog).not.toBeNull();
    expect(changelog!.version).toBe(2);
  });
});

// ── Changelog ────────────────────────────────────────────────────────────────

describe("changelog", () => {
  test("records added preferences in change summary", async () => {
    const userId = "user-changelog";
    getOrCreateProfile(userId);

    await analyzeAndUpdateProfile(
      userId,
      Array.from({ length: 10 }, (_, i) => `prompt-${i}`),
    );

    const db = getDb();
    const profile = getProfile(db, userId);
    const changelog = db
      .query(
        "SELECT change_summary FROM user_profile_changelogs WHERE profile_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(profile!.id) as { change_summary: string } | null;

    expect(changelog).not.toBeNull();
    expect(changelog!.change_summary).toContain("preferences: added language");
  });

  test("records updated preferences in change summary", async () => {
    const userId = "user-changelog-update";
    getOrCreateProfile(userId);

    mockCallLLM.mockImplementation(async () => ({
      success: true,
      data: {
        preferences: { language: "Rust" },
        patterns: {},
        workflows: {},
      },
    }));
    await analyzeAndUpdateProfile(
      userId,
      Array.from({ length: 10 }, (_, i) => `a-${i}`),
    );

    mockCallLLM.mockImplementation(async () => ({
      success: true,
      data: {
        preferences: { language: "Go" },
        patterns: {},
        workflows: {},
      },
    }));
    await analyzeAndUpdateProfile(
      userId,
      Array.from({ length: 10 }, (_, i) => `b-${i}`),
    );

    const db = getDb();
    const profile = getProfile(db, userId);
    const changelog = db
      .query(
        "SELECT change_summary FROM user_profile_changelogs WHERE profile_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(profile!.id) as { change_summary: string } | null;

    expect(changelog!.change_summary).toContain(
      "preferences: updated language",
    );
  });

  test("stores profile data snapshot in changelog", async () => {
    const userId = "user-snapshot";
    getOrCreateProfile(userId);

    await analyzeAndUpdateProfile(
      userId,
      Array.from({ length: 10 }, (_, i) => `prompt-${i}`),
    );

    const db = getDb();
    const profile = getProfile(db, userId);
    const changelog = db
      .query(
        "SELECT profile_data_snapshot FROM user_profile_changelogs WHERE profile_id = ?",
      )
      .get(profile!.id) as { profile_data_snapshot: string } | null;

    const snapshot = JSON.parse(changelog!.profile_data_snapshot);
    expect(snapshot.preferences.language).toBe("Rust");
  });
});

// ── decayConfidence ──────────────────────────────────────────────────────────

describe("decayConfidence", () => {
  test("reduces numeric values by decay factor", () => {
    const userId = "user-decay";
    getOrCreateProfile(userId);

    const db = getDb();
    const profile = getProfile(db, userId)!;
    updateProfile(db, {
      ...profile,
      profileData: {
        preferences: { score: 0.8, name: "test" },
        patterns: { frequency: 5 },
        workflows: { count: 10 },
      },
    });

    decayConfidence(userId, 0.5);

    const decayed = getProfile(db, userId)!;
    expect(decayed.profileData.preferences.score).toBe(0.4);
    expect(decayed.profileData.preferences.name).toBe("test");
    expect(decayed.profileData.patterns.frequency).toBe(2.5);
    expect(decayed.profileData.workflows.count).toBe(5);
  });

  test("uses default decay factor of 0.95", () => {
    const userId = "user-decay-default";
    getOrCreateProfile(userId);

    const db = getDb();
    const profile = getProfile(db, userId)!;
    updateProfile(db, {
      ...profile,
      profileData: {
        preferences: { score: 1.0 },
        patterns: {},
        workflows: {},
      },
    });

    decayConfidence(userId);

    const decayed = getProfile(db, userId)!;
    expect(decayed.profileData.preferences.score).toBeCloseTo(0.95, 10);
  });

  test("no-ops for nonexistent user", () => {
    decayConfidence("nonexistent-user");
  });

  test("preserves non-numeric values", () => {
    const userId = "user-decay-preserve";
    getOrCreateProfile(userId);

    const db = getDb();
    const profile = getProfile(db, userId)!;
    updateProfile(db, {
      ...profile,
      profileData: {
        preferences: { lang: "Rust", active: true, note: null },
        patterns: {},
        workflows: {},
      },
    });

    decayConfidence(userId, 0.5);

    const decayed = getProfile(db, userId)!;
    expect(decayed.profileData.preferences.lang).toBe("Rust");
    expect(decayed.profileData.preferences.active).toBe(true);
    expect(decayed.profileData.preferences.note).toBeNull();
  });

  test("applies decay multiple times cumulatively", () => {
    const userId = "user-decay-cumulative";
    getOrCreateProfile(userId);

    const db = getDb();
    const profile = getProfile(db, userId)!;
    updateProfile(db, {
      ...profile,
      profileData: {
        preferences: { score: 100 },
        patterns: {},
        workflows: {},
      },
    });

    decayConfidence(userId, 0.5);
    decayConfidence(userId, 0.5);
    decayConfidence(userId, 0.5);

    const decayed = getProfile(db, userId)!;
    expect(decayed.profileData.preferences.score).toBeCloseTo(12.5, 10);
  });
});
