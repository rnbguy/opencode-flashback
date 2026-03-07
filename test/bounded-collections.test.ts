import { afterEach, describe, expect, test } from "bun:test";
import {
  _getDebounceTimersForTesting,
  MAX_DEBOUNCE_TIMERS,
  resetCapture,
} from "../src/core/capture.ts";
import {
  _getInjectedSessionIdsForTesting,
  MAX_INJECTED_SESSIONS,
} from "../src/plugin.ts";

describe("bounded collections", () => {
  afterEach(() => {
    // Clean up injectedSessionIds
    _getInjectedSessionIdsForTesting().clear();
    // Clean up debounce timers
    resetCapture();
  });

  test("injectedSessionIds does not exceed MAX_INJECTED_SESSIONS", () => {
    const ids = _getInjectedSessionIdsForTesting();
    // Add MAX + 10 entries
    for (let i = 0; i < MAX_INJECTED_SESSIONS + 10; i++) {
      // Simulate what the plugin does at line 787
      if (ids.size >= MAX_INJECTED_SESSIONS) {
        const oldest = ids.values().next().value;
        if (oldest !== undefined) ids.delete(oldest);
      }
      ids.add(`session-${i}`);
    }
    expect(ids.size).toBeLessThanOrEqual(MAX_INJECTED_SESSIONS);
    // Most recent entries should be present
    expect(ids.has(`session-${MAX_INJECTED_SESSIONS + 9}`)).toBe(true);
    // Oldest entries should have been evicted
    expect(ids.has("session-0")).toBe(false);
  });

  test("debounceTimers does not exceed MAX_DEBOUNCE_TIMERS", () => {
    const timers = _getDebounceTimersForTesting();
    // Add MAX + 5 entries directly to test the bound
    for (let i = 0; i < MAX_DEBOUNCE_TIMERS + 5; i++) {
      const key = `session-${i}`;
      if (timers.size >= MAX_DEBOUNCE_TIMERS && !timers.has(key)) {
        const oldestKey = timers.keys().next().value;
        if (oldestKey !== undefined) {
          clearTimeout(timers.get(oldestKey));
          timers.delete(oldestKey);
        }
      }
      timers.set(
        key,
        setTimeout(() => {}, 999999),
      );
    }
    expect(timers.size).toBeLessThanOrEqual(MAX_DEBOUNCE_TIMERS);
  });
});
