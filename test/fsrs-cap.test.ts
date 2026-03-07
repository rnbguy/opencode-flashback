import { describe, expect, test } from "bun:test";
import { MAX_STABILITY_DAYS, updateAfterRating } from "../src/core/fsrs.ts";

describe("FSRS stability cap", () => {
  test("stability caps at 365 days after good rating on high stability", () => {
    // Start with stability already at 500 (should not be possible after cap, but tests the boundary)
    const result = updateAfterRating(500, 5.0, 4, Date.now());
    expect(result.stability).toBeLessThanOrEqual(MAX_STABILITY_DAYS);
    expect(result.stability).toBe(MAX_STABILITY_DAYS);
  });

  test("stability grows normally when below cap", () => {
    const result = updateAfterRating(10, 5.0, 4, Date.now());
    expect(result.stability).toBeGreaterThan(10);
    expect(result.stability).toBeLessThanOrEqual(MAX_STABILITY_DAYS);
  });

  test("repeated good ratings cannot exceed cap", () => {
    let s = 1.0;
    let d = 5.0;
    for (let i = 0; i < 100; i++) {
      const result = updateAfterRating(s, d, 5, Date.now());
      s = result.stability;
      d = result.difficulty;
    }
    expect(s).toBeLessThanOrEqual(MAX_STABILITY_DAYS);
  });
});
