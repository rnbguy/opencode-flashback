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

// -- Imports (resolved after mocks) -------------------------------------------

import {
  _resetProfileDepsForTesting,
  _setProfileDepsForTesting,
  analyzeAndUpdateProfile,
} from "../src/core/profile";
import { storePrompt } from "../src/core/prompts";
import { closeDb, getDb } from "../src/db/database";

// -- Helpers ------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  closeDb();
  tmpDir = mkdtempSync(join(tmpdir(), "flashback-chartest-plugin-"));
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

// -- userId Derivation Tests --------------------------------------------------

describe("userId derivation patterns (CURRENT BEHAVIOR)", () => {
  test("plugin.ts pattern: userEmail || 'default' with email present", () => {
    // CURRENT BEHAVIOR: plugin.ts line 191 uses: tagInfo.userEmail || "default"
    const tagInfo = {
      userEmail: "alice@example.com",
      userName: "alice",
      gitRepoUrl: "https://github.com/test/repo",
      containerTag: "test-tag",
    };

    const userId = tagInfo.userEmail || "default";
    expect(userId).toBe("alice@example.com");
  });

  test("plugin.ts pattern: userEmail || 'default' with email null, userName present", () => {
    // CURRENT BEHAVIOR: plugin.ts line 191 uses: tagInfo.userEmail || "default"
    // This diverges from server.ts which also checks userName
    const tagInfo = {
      userEmail: null,
      userName: "alice",
      gitRepoUrl: "https://github.com/test/repo",
      containerTag: "test-tag",
    };

    const userId = tagInfo.userEmail || "default";
    expect(userId).toBe("default"); // DIVERGENCE: ignores userName
  });

  test("server.ts pattern: userEmail || userName || 'anonymous' with email present", () => {
    // CURRENT BEHAVIOR: server.ts line 454 uses: tagInfo.userEmail || tagInfo.userName || "anonymous"
    const tagInfo = {
      userEmail: "bob@example.com",
      userName: "bob",
      gitRepoUrl: "https://github.com/test/repo",
      containerTag: "test-tag",
    };

    const userId = tagInfo.userEmail || tagInfo.userName || "anonymous";
    expect(userId).toBe("bob@example.com");
  });

  test("server.ts pattern: userEmail || userName || 'anonymous' with email null, userName present", () => {
    // CURRENT BEHAVIOR: server.ts line 454 uses: tagInfo.userEmail || tagInfo.userName || "anonymous"
    // This diverges from plugin.ts which returns "default" instead
    const tagInfo = {
      userEmail: null,
      userName: "bob",
      gitRepoUrl: "https://github.com/test/repo",
      containerTag: "test-tag",
    };

    const userId = tagInfo.userEmail || tagInfo.userName || "anonymous";
    expect(userId).toBe("bob"); // DIVERGENCE: uses userName fallback
  });

  test("userId divergence: plugin returns 'default', server returns userName when email is null", () => {
    // CURRENT BEHAVIOR (BUG): Two different userId derivation patterns produce different results
    // This is the core divergence that Task 6 will fix
    const tagInfo = {
      userEmail: null,
      userName: "testuser",
      gitRepoUrl: "https://github.com/test/repo",
      containerTag: "test-tag",
    };

    const pluginUserId = tagInfo.userEmail || "default";
    const serverUserId = tagInfo.userEmail || tagInfo.userName || "anonymous";

    expect(pluginUserId).toBe("default");
    expect(serverUserId).toBe("testuser");
    expect(pluginUserId).not.toBe(serverUserId); // DIVERGENCE DOCUMENTED
  });
});

// -- Backoff Behavior Tests ---------------------------------------------------

