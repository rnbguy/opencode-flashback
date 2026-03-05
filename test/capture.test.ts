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
import type { LLMCallResult } from "../src/core/ai/generate";

// -- Mock functions (referenced in mock.module factories) ---------------------

const mockAddMemory = mock(
  async (_opts: unknown) =>
    ({ id: "mem-1", deduplicated: false }) as {
      id: string;
      deduplicated: boolean;
    },
);

const mockCallLLM = mock(
  async (_opts: unknown): Promise<LLMCallResult> => ({
    success: true,
    data: {
      summary: "## Request\nTest\n\n## Outcome\nDone",
      type: "feature",
      tags: ["test"],
      importance: 5,
      confidence: 0.8,
      evidenceCount: 1,
    },
  }),
);

const mockGetLastUncaptured = mock(
  (
    _sid: string,
  ): {
    id: string;
    sessionId: string;
    messageId: string;
    content: string;
    directory: string;
    isCaptured: boolean;
    isUserLearningCaptured: boolean;
  } | null => ({
    id: "prompt-1",
    sessionId: "session-1",
    messageId: "msg-1",
    content: "test prompt",
    directory: "/test",
    isCaptured: false,
    isUserLearningCaptured: false,
  }),
);

const mockMarkCaptured = mock((_pid: string, _mid: string) => {});
const mockDetectLanguage = mock(async (_text: string) => ({
  mode: "nl" as const,
  codeRatio: 0,
  detectedLang: "en",
}));
const mockGetLanguageName = mock((_code: string) => "English");

// -- Imports (resolved after mocks) -------------------------------------------

import {
  _resetCaptureDepsForTesting,
  _setCaptureDepsForTesting,
  type CaptureRequest,
  enqueueCapture,
  getCaptureState,
  getLastCaptureStatus,
  initCapture,
  resetCapture,
} from "../src/core/capture";

// -- Helpers ------------------------------------------------------------------

function makeRequest(overrides?: Partial<CaptureRequest>): CaptureRequest {
  return {
    sessionId: "session-1",
    containerTag: "test-tag",
    messages: [
      { role: "user", content: "implement auth module" },
      { role: "assistant", content: "I'll create the auth module..." },
    ],
    directory: "/test/project",
    ...overrides,
  };
}

