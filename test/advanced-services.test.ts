import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "../src/config.ts";
import {
  _resetConfigForTesting,
  _setConfigForTesting,
  ConfigSchema,
  getConfig,
} from "../src/config.ts";
import type { LLMCallResult } from "../src/core/ai/generate.ts";
import {
  _resetCaptureDepsForTesting,
  _setCaptureDepsForTesting,
  type CaptureRequest,
  enqueueCapture,
  getLastCaptureStatus,
  resetCapture,
} from "../src/core/capture.ts";
import {
  _resetProfileDepsForTesting,
  _setProfileDepsForTesting,
  analyzeAndUpdateProfile,
  decayConfidence,
  getOrCreateProfile,
} from "../src/core/profile.ts";
import {
  getLastUncapturedPrompt,
  markAnalyzed,
  markCaptured,
  storePrompt,
} from "../src/core/prompts.ts";
import { _resetTagCache, resolveContainerTag } from "../src/core/tags.ts";
import {
  _setDbForTesting,
  closeDb,
  getDb,
  getProfile,
} from "../src/db/database.ts";
import { stripPrivate } from "../src/util/privacy.ts";

function makeValidConfig(): PluginConfig {
  return {
    llm: {
      provider: "ollama",
      model: "glm-4.6:cloud",
      apiUrl: "http://127.0.0.1:11434",
      apiKey: "",
    },
    embedding: {
      provider: "ollama",
      model: "embeddinggemma:latest",
      apiUrl: "http://127.0.0.1:11434",
      apiKey: "",
    },
    storage: { path: "/tmp/flashback" },
    memory: {
      maxResults: 10,
      autoCapture: true,
      injection: "first",
      excludeCurrentSession: true,
    },
    web: { port: 4747, enabled: true },
    search: { retrievalQuality: "balanced" },
    toasts: {
      autoCapture: true,
      userProfile: true,
      errors: true,
    },
    compaction: {
      enabled: true,
      memoryLimit: 10,
    },
  };
}

function containsNoSecretFragments(text: string): boolean {
  return ![
    /sk-[A-Za-z0-9]{20,}/,
    /ghp_[A-Za-z0-9]{36}/,
    /AKIA[A-Z0-9]{16}/,
    /-----BEGIN [A-Z ]+ KEY-----[\s\S]+?-----END [A-Z ]+ KEY-----/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /[A-Za-z0-9+/]{40,}={0,2}/,
  ].some((pattern) => pattern.test(text));
}

