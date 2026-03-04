import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LLMCallOptions, LLMCallResult } from "../src/core/ai/generate";

// -- Mock functions -----------------------------------------------------------

const mockCallLLM = mock(
  async (_opts: unknown): Promise<LLMCallResult> => ({
    success: true,
    data: {
      preferences: [
        { category: "language", description: "Rust", confidence: 0.9 },
      ],
      patterns: [{ category: "commit_style", description: "conventional" }],
      workflows: [
        {
          description: "PR-based",
          steps: ["create PR", "review", "merge"],
        },
      ],
    },
  }),
);

import {
  _resetProfileDepsForTesting,
  _setProfileDepsForTesting,
  analyzeAndUpdateProfile,
  decayConfidence,
  getOrCreateProfile,
} from "../src/core/profile";
import { closeDb, getDb, getProfile, updateProfile } from "../src/db/database";

// -- Helpers ------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  closeDb();
  tmpDir = mkdtempSync(join(tmpdir(), "flashback-prof-"));
  getDb(join(tmpDir, "test.db"));
  _setProfileDepsForTesting({
    callLLMWithTool: ((...args: unknown[]) =>
      mockCallLLM(args[0] as LLMCallOptions)) as typeof mockCallLLM,
  });
  mockCallLLM.mockReset();
  mockCallLLM.mockImplementation(async () => ({
    success: true,
    data: {
      preferences: [
        { category: "language", description: "Rust", confidence: 0.9 },
      ],
      patterns: [{ category: "commit_style", description: "conventional" }],
      workflows: [
        {
          description: "PR-based",
          steps: ["create PR", "review", "merge"],
        },
      ],
    },
  }));
});

afterEach(() => {
  _resetProfileDepsForTesting();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// -- getOrCreateProfile -------------------------------------------------------

describe("getOrCreateProfile", () => {
  test("creates default profile on first call", () => {
    const profile = getOrCreateProfile("user-1");

    expect(profile.userId).toBe("user-1");
    expect(profile.totalPromptsAnalyzed).toBe(0);
    expect(profile.profileData).toEqual({
      preferences: [],
      patterns: [],
      workflows: [],
    });
  });

  test("returns existing profile on subsequent calls", () => {
    const first = getOrCreateProfile("user-2");
    const second = getOrCreateProfile("user-2");

    expect(first.id).toBe(second.id);
  });

  test("creates separate profiles for different users", () => {
    const a = getOrCreateProfile("user-a");
    const b = getOrCreateProfile("user-b");

    expect(a.id).not.toBe(b.id);
    expect(a.userId).toBe("user-a");
    expect(b.userId).toBe("user-b");
  });
});

// -- analyzeAndUpdateProfile --------------------------------------------------

describe("analyzeAndUpdateProfile", () => {
  test("skips analysis when prompts < threshold (10)", async () => {
    getOrCreateProfile("user-skip");

    const result = await analyzeAndUpdateProfile("user-skip", [
      "prompt 1",
      "prompt 2",
    ]);

    expect(result.updated).toBe(false);
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  test("analyzes and updates profile with 10+ prompts", async () => {
    getOrCreateProfile("user-analyze");

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile("user-analyze", prompts);

    expect(result.updated).toBe(true);
    expect(mockCallLLM).toHaveBeenCalledTimes(1);

    const db = getDb();
    const profile = getProfile(db, "user-analyze");
    expect(profile!.profileData.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "language", description: "Rust" }),
      ]),
    );
    expect(profile!.profileData.patterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "commit_style",
          description: "conventional",
        }),
      ]),
    );
    expect(profile!.profileData.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ description: "PR-based" }),
      ]),
    );
    expect(profile!.totalPromptsAnalyzed).toBe(10);
  });

  test("merges new preferences with existing", async () => {
    const userId = "user-merge";
    getOrCreateProfile(userId);

    mockCallLLM.mockImplementation(async () => ({
      success: true,
      data: {
        preferences: [
          { category: "language", description: "Rust", confidence: 0.9 },
        ],
        patterns: [],
        workflows: [],
      },
    }));
    await analyzeAndUpdateProfile(
      userId,
      Array.from({ length: 10 }, (_, i) => `batch1-${i}`),
    );

    mockCallLLM.mockImplementation(async () => ({
      success: true,
      data: {
        preferences: [
          { category: "editor", description: "neovim", confidence: 0.8 },
        ],
        patterns: [{ category: "testing", description: "TDD" }],
        workflows: [],
      },
    }));
    const result = await analyzeAndUpdateProfile(
      userId,
      Array.from({ length: 10 }, (_, i) => `batch2-${i}`),
    );

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "language", description: "Rust" }),
        expect.objectContaining({ category: "editor", description: "neovim" }),
      ]),
    );
    expect(profile!.profileData.patterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "testing", description: "TDD" }),
      ]),
    );
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
    expect(result.updated).toBe(false);
  });

  test("performs atomic profile transaction", async () => {
    const userId = "user-atomic";
    getOrCreateProfile(userId);

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    await analyzeAndUpdateProfile(userId, prompts);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile).not.toBeNull();
    expect(profile!.profileData.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "language", description: "Rust" }),
      ]),
    );
  });
});