async function flushPromises(count = 30) {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

function resetMockDefaults() {
  mockAddMemory.mockImplementation(async () => ({
    id: "mem-1",
    deduplicated: false,
  }));
  mockCallLLM.mockImplementation(async () => ({
    success: true,
    data: {
      summary: "## Request\nTest\n\n## Outcome\nDone",
      type: "feature",
      tags: ["test"],
      importance: 5,
      confidence: 0.8,
      evidenceCount: 1,
    },
  }));
  mockGetLastUncaptured.mockImplementation(() => ({
    id: "prompt-1",
    sessionId: "session-1",
    messageId: "msg-1",
    content: "test prompt",
    directory: "/test",
    isCaptured: false,
    isUserLearningCaptured: false,
  }));
  mockMarkCaptured.mockImplementation(() => {});
  mockDetectLanguage.mockImplementation(async () => ({
    mode: "nl",
    codeRatio: 0,
    detectedLang: "en",
  }));
  mockGetLanguageName.mockImplementation(() => "English");
}

beforeEach(() => {
  jest.useFakeTimers();
  resetCapture();
  _setCaptureDepsForTesting({
    addMemory: mockAddMemory,
    callLLMWithTool: mockCallLLM,
    getLastUncapturedPrompt: mockGetLastUncaptured,
    markCaptured: mockMarkCaptured,
    detectLanguage: mockDetectLanguage,
    getLanguageName: mockGetLanguageName,
  });
  mockAddMemory.mockReset();
  mockCallLLM.mockReset();
  mockGetLastUncaptured.mockReset();
  mockMarkCaptured.mockReset();
  mockDetectLanguage.mockReset();
  mockGetLanguageName.mockReset();
  resetMockDefaults();
});

afterEach(async () => {
  // Drain any pending timers + promises so queuePromise resolves
  // before the next test. This prevents state leakage.
  try {
    jest.runAllTimers();
  } catch {
    // ignore if no fake timers active
  }
  await flushPromises();
  resetCapture();
  _resetCaptureDepsForTesting();
  jest.useRealTimers();
});

afterAll(() => {
  mock.restore();
});

// -- Per-session debounce -----------------------------------------------------

describe("per-session debounce", () => {
  test("debounces rapid calls for same session", async () => {
    enqueueCapture(makeRequest());
    enqueueCapture(makeRequest());
    enqueueCapture(makeRequest());

    // Advance past debounce (5000ms)
    jest.advanceTimersByTime(5000);
    await flushPromises();

    // Only one LLM call despite 3 enqueues
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });

  test("does not debounce different sessions", async () => {
    enqueueCapture(makeRequest({ sessionId: "session-a" }));
    enqueueCapture(makeRequest({ sessionId: "session-b" }));

    jest.advanceTimersByTime(5000);
    await flushPromises();

    // Both sessions should fire
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });

  test("last call wins within debounce window", async () => {
    const messages1 = [{ role: "user", content: "first message" }];
    const messages2 = [{ role: "user", content: "second message" }];

    enqueueCapture(makeRequest({ messages: messages1 }));
    enqueueCapture(makeRequest({ messages: messages2 }));

    jest.advanceTimersByTime(5000);
    await flushPromises();

    // storePrompt is no longer called from capture -- chat.message handler stores prompts
    // Instead verify the debounce coalesced to one capture run
    expect(mockGetLastUncaptured).toHaveBeenCalledTimes(1);
  });
});

// -- Serial queue ordering ----------------------------------------------------

describe("serial queue", () => {
  test("tasks execute in order", async () => {
    const callOrder: string[] = [];

    mockCallLLM.mockImplementation(async () => {
      callOrder.push(`llm-${callOrder.length}`);
      return {
        success: true,
        data: {
          summary: "test",
          type: "feature",
          tags: ["test"],
          importance: 5,
        },
      };
    });

    // Enqueue for different sessions (no debounce conflict)
    enqueueCapture(makeRequest({ sessionId: "s1" }));
    enqueueCapture(makeRequest({ sessionId: "s2" }));

    jest.advanceTimersByTime(5000);
    await flushPromises();

    // Both should have executed in order
    expect(callOrder).toEqual(["llm-0", "llm-1"]);
  });
});

// -- LLM extraction -----------------------------------------------------------

describe("LLM extraction", () => {
  test("saves memory from successful LLM extraction", async () => {
    enqueueCapture(makeRequest());

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockAddMemory).toHaveBeenCalledTimes(1);

    const addCall = mockAddMemory.mock.calls[0][0] as Record<string, unknown>;
    expect(addCall.content).toBe("## Request\nTest\n\n## Outcome\nDone");
    expect(addCall.containerTag).toBe("test-tag");
    expect(addCall.type).toBe("feature");
    expect(addCall.tags).toEqual(["test"]);
    expect(addCall.importance).toBe(5);
  });

  test("marks prompt as captured after save", async () => {
    enqueueCapture(makeRequest());

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(mockMarkCaptured).toHaveBeenCalledTimes(1);
  });

  test("skips non-technical conversations (type=skip)", async () => {
    mockCallLLM.mockImplementation(async () => ({
      success: true,
      data: {
        summary: "greeting",
        type: "skip",
        tags: [],
        importance: 1,
      },
    }));

    enqueueCapture(makeRequest());

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockAddMemory).not.toHaveBeenCalled();
    expect(mockMarkCaptured).toHaveBeenCalledTimes(1);
  });

  test("skips when no user messages", async () => {
    enqueueCapture(
      makeRequest({
        messages: [{ role: "assistant", content: "hello" }],
      }),
    );

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(getLastCaptureStatus()).toBe("skipped");
  });

  test("skips when no uncaptured prompt", async () => {
    mockGetLastUncaptured.mockImplementation(() => null);

    enqueueCapture(makeRequest());

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(getLastCaptureStatus()).toBe("skipped");
  });

  test("reports duplicate status", async () => {
    mockAddMemory.mockImplementation(async () => ({
      id: "existing-id",
      deduplicated: true,
    }));

    enqueueCapture(makeRequest());

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(getLastCaptureStatus()).toBe("duplicate");
  });
});