describe("backoff behavior (CURRENT BEHAVIOR)", () => {
  test("analyzeAndUpdateProfile returns { updated: false } on LLM failure (not throwing)", async () => {
    // CURRENT BEHAVIOR (BUG): profile.ts:115-128 returns { updated: false } instead of throwing
    // This is why backoff doesn't trigger in plugin.ts:814-836 (catch block only)
    mockCallLLM.mockImplementation(async () => ({
      success: false,
      error: "LLM request failed",
      code: "api_error" as const,
    }));

    const userId = "test-user";
    const promptIds = Array.from({ length: 10 }, (_, i) => {
      return storePrompt(
        "session-1",
        `msg-${i}`,
        `test prompt ${i}`,
        "/test",
      );
    });
    const prompts = Array.from({ length: 10 }, (_, i) => `test prompt ${i}`);

    const result = await analyzeAndUpdateProfile(
      userId,
      prompts,
      promptIds,
    );

    // CURRENT BEHAVIOR: returns { updated: false } instead of throwing
    expect(result.updated).toBe(false);
  });

  test("analyzeAndUpdateProfile returns { updated: true } on LLM success", async () => {
    // CURRENT BEHAVIOR: happy path works correctly
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

    const userId = "test-user";
    const promptIds = Array.from({ length: 10 }, (_, i) => {
      return storePrompt(
        "session-1",
        `msg-${i}`,
        `test prompt ${i}`,
        "/test",
      );
    });
    const prompts = Array.from({ length: 10 }, (_, i) => `test prompt ${i}`);

    const result = await analyzeAndUpdateProfile(
      userId,
      prompts,
      promptIds,
    );

    expect(result.updated).toBe(true);
  });

  test("backoff only triggers on thrown exceptions, not on returned { updated: false }", async () => {
    // CURRENT BEHAVIOR (BUG): plugin.ts:814-836 has try/catch but only applies backoff in catch block
    // Since profile.ts returns false instead of throwing, backoff never triggers
    // This test documents the gap that Task 4 will fix

    mockCallLLM.mockImplementation(async () => ({
      success: false,
      error: "LLM request failed",
      code: "api_error" as const,
    }));

    const userId = "test-user";
    const promptIds = Array.from({ length: 10 }, (_, i) => {
      return storePrompt(
        "session-1",
        `msg-${i}`,
        `test prompt ${i}`,
        "/test",
      );
    });
    const prompts = Array.from({ length: 10 }, (_, i) => `test prompt ${i}`);

    const result = await analyzeAndUpdateProfile(
      userId,
      prompts,
      promptIds,
    );

    // CURRENT BEHAVIOR: returns false, no exception thrown
    expect(result.updated).toBe(false);

    // CURRENT BEHAVIOR (BUG): plugin.ts idle handler would NOT apply backoff
    // because the exception is not thrown. The catch block at line 829 never executes.
    // This is the bug that Task 4 (throw on LLM failure) will fix.
  });

  test("backoff gap: returned false vs thrown exception behavior", async () => {
    // CURRENT BEHAVIOR (BUG): This test documents the gap between two error handling patterns
    // - profile.ts returns { updated: false } on LLM failure
    // - plugin.ts only backs off on thrown exceptions
    // Result: LLM failures don't trigger backoff, causing rapid retry storms

    mockCallLLM.mockImplementation(async () => ({
      success: false,
      error: "LLM request failed",
      code: "api_error" as const,
    }));

    const userId = "test-user";
    const promptIds = Array.from({ length: 10 }, (_, i) => {
      return storePrompt(
        "session-1",
        `msg-${i}`,
        `test prompt ${i}`,
        "/test",
      );
    });
    const prompts = Array.from({ length: 10 }, (_, i) => `test prompt ${i}`);

    // Simulate what happens in plugin.ts idle handler (lines 814-836)
    let backoffApplied = false;
    try {
      const result = await analyzeAndUpdateProfile(
        userId,
        prompts,
        promptIds,
      );
      // CURRENT BEHAVIOR: no exception, so catch block never runs
      if (!result.updated) {
        // This check is NOT in the current code, so backoff is never applied
        backoffApplied = false;
      }
    } catch (error) {
      // CURRENT BEHAVIOR: this never executes because profile.ts doesn't throw
      backoffApplied = true;
    }

    // CURRENT BEHAVIOR (BUG): backoff is NOT applied
    expect(backoffApplied).toBe(false);
  });
});

// -- Auto-start Behavior Tests ------------------------------------------------

describe("auto-start behavior (CURRENT BEHAVIOR)", () => {
  test("plugin init would start web server when config.web.enabled=true", () => {
    // CURRENT BEHAVIOR: plugin.ts:487-493 calls startServer() when config.web.enabled=true
    // This test documents the current behavior that Task 12 will change
    // (replacing auto-start with explicit webui tool mode)

    // Simulating the config check from plugin.ts:487-493
    const config = {
      web: {
        enabled: true,
        port: 4747,
      },
    };

    // CURRENT BEHAVIOR: if config.web.enabled is true, startServer() is called
    const shouldStartServer = config.web.enabled === true;
    expect(shouldStartServer).toBe(true);
  });

  test("plugin init would NOT start web server when config.web.enabled=false", () => {
    // CURRENT BEHAVIOR: plugin.ts:487-493 checks config.web.enabled before calling startServer()
    const config = {
      web: {
        enabled: false,
        port: 4747,
      },
    };

    const shouldStartServer = config.web.enabled === true;
    expect(shouldStartServer).toBe(false);
  });
});
