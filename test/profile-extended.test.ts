import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTesting, _setConfigForTesting } from "../src/config";
import {
  _resetProfileDepsForTesting,
  _setProfileDepsForTesting,
  analyzeAndUpdateProfile,
  getOrCreateProfile,
} from "../src/core/profile";
import { closeDb, getDb, getProfile, updateProfile } from "../src/db/database";
import { makeTestConfig } from "./fixtures/config";

let tmpDir: string;

beforeEach(() => {
  closeDb();
  tmpDir = mkdtempSync(join(tmpdir(), "test-profile-ext-"));
  getDb(join(tmpDir, "test.db"));
  _setConfigForTesting(makeTestConfig());
  _setProfileDepsForTesting({
    callLLMWithTool: async () => ({
      success: true,
      data: {
        preferences: [],
        patterns: [],
        workflows: [],
      },
    }),
  });
});

afterEach(() => {
  _resetProfileDepsForTesting();
  _resetConfigForTesting();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// -- toPreferenceArray with object input (lines 280-301) ----------------------

describe("toPreferenceArray with object input", () => {
  test("converts object with nested preference objects", async () => {
    const userId = "user-obj-prefs";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: {
            lang: {
              category: "Language",
              description: "TypeScript",
              confidence: 0.85,
            },
            editor: {
              category: "Editor",
              description: "VSCode",
              confidence: 0.9,
            },
          },
          patterns: [],
          workflows: [],
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "Language",
          description: "TypeScript",
          confidence: 0.85,
        }),
        expect.objectContaining({
          category: "Editor",
          description: "VSCode",
          confidence: 0.9,
        }),
      ]),
    );
  });

  test("converts object with scalar values as preferences", async () => {
    const userId = "user-scalar-prefs";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: {
            language: "Rust",
            testing: "TDD",
            vcs: 0.8,
          },
          patterns: [],
          workflows: [],
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "language",
          description: "Rust",
        }),
        expect.objectContaining({
          category: "testing",
          description: "TDD",
        }),
        expect.objectContaining({
          category: "vcs",
          description: "0.8",
        }),
      ]),
    );
  });

  test("filters corrupted preferences from object input", async () => {
    const userId = "user-corrupt-obj-prefs";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: {
            "123": {
              category: "123",
              description: "[object Object]",
              confidence: 0.5,
            },
            valid: {
              category: "Language",
              description: "Go",
              confidence: 0.7,
            },
          },
          patterns: [],
          workflows: [],
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "Language",
          description: "Go",
        }),
      ]),
    );
    expect(profile!.profileData.preferences).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "123",
        }),
      ]),
    );
  });
});

// -- toPatternArray with object input (lines 324-342) -------------------------

describe("toPatternArray with object input", () => {
  test("converts object with nested pattern objects", async () => {
    const userId = "user-obj-patterns";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: {
            commit: {
              category: "VCS",
              description: "Conventional commits",
            },
            testing: {
              category: "QA",
              description: "Unit tests first",
            },
          },
          workflows: [],
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.patterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "VCS",
          description: "Conventional commits",
        }),
        expect.objectContaining({
          category: "QA",
          description: "Unit tests first",
        }),
      ]),
    );
  });

  test("converts object with scalar values as patterns", async () => {
    const userId = "user-scalar-patterns";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: {
            refactoring: "incremental",
            documentation: "inline",
          },
          workflows: [],
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.patterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "refactoring",
          description: "incremental",
        }),
        expect.objectContaining({
          category: "documentation",
          description: "inline",
        }),
      ]),
    );
  });

  test("filters corrupted patterns from object input", async () => {
    const userId = "user-corrupt-obj-patterns";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: {
            "456": {
              category: "456",
              description: "[object Object]",
            },
            valid: {
              category: "Style",
              description: "Functional",
            },
          },
          workflows: [],
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.patterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "Style",
          description: "Functional",
        }),
      ]),
    );
    expect(profile!.profileData.patterns).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "456",
        }),
      ]),
    );
  });
});

// -- toWorkflowArray with object input (lines 362-380) -------------------------

