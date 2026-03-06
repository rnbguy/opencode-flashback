import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LLMCallOptions, LLMCallResult } from "../src/core/ai/generate";

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
} from "../src/core/profile";
import { storePrompt } from "../src/core/prompts";
import { closeDb, getDb } from "../src/db/database";

let tmpDir: string;

beforeEach(() => {
  closeDb();
  tmpDir = mkdtempSync(join(tmpdir(), "flashback-profile-error-"));
  getDb(join(tmpDir, "test.db"));
  _setProfileDepsForTesting({
    callLLMWithTool: ((...args: unknown[]) =>
      mockCallLLM(args[0] as LLMCallOptions)) as typeof mockCallLLM,
  });
  mockCallLLM.mockReset();
});

afterEach(() => {
  _resetProfileDepsForTesting();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("analyzeAndUpdateProfile error handling", () => {
  test("throws error when LLM call fails with api_error", async () => {
    const userId = "test-user-1";
    const prompts: string[] = [];
    const promptIds: string[] = [];

    for (let i = 0; i < 11; i++) {
      const promptId = storePrompt(
        "session-1",
        `msg-${i}`,
        `Test prompt ${i}`,
        "/tmp",
      );
      prompts.push(`Test prompt ${i}`);
      promptIds.push(promptId);
    }

    mockCallLLM.mockImplementation(async () => ({
      success: false,
      error: "API rate limit exceeded",
      code: "api_error",
    }));

    try {
      await analyzeAndUpdateProfile(userId, prompts, promptIds);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("api_error");
    }
  });

  test("throws error when LLM call fails with network_error", async () => {
    const userId = "test-user-2";
    const prompts: string[] = [];
    const promptIds: string[] = [];

    for (let i = 0; i < 11; i++) {
      const promptId = storePrompt(
        "session-2",
        `msg-${i}`,
        `Test prompt ${i}`,
        "/tmp",
      );
      prompts.push(`Test prompt ${i}`);
      promptIds.push(promptId);
    }

    mockCallLLM.mockImplementation(async () => ({
      success: false,
      error: "Connection timeout",
      code: "network_error",
    }));

    try {
      await analyzeAndUpdateProfile(userId, prompts, promptIds);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("network_error");
    }
  });

  test("throws error when LLM call fails with timeout", async () => {
    const userId = "test-user-3";
    const prompts: string[] = [];
    const promptIds: string[] = [];

    for (let i = 0; i < 11; i++) {
      const promptId = storePrompt(
        "session-3",
        `msg-${i}`,
        `Test prompt ${i}`,
        "/tmp",
      );
      prompts.push(`Test prompt ${i}`);
      promptIds.push(promptId);
    }

    mockCallLLM.mockImplementation(async () => ({
      success: false,
      error: "Request timed out after 30s",
      code: "timeout",
    }));

    try {
      await analyzeAndUpdateProfile(userId, prompts, promptIds);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("timeout");
    }
  });

  test("throws error when LLM call fails with parse_error", async () => {
    const userId = "test-user-4";
    const prompts: string[] = [];
    const promptIds: string[] = [];

    for (let i = 0; i < 11; i++) {
      const promptId = storePrompt(
        "session-4",
        `msg-${i}`,
        `Test prompt ${i}`,
        "/tmp",
      );
      prompts.push(`Test prompt ${i}`);
      promptIds.push(promptId);
    }

    mockCallLLM.mockImplementation(async () => ({
      success: false,
      error: "Failed to parse LLM response",
      code: "parse_error",
    }));

    try {
      await analyzeAndUpdateProfile(userId, prompts, promptIds);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("parse_error");
    }
  });

  test("throws error when LLM call fails with rate_limit", async () => {
    const userId = "test-user-5";
    const prompts: string[] = [];
    const promptIds: string[] = [];

    for (let i = 0; i < 11; i++) {
      const promptId = storePrompt(
        "session-5",
        `msg-${i}`,
        `Test prompt ${i}`,
        "/tmp",
      );
      prompts.push(`Test prompt ${i}`);
      promptIds.push(promptId);
    }

    mockCallLLM.mockImplementation(async () => ({
      success: false,
      error: "Rate limit exceeded",
      code: "rate_limit",
    }));

    try {
      await analyzeAndUpdateProfile(userId, prompts, promptIds);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("rate_limit");
    }
  });

  test("error message includes error description from LLM result", async () => {
    const userId = "test-user-6";
    const prompts: string[] = [];
    const promptIds: string[] = [];

    for (let i = 0; i < 11; i++) {
      const promptId = storePrompt(
        "session-6",
        `msg-${i}`,
        `Test prompt ${i}`,
        "/tmp",
      );
      prompts.push(`Test prompt ${i}`);
      promptIds.push(promptId);
    }

    const errorDescription = "Custom API error message";
    mockCallLLM.mockImplementation(async () => ({
      success: false,
      error: errorDescription,
      code: "api_error",
    }));

    try {
      await analyzeAndUpdateProfile(userId, prompts, promptIds);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain(errorDescription);
      expect((error as Error).message).toContain("api_error");
    }
  });

  test("does not throw when LLM call succeeds", async () => {
    const userId = "test-user-7";
    const prompts: string[] = [];
    const promptIds: string[] = [];

    for (let i = 0; i < 11; i++) {
      const promptId = storePrompt(
        "session-7",
        `msg-${i}`,
        `Test prompt ${i}`,
        "/tmp",
      );
      prompts.push(`Test prompt ${i}`);
      promptIds.push(promptId);
    }

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

    const result = await analyzeAndUpdateProfile(userId, prompts, promptIds);
    expect(result.updated).toBe(true);
  });

  test("throws error with descriptive message format", async () => {
    const userId = "test-user-8";
    const prompts: string[] = [];
    const promptIds: string[] = [];

    for (let i = 0; i < 11; i++) {
      const promptId = storePrompt(
        "session-8",
        `msg-${i}`,
        `Test prompt ${i}`,
        "/tmp",
      );
      prompts.push(`Test prompt ${i}`);
      promptIds.push(promptId);
    }

    mockCallLLM.mockImplementation(async () => ({
      success: false,
      error: "Service unavailable",
      code: "api_error",
    }));

    try {
      await analyzeAndUpdateProfile(userId, prompts, promptIds);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toMatch(/Profile analysis failed:/);
    }
  });

  test("throws error when prompts exceed threshold and LLM fails", async () => {
    const userId = "test-user-9";
    const prompts: string[] = [];
    const promptIds: string[] = [];

    for (let i = 0; i < 10; i++) {
      const promptId = storePrompt(
        "session-9",
        `msg-${i}`,
        `Test prompt ${i}`,
        "/tmp",
      );
      prompts.push(`Test prompt ${i}`);
      promptIds.push(promptId);
    }

    mockCallLLM.mockImplementation(async () => ({
      success: false,
      error: "API error",
      code: "api_error",
    }));

    try {
      await analyzeAndUpdateProfile(userId, prompts, promptIds);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("api_error");
    }
  });

  test("throws error with all error code types", async () => {
    const errorCodes: Array<
      "api_error" | "network_error" | "timeout" | "parse_error" | "rate_limit"
    > = ["api_error", "network_error", "timeout", "parse_error", "rate_limit"];

    for (const code of errorCodes) {
      const userId = `test-user-${code}`;
      const prompts: string[] = [];
      const promptIds: string[] = [];

      for (let i = 0; i < 11; i++) {
        const promptId = storePrompt(
          `session-${code}`,
          `msg-${i}`,
          `Test prompt ${i}`,
          "/tmp",
        );
        prompts.push(`Test prompt ${i}`);
        promptIds.push(promptId);
      }

      mockCallLLM.mockImplementation(async () => ({
        success: false,
        error: `Error with ${code}`,
        code,
      }));

      try {
        await analyzeAndUpdateProfile(userId, prompts, promptIds);
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as Error).message).toContain(code);
      }
    }
  });
});