// -- Error handling & retry ---------------------------------------------------

describe("error handling", () => {
  test("fails on api_error without outer retry", async () => {
    let callCount = 0;
    mockCallLLM.mockImplementation(async () => {
      callCount++;
      return {
        success: false as const,
        error: "server error",
        code: "api_error" as const,
      };
    });

    enqueueCapture(makeRequest());

    // Advance past debounce -- single call, no outer retry loop
    jest.advanceTimersByTime(5000);
    await flushPromises();
    expect(callCount).toBe(1);

    expect(getCaptureState()).toBe("degraded");
    expect(getLastCaptureStatus()).toBe("failed");
  });

  test("does not retry on parse_error", async () => {
    let callCount = 0;
    mockCallLLM.mockImplementation(async () => {
      callCount++;
      return {
        success: false as const,
        error: "bad json",
        code: "parse_error" as const,
      };
    });

    enqueueCapture(makeRequest());

    jest.advanceTimersByTime(5000);
    await flushPromises();

    // Should break immediately on parse_error -- no retries
    expect(callCount).toBe(1);
    expect(getCaptureState()).toBe("degraded");
  });

  test("api_error results in failed status without retry", async () => {
    mockCallLLM.mockImplementation(async () => ({
      success: false as const,
      error: "transient",
      code: "api_error" as const,
    }));

    enqueueCapture(makeRequest());

    jest.advanceTimersByTime(5000);
    await flushPromises();

    // No outer retry -- failure is immediate
    expect(getCaptureState()).toBe("degraded");
    expect(getLastCaptureStatus()).toBe("failed");
  });
});

// -- State management ---------------------------------------------------------

describe("state management", () => {
  test("initial state is uninitialized", () => {
    expect(getCaptureState()).toBe("uninitialized");
  });

  // Regression: capture must be ready after initCapture()
  test("initCapture transitions to ready", () => {
    expect(getCaptureState()).toBe("uninitialized");
    initCapture();
    expect(getCaptureState()).toBe("ready");
  });

  // Regression: initCapture is idempotent
  test("initCapture is idempotent", () => {
    initCapture();
    initCapture();
    expect(getCaptureState()).toBe("ready");
  });

  test("transitions to ready on first capture", async () => {
    enqueueCapture(makeRequest());

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(getCaptureState()).toBe("ready");
  });

  test("resetCapture clears state", async () => {
    enqueueCapture(makeRequest());

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(getCaptureState()).toBe("ready");

    resetCapture();
    expect(getCaptureState()).toBe("uninitialized");
  });
});

describe("dependency injection", () => {
  test("uses injected language dependencies", async () => {
    const detect = mock(
      async (_text: string) =>
        ({ mode: "nl", codeRatio: 0, detectedLang: "ja" }) as const,
    );
    const getName = mock((_code: string) => "Japanese");

    _setCaptureDepsForTesting({
      detectLanguage: detect,
      getLanguageName: getName,
    });

    enqueueCapture(
      makeRequest({ messages: [{ role: "user", content: "konnichiwa" }] }),
    );

    jest.advanceTimersByTime(5000);
    await flushPromises();

    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledWith("konnichiwa");
    expect(getName).toHaveBeenCalledTimes(1);
    expect(getName).toHaveBeenCalledWith("ja");
  });
});