describe("toWorkflowArray with object input", () => {
  test("converts object with nested workflow objects", async () => {
    const userId = "user-obj-workflows";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: [],
          workflows: {
            pr_flow: {
              description: "Pull request workflow",
              steps: ["fork", "branch", "commit", "push", "PR"],
            },
            release: {
              description: "Release process",
              steps: ["tag", "build", "publish"],
            },
          },
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: "Pull request workflow",
          steps: expect.arrayContaining([
            "fork",
            "branch",
            "commit",
            "push",
            "PR",
          ]),
        }),
        expect.objectContaining({
          description: "Release process",
          steps: expect.arrayContaining(["tag", "build", "publish"]),
        }),
      ]),
    );
  });

  test("filters corrupted workflows from object input", async () => {
    const userId = "user-corrupt-obj-workflows";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: [],
          workflows: {
            bad: {
              description: "789",
              steps: [],
            },
            good: {
              description: "Valid workflow",
              steps: ["step1", "step2"],
            },
          },
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: "Valid workflow",
        }),
      ]),
    );
    expect(profile!.profileData.workflows).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: "789",
        }),
      ]),
    );
  });
});

// -- Merge functions (lines 402, 418) ------------------------------------------

describe("merge functions - update existing items", () => {
  test("mergePreferences updates existing preference by category", async () => {
    const userId = "user-merge-prefs";
    getOrCreateProfile(userId);

    // First analysis
    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [
            { category: "language", description: "Python", confidence: 0.7 },
          ],
          patterns: [],
          workflows: [],
        },
      }),
    });

    let prompts = Array.from({ length: 10 }, (_, i) => `batch1-${i}`);
    await analyzeAndUpdateProfile(userId, prompts);

    // Second analysis with updated preference
    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [
            { category: "language", description: "Rust", confidence: 0.9 },
          ],
          patterns: [],
          workflows: [],
        },
      }),
    });

    prompts = Array.from({ length: 10 }, (_, i) => `batch2-${i}`);
    await analyzeAndUpdateProfile(userId, prompts);

    const db = getDb();
    const profile = getProfile(db, userId);
    const langPrefs = profile!.profileData.preferences.filter(
      (p) => p.category === "language",
    );
    expect(langPrefs).toHaveLength(1);
    expect(langPrefs[0]).toEqual(
      expect.objectContaining({
        category: "language",
        description: "Rust",
        confidence: 0.9,
      }),
    );
  });

  test("mergePatterns updates existing pattern by category", async () => {
    const userId = "user-merge-patterns";
    getOrCreateProfile(userId);

    // First analysis
    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: [{ category: "testing", description: "manual" }],
          workflows: [],
        },
      }),
    });

    let prompts = Array.from({ length: 10 }, (_, i) => `batch1-${i}`);
    await analyzeAndUpdateProfile(userId, prompts);

    // Second analysis with updated pattern
    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: [{ category: "testing", description: "automated TDD" }],
          workflows: [],
        },
      }),
    });

    prompts = Array.from({ length: 10 }, (_, i) => `batch2-${i}`);
    await analyzeAndUpdateProfile(userId, prompts);

    const db = getDb();
    const profile = getProfile(db, userId);
    const testPatterns = profile!.profileData.patterns.filter(
      (p) => p.category === "testing",
    );
    expect(testPatterns).toHaveLength(1);
    expect(testPatterns[0]).toEqual(
      expect.objectContaining({
        category: "testing",
        description: "automated TDD",
      }),
    );
  });

  test("mergeWorkflows updates existing workflow by description", async () => {
    const userId = "user-merge-workflows";
    getOrCreateProfile(userId);

    // First analysis
    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: [],
          workflows: [
            {
              description: "deployment",
              steps: ["manual", "test"],
            },
          ],
        },
      }),
    });

    let prompts = Array.from({ length: 10 }, (_, i) => `batch1-${i}`);
    await analyzeAndUpdateProfile(userId, prompts);

    // Second analysis with updated workflow
    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: [],
          workflows: [
            {
              description: "deployment",
              steps: ["automated", "CI/CD", "test", "deploy"],
            },
          ],
        },
      }),
    });

    prompts = Array.from({ length: 10 }, (_, i) => `batch2-${i}`);
    await analyzeAndUpdateProfile(userId, prompts);

    const db = getDb();
    const profile = getProfile(db, userId);
    const deployWorkflows = profile!.profileData.workflows.filter(
      (w) => w.description === "deployment",
    );
    expect(deployWorkflows).toHaveLength(1);
    expect(deployWorkflows[0]).toEqual(
      expect.objectContaining({
        description: "deployment",
        steps: expect.arrayContaining(["automated", "CI/CD", "test", "deploy"]),
      }),
    );
  });
});

// -- Error handling in analyzeAndUpdateProfile (lines 196-198) ----------------