describe("advanced config behavior", () => {
  let tempRoot = "";
  let xdgConfigBackup: string | undefined;
  let xdgDataBackup: string | undefined;

  function writeJsonc(content: string): void {
    const configDir = join(tempRoot, "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode-flashback.jsonc"), content);
  }

  beforeEach(() => {
    xdgConfigBackup = process.env.XDG_CONFIG_HOME;
    xdgDataBackup = process.env.XDG_DATA_HOME;
    tempRoot = mkdtempSync(join(tmpdir(), "flashback-advanced-config-"));
    process.env.XDG_CONFIG_HOME = tempRoot;
    process.env.XDG_DATA_HOME = join(tempRoot, "xdg-data");
    _resetConfigForTesting();
  });

  afterEach(() => {
    if (xdgConfigBackup === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = xdgConfigBackup;
    }
    if (xdgDataBackup === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = xdgDataBackup;
    }
    _resetConfigForTesting();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("handles nested-comment fuzz by falling back safely", () => {
    writeJsonc(`{
      /* outer /* inner */ */
      "llm": { "model": "nested-comment-model" }
    }`);

    const cfg = getConfig();
    expect(cfg.llm.model).toBe("glm-4.6:cloud");
    expect(ConfigSchema.safeParse(cfg).success).toBe(true);
  });

  test("preserves // and /* in strings while parsing JSONC", () => {
    writeJsonc(`{
      "llm": {
        "apiKey": "sk-//keep",
        "model": "value-with-/*-inside"
      }
    }`);

    const cfg = getConfig();
    expect(cfg.llm.apiKey).toBe("sk-//keep");
    expect(cfg.llm.model).toBe("value-with-/*-inside");
  });

  test("accepts trailing commas in JSONC", () => {
    writeJsonc(`{
      "memory": {
        "autoCapture": false,
      },
    }`);

    const cfg = getConfig();
    expect(cfg.memory.autoCapture).toBe(false);
  });

  test("strict schema rejects empty and unknown-key configs", () => {
    expect(ConfigSchema.safeParse({}).success).toBe(false);
    expect(
      ConfigSchema.safeParse({ ...makeValidConfig(), unknownRoot: true })
        .success,
    ).toBe(false);
  });

  test("deep-merge behavior is idempotent for same user config", () => {
    writeJsonc(`{
      "llm": { "apiKey": "partial" },
      "memory": { "injection": "every" },
      "web": { "enabled": false }
    }`);

    _resetConfigForTesting();
    const first = getConfig();
    _setConfigForTesting(first);
    const second = getConfig();

    _resetConfigForTesting();
    const third = getConfig();

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  test("defaults are always valid when config files are absent", () => {
    _resetConfigForTesting();
    const cfg = getConfig();
    expect(ConfigSchema.safeParse(cfg).success).toBe(true);
  });

  test("strict mode rejects unknown keys in every required nested section", () => {
    const base = makeValidConfig();
    expect(
      ConfigSchema.safeParse({
        ...base,
        llm: { ...base.llm, extraLlm: "x" },
      }).success,
    ).toBe(false);
    expect(
      ConfigSchema.safeParse({
        ...base,
        memory: { ...base.memory, extraMemory: true },
      }).success,
    ).toBe(false);
    expect(
      ConfigSchema.safeParse({
        ...base,
        web: { ...base.web, extraWeb: 1 },
      }).success,
    ).toBe(false);
    expect(
      ConfigSchema.safeParse({
        ...base,
        search: { ...base.search, extraSearch: "nope" },
      }).success,
    ).toBe(false);
  });

  test("path expansion still resolves home path under fuzzed partial config", () => {
    writeJsonc(`{
      "storage": { "path": "~" }
    }`);

    const cfg = getConfig();
    expect(cfg.storage.path).toBe(homedir());
  });
});

describe("advanced privacy stripping", () => {
  test("redacts overlapping and adjacent secret patterns", () => {
    const input =
      "sk-abcdefghijklmnopqrstuvwxyz1234567890" +
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890" +
      "AKIAIOSFODNN7EXAMPLE";
    const output = stripPrivate(input);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("keeps partial near-miss patterns that are too short", () => {
    const input = "this should stay: sk-abcde";
    expect(stripPrivate(input)).toBe(input);
  });

  test("redacts very long base64-like tokens", () => {
    const longToken = "A".repeat(500);
    const output = stripPrivate(`token=${longToken}`);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(longToken);
  });

  test("redacts secrets inside markdown code blocks and JSON strings", () => {
    const input = [
      "```ts",
      'const key = "sk-abcdefghijklmnopqrstuvwxyz1234567890";',
      "```",
      '{"token":"ghp_abcdefghijklmnopqrstuvwxyz1234567890"}',
    ].join("\n");
    const output = stripPrivate(input);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
  });

  test("handles mixed 5+ secret kinds in one payload", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBogIBAAJBALRiMLAH",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const input = [
      "sk-abcdefghijklmnopqrstuvwxyz1234567890",
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-123456789012-abcdefghij",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop",
      pem,
    ].join(" ");

    const output = stripPrivate(input);
    expect(output).toContain("[REDACTED]");
    expect(containsNoSecretFragments(output)).toBe(true);
  });

  test("idempotency: double-strip equals single-strip", () => {
    const input =
      "secret sk-abcdefghijklmnopqrstuvwxyz1234567890 and xoxs-1234567890-abcdefghij";
    const once = stripPrivate(input);
    const twice = stripPrivate(once);
    expect(twice).toBe(once);
  });

  test("non-secrets with AKIA-like text in normal words survive", () => {
    const input = "this word hasAKIAinside but is not a real key";
    expect(stripPrivate(input)).toBe(input);
  });

  test("each secret pattern type is independently redacted", () => {
    const cases = [
      "sk-abcdefghijklmnopqrstuvwxyz1234567890",
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALRiMLAH\n-----END RSA PRIVATE KEY-----",
      "xoxp-1234567890-abcdefghij",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop",
    ];

    for (const sample of cases) {
      const output = stripPrivate(sample);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(sample);
    }
  });
});

describe("advanced tags/prompts/profile behavior", () => {
  let dbDir = "";

  beforeEach(() => {
    closeDb();
    dbDir = mkdtempSync(join(tmpdir(), "flashback-advanced-db-"));
    const db = getDb(join(dbDir, "test.db"));
    _setDbForTesting(db);
    _resetTagCache();
    _setProfileDepsForTesting({
      callLLMWithTool: async (): Promise<LLMCallResult> => ({
        success: true,
        data: {
          preferences: { language: "Rust" },
          patterns: { commit_style: "conventional" },
          workflows: { review: "pr" },
        },
      }),
    });
  });

  afterEach(() => {
    _resetProfileDepsForTesting();
    closeDb();
    rmSync(dbDir, { recursive: true, force: true });
    _resetTagCache();
  });

  test("resolveContainerTag fuzz: weird paths still return stable non-empty tags", () => {
    const weirdPaths = [
      "/definitely/does/not/exist",
      "/",
      "~",
      "/tmp/path with spaces",
      `/tmp/${"a".repeat(1000)}`,
      "bad\u0000path",
    ];

    for (const p of weirdPaths) {
      const a = resolveContainerTag(p);
      const b = resolveContainerTag(p);
      expect(a.tag).toBe(b.tag);
      expect(a.tag.length).toBeGreaterThan(0);
      expect(/\s/.test(a.tag)).toBe(false);
    }
  });

  test("storePrompt/getLastUncapturedPrompt handles long, null, and sql-like content", () => {
    const sessionId = "advanced-session";
    const payloads = [
      "x".repeat(100_000),
      "'; DROP TABLE user_prompts; --",
      "null-byte-here-\u0000-and-after",
    ];

    for (const content of payloads) {
      const id = storePrompt(
        sessionId,
        `msg_${Math.random()}`,
        content,
        "/tmp",
      );
      expect(id.startsWith("prompt_")).toBe(true);

      const latest = getLastUncapturedPrompt(sessionId);
      expect(latest).not.toBeNull();
      expect(latest!.content).toBe(content);

      markCaptured(id, `mem-${id}`);
    }
  });

  test("storePrompt supports empty session id and high-volume inserts", () => {
    storePrompt("", "msg-empty", "empty session", "/tmp");
    const emptySessionPrompt = getLastUncapturedPrompt("");
    expect(emptySessionPrompt).not.toBeNull();
    expect(emptySessionPrompt!.content).toBe("empty session");

    const session = "burst-session";
    for (let i = 0; i < 1000; i++) {
      storePrompt(session, `msg-${i}`, `content-${i}`, "/tmp");
    }
    const row = getDb()
      .query("SELECT COUNT(*) as count FROM user_prompts WHERE session_id = ?")
      .get(session) as { count: number };
    expect(row.count).toBe(1000);
  });

  test("markCaptured and markAnalyzed update retrieval behavior", () => {
    const id = storePrompt("cap-ses", "msg-1", "capture me", "/tmp");
    const before = getLastUncapturedPrompt("cap-ses");
    expect(before).not.toBeNull();
    expect(before!.id).toBe(id);

    markCaptured(id, "mem-1");
    markAnalyzed(id);

    const after = getLastUncapturedPrompt("cap-ses");
    expect(after).toBeNull();
  });

  test("profile merge stays additive across updates", async () => {
    const userId = "advanced-profile-additive";
    getOrCreateProfile(userId);

    _setProfileDepsForTesting({
      callLLMWithTool: async (): Promise<LLMCallResult> => ({
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
    const r1 = await analyzeAndUpdateProfile(
      userId,
      Array.from({ length: 10 }, (_, i) => `batch-a-${i}`),
    );
    expect(r1.updated).toBe(true);

    _setProfileDepsForTesting({
      callLLMWithTool: async (): Promise<LLMCallResult> => ({
        success: true,
        data: {
          preferences: [
            { category: "editor", description: "helix", confidence: 0.8 },
          ],
          patterns: [{ category: "review_style", description: "strict" }],
          workflows: [],
        },
      }),
    });
    const r2 = await analyzeAndUpdateProfile(
      userId,
      Array.from({ length: 10 }, (_, i) => `batch-b-${i}`),
    );
    expect(r2.updated).toBe(true);

    const profile = getProfile(getDb(), userId)!;
    const langPref = profile.profileData.preferences.find(
      (p) => p.category === "language",
    );
    expect(langPref?.description).toBe("Rust");
    const editorPref = profile.profileData.preferences.find(
      (p) => p.category === "editor",
    );
    expect(editorPref?.description).toBe("helix");
    const reviewPat = profile.profileData.patterns.find(
      (p) => p.category === "review_style",
    );
    expect(reviewPat?.description).toBe("strict");
  });

  test("decayConfidence is monotonic for numeric values and preserves non-numeric", () => {
    const userId = "advanced-profile-decay";
    const created = getOrCreateProfile(userId);
    const db = getDb();
    db.query("UPDATE user_profiles SET profile_data = ? WHERE id = ?").run(
      JSON.stringify({
        preferences: [
          { category: "score", description: "high", confidence: 0.9 },
          { category: "language", description: "Rust", confidence: 0.7 },
        ],
        patterns: [{ category: "frequency", description: "often" }],
        workflows: [{ description: "deploy", steps: ["build", "test"] }],
      }),
      created.id,
    );

    const before = getProfile(db, userId)!;
    decayConfidence(userId, 0.5);
    const after = getProfile(db, userId)!;

    const beforeScore = before.profileData.preferences.find(
      (p) => p.category === "score",
    );
    const afterScore = after.profileData.preferences.find(
      (p) => p.category === "score",
    );
    expect(afterScore!.confidence).toBeLessThanOrEqual(beforeScore!.confidence);

    // patterns and workflows are unchanged by decay
    expect(after.profileData.patterns).toEqual(before.profileData.patterns);
    expect(after.profileData.workflows).toEqual(before.profileData.workflows);

    // description is preserved
    const afterLang = after.profileData.preferences.find(
      (p) => p.category === "language",
    );
    const beforeLang = before.profileData.preferences.find(
      (p) => p.category === "language",
    );
    expect(afterLang!.description).toBe(beforeLang!.description);
  });
});

describe("advanced capture pipeline behavior", () => {
  const mockAddMemory = mock(
    async (_opts: unknown) => ({ id: "mem-1", deduplicated: false }) as const,
  );
  const mockCallLLM = mock(
    async (_opts: unknown): Promise<LLMCallResult> => ({
      success: true,
      data: {
        summary: "## Request\nreq\n\n## Outcome\nout",
        type: "feature",
        tags: ["test"],
        importance: 5,
        confidence: 0.8,
        evidenceCount: 1,
      },
    }),
  );
  const mockGetLastUncapturedPrompt = mock(
    (_sid: string) =>
      ({
        id: "prompt-1",
        sessionId: "s1",
        messageId: "m1",
        content: "content",
        directory: "/tmp",
        isCaptured: false,
        isUserLearningCaptured: false,
      }) as const,
  );
  const mockMarkCaptured = mock((_pid: string, _mid: string) => {});
  const mockDetectLanguage = mock(async (_text: string) => ({
    mode: "nl" as const,
    codeRatio: 0,
    detectedLang: "fr",
  }));
  const mockGetLanguageName = mock((_code: string) => "French");

  function makeRequest(overrides?: Partial<CaptureRequest>): CaptureRequest {
    return {
      sessionId: "session-1",
      containerTag: "mem_project_test",
      messages: [{ role: "user", content: "implement auth" }],
      directory: "/tmp/project",
      ...overrides,
    };
  }

  async function flushPromises(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
    }
  }

  function resetCaptureMocks(): void {
    mockAddMemory.mockReset();
    mockCallLLM.mockReset();
    mockGetLastUncapturedPrompt.mockReset();
    mockMarkCaptured.mockReset();
    mockDetectLanguage.mockReset();
    mockGetLanguageName.mockReset();

    mockAddMemory.mockImplementation(async () => ({
      id: "mem-1",
      deduplicated: false,
    }));
    mockCallLLM.mockImplementation(async () => ({
      success: true,
      data: {
        summary: "## Request\nreq\n\n## Outcome\nout",
        type: "feature",
        tags: ["test"],
        importance: 5,
      },
    }));
    mockGetLastUncapturedPrompt.mockImplementation(
      () =>
        ({
          id: "prompt-1",
          sessionId: "s1",
          messageId: "m1",
          content: "content",
          directory: "/tmp",
          isCaptured: false,
          isUserLearningCaptured: false,
        }) as const,
    );
    mockMarkCaptured.mockImplementation(() => {});
    mockDetectLanguage.mockImplementation(async () => ({
      mode: "nl",
      codeRatio: 0,
      detectedLang: "fr",
    }));
    mockGetLanguageName.mockImplementation(() => "French");
  }

  beforeEach(() => {
    jest.useFakeTimers();
    resetCapture();
    resetCaptureMocks();
    _setCaptureDepsForTesting({
      addMemory: mockAddMemory,
      callLLMWithTool: mockCallLLM,
      getLastUncapturedPrompt: mockGetLastUncapturedPrompt,
      markCaptured: mockMarkCaptured,
      detectLanguage: mockDetectLanguage,
      getLanguageName: mockGetLanguageName,
    });
  });

  afterEach(async () => {
    try {
      jest.runAllTimers();
    } catch {
      // Ignore: fake timers may already be cleaned up.
    }
    await flushPromises();
    resetCapture();
    _resetCaptureDepsForTesting();
    jest.useRealTimers();
  });

  afterAll(() => {
    mock.restore();
  });

  test("debounce: same session enqueued twice runs once", async () => {
    enqueueCapture(makeRequest());
    enqueueCapture(makeRequest());

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  test("debounce: different sessions both run", async () => {
    enqueueCapture(makeRequest({ sessionId: "session-a" }));
    enqueueCapture(makeRequest({ sessionId: "session-b" }));

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });

  test("skip logic: no user message yields skipped status", async () => {
    enqueueCapture(
      makeRequest({ messages: [{ role: "assistant", content: "hi" }] }),
    );

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(getLastCaptureStatus()).toBe("skipped");
  });

  test("skip logic: llm skip response yields skipped status", async () => {
    mockCallLLM.mockImplementation(async () => ({
      success: true,
      data: { summary: "skip", type: "skip", tags: [], importance: 1 },
    }));
    enqueueCapture(makeRequest());

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(getLastCaptureStatus()).toBe("skipped");
  });

  test("language detection and language-name mapping are invoked", async () => {
    enqueueCapture(
      makeRequest({
        messages: [{ role: "user", content: "bonjour, corrige ceci" }],
      }),
    );

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(mockDetectLanguage).toHaveBeenCalledTimes(1);
    expect(mockDetectLanguage).toHaveBeenCalledWith("bonjour, corrige ceci");
    expect(mockGetLanguageName).toHaveBeenCalledTimes(1);
    expect(mockGetLanguageName).toHaveBeenCalledWith("fr");
  });
});