// -- decayConfidence ----------------------------------------------------------

describe("decayConfidence", () => {
  test("reduces preference confidence by decay factor", () => {
    const userId = "user-decay";
    getOrCreateProfile(userId);

    const db = getDb();
    const profile = getProfile(db, userId)!;
    updateProfile(db, {
      ...profile,
      profileData: {
        preferences: [
          { category: "confidence", description: "test", confidence: 0.8 },
        ],
        patterns: [{ category: "frequency", description: "often" }],
        workflows: [{ description: "count", steps: ["one", "two"] }],
      },
    });

    decayConfidence(userId, 0.5);

    const decayed = getProfile(db, userId)!;
    expect(decayed.profileData.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "confidence",
          description: "test",
          confidence: 0.4,
        }),
      ]),
    );
    expect(decayed.profileData.patterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "frequency",
          description: "often",
        }),
      ]),
    );
    expect(decayed.profileData.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ description: "count" }),
      ]),
    );
  });

  test("uses default decay factor of 0.95", () => {
    const userId = "user-decay-default";
    getOrCreateProfile(userId);

    const db = getDb();
    const profile = getProfile(db, userId)!;
    updateProfile(db, {
      ...profile,
      profileData: {
        preferences: [
          { category: "score", description: "high", confidence: 1.0 },
        ],
        patterns: [],
        workflows: [],
      },
    });

    decayConfidence(userId);

    const decayed = getProfile(db, userId)!;
    expect(decayed.profileData.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "score",
          description: "high",
          confidence: 0.95,
        }),
      ]),
    );
  });

  test("no-ops for nonexistent user", () => {
    decayConfidence("nonexistent-user");
  });

  test("only decays confidence and preserves other preference fields", () => {
    const userId = "user-decay-preserve";
    getOrCreateProfile(userId);

    const db = getDb();
    const profile = getProfile(db, userId)!;
    updateProfile(db, {
      ...profile,
      profileData: {
        preferences: [
          { category: "lang", description: "Rust", confidence: 0.9 },
        ],
        patterns: [],
        workflows: [],
      },
    });

    decayConfidence(userId, 0.5);

    const decayed = getProfile(db, userId)!;
    expect(decayed.profileData.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "lang",
          description: "Rust",
          confidence: 0.45,
        }),
      ]),
    );
  });

  test("applies decay multiple times cumulatively", () => {
    const userId = "user-decay-cumulative";
    getOrCreateProfile(userId);

    const db = getDb();
    const profile = getProfile(db, userId)!;
    updateProfile(db, {
      ...profile,
      profileData: {
        preferences: [
          { category: "score", description: "value", confidence: 100 },
        ],
        patterns: [],
        workflows: [],
      },
    });

    decayConfidence(userId, 0.5);
    decayConfidence(userId, 0.5);
    decayConfidence(userId, 0.5);

    const decayed = getProfile(db, userId)!;
    expect(decayed.profileData.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "score",
          description: "value",
          confidence: 12.5,
        }),
      ]),
    );
  });
});