describe("analyzeAndUpdateProfile error handling", () => {
  test("rolls back transaction and throws on LLM call error", async () => {
    const userId = "user-error";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => {
        throw new Error("LLM service unavailable");
      },
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);

    let threwError = false;
    try {
      await analyzeAndUpdateProfile(userId, prompts);
    } catch (error) {
      threwError = true;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("LLM service unavailable");
    }

    expect(threwError).toBe(true);

    // Verify profile was not updated (transaction rolled back)
    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.preferences).toHaveLength(0);
    expect(profile!.profileData.patterns).toHaveLength(0);
    expect(profile!.profileData.workflows).toHaveLength(0);
  });

  test("preserves profile state on transaction error", async () => {
    const userId = "user-preserve";
    const profile = getOrCreateProfile(userId);

    // Set initial profile data
    const db = getDb();
    updateProfile(db, {
      ...profile,
      profileData: {
        preferences: [{ category: "lang", description: "Go", confidence: 0.8 }],
        patterns: [],
        workflows: [],
      },
    });

    // Simulate error during analysis
    _setProfileDepsForTesting({
      callLLMWithTool: async () => {
        throw new Error("Network timeout");
      },
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);

    try {
      await analyzeAndUpdateProfile(userId, prompts);
    } catch {
      // expected
    }

    // Verify original data is intact
    const preserved = getProfile(db, userId);
    expect(preserved!.profileData.preferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "lang",
          description: "Go",
          confidence: 0.8,
        }),
      ]),
    );
  });
});

// -- Edge cases: non-array, non-object inputs (lines 300-301, 341-342, 379-380) --

describe("toPreferenceArray with invalid input types", () => {
  test("returns empty array for null input", async () => {
    const userId = "user-null-prefs";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: null,
          patterns: [],
          workflows: [],
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.preferences).toHaveLength(0);
  });

  test("returns empty array for string input", async () => {
    const userId = "user-string-prefs";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: "invalid",
          patterns: [],
          workflows: [],
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.preferences).toHaveLength(0);
  });

  test("returns empty array for number input", async () => {
    const userId = "user-number-prefs";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: 42,
          patterns: [],
          workflows: [],
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.preferences).toHaveLength(0);
  });
});

describe("toPatternArray with invalid input types", () => {
  test("returns empty array for null input", async () => {
    const userId = "user-null-patterns";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: null,
          workflows: [],
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.patterns).toHaveLength(0);
  });

  test("returns empty array for string input", async () => {
    const userId = "user-string-patterns";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: "invalid",
          workflows: [],
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.patterns).toHaveLength(0);
  });
});

describe("toWorkflowArray with invalid input types", () => {
  test("returns empty array for null input", async () => {
    const userId = "user-null-workflows";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: [],
          workflows: null,
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.workflows).toHaveLength(0);
  });

  test("returns empty array for string input", async () => {
    const userId = "user-string-workflows";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [],
          patterns: [],
          workflows: "invalid",
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);
    const result = await analyzeAndUpdateProfile(userId, prompts);

    expect(result.updated).toBe(true);

    const db = getDb();
    const profile = getProfile(db, userId);
    expect(profile!.profileData.workflows).toHaveLength(0);
  });
});

// -- Catch block coverage (lines 196-198) ------------------------------------

describe("analyzeAndUpdateProfile catch block", () => {
  test("executes catch block when error occurs during transaction", async () => {
    const userId = "user-catch-block";
    getOrCreateProfile(userId);

    // Mock the database to throw an error during the transaction
    const db = getDb();
    const originalExec = db.exec.bind(db);
    let commitAttempted = false;

    db.exec = ((sql: string) => {
      if (sql === "COMMIT") {
        commitAttempted = true;
        throw new Error("Simulated database error during commit");
      }
      return originalExec(sql);
    }) as typeof db.exec;

    _setProfileDepsForTesting({
      callLLMWithTool: async () => ({
        success: true,
        data: {
          preferences: [
            { category: "lang", description: "Rust", confidence: 0.9 },
          ],
          patterns: [],
          workflows: [],
        },
      }),
    });

    const prompts = Array.from({ length: 10 }, (_, i) => `prompt ${i}`);

    let caughtError: Error | null = null;
    try {
      await analyzeAndUpdateProfile(userId, prompts);
    } catch (error) {
      caughtError = error as Error;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toBe("Simulated database error during commit");
    expect(commitAttempted).toBe(true);

    // Restore original exec
    db.exec = originalExec;

    // Verify profile was not updated (transaction rolled back)
    const profile = getProfile(db, userId);
    expect(profile!.profileData.preferences).toHaveLength(0);
  });
});
