import { describe, expect, it } from "bun:test";
import {
  initialSchedule,
  initialStabilityDays,
  updateAfterRating,
} from "../src/core/fsrs";

const DAY_MS = 86_400_000;

describe("fsrs", () => {
  describe("initialStabilityDays", () => {
    it("returns 0.25 for confidence 0", () => {
      expect(initialStabilityDays(0)).toBe(0.25);
    });

    it("returns 1.125 for confidence 0.5", () => {
      expect(initialStabilityDays(0.5)).toBe(1.125);
    });

    it("returns 2.0 for confidence 1.0", () => {
      expect(initialStabilityDays(1.0)).toBe(2.0);
    });

    it("clamps negative confidence to 0", () => {
      expect(initialStabilityDays(-0.5)).toBe(0.25);
    });

    it("clamps confidence > 1 to 1", () => {
      expect(initialStabilityDays(1.5)).toBe(2.0);
    });

    it("clamps confidence > 1 to 1 (large value)", () => {
      expect(initialStabilityDays(100)).toBe(2.0);
    });

    it("handles very small positive confidence", () => {
      expect(initialStabilityDays(0.001)).toBeCloseTo(0.25175, 5);
    });

    it("handles confidence near 1", () => {
      expect(initialStabilityDays(0.999)).toBeCloseTo(1.99825, 4);
    });

    it("formula: 0.25 + 1.75 * clamp(confidence, 0, 1)", () => {
      const confidence = 0.3;
      const expected = 0.25 + 1.75 * confidence;
      expect(initialStabilityDays(confidence)).toBeCloseTo(expected, 10);
    });
  });

  describe("initialSchedule", () => {
    it("returns object with stability, difficulty, nextReviewAt", () => {
      const result = initialSchedule(1000, 0.5);
      expect(result).toHaveProperty("stability");
      expect(result).toHaveProperty("difficulty");
      expect(result).toHaveProperty("nextReviewAt");
    });

    it("sets difficulty to 5.0", () => {
      expect(initialSchedule(1000, 0.5).difficulty).toBe(5.0);
    });

    it("sets stability from initialStabilityDays", () => {
      const confidence = 0.5;
      const result = initialSchedule(1000, confidence);
      expect(result.stability).toBe(initialStabilityDays(confidence));
    });

    it("computes nextReviewAt as createdAt + stability * DAY_MS", () => {
      const createdAt = 1000;
      const confidence = 0.5;
      const result = initialSchedule(createdAt, confidence);
      const expectedNextReviewAt =
        createdAt + Math.round(initialStabilityDays(confidence) * DAY_MS);
      expect(result.nextReviewAt).toBe(expectedNextReviewAt);
    });

    it("handles createdAt = 0", () => {
      const result = initialSchedule(0, 0.5);
      expect(result.nextReviewAt).toBe(
        Math.round(initialStabilityDays(0.5) * DAY_MS),
      );
    });

    it("handles large createdAt timestamp", () => {
      const createdAt = 1704067200000; // 2024-01-01
      const confidence = 0.5;
      const result = initialSchedule(createdAt, confidence);
      const expectedNextReviewAt =
        createdAt + Math.round(initialStabilityDays(confidence) * DAY_MS);
      expect(result.nextReviewAt).toBe(expectedNextReviewAt);
    });

    it("handles confidence 0", () => {
      const result = initialSchedule(1000, 0);
      expect(result.stability).toBe(0.25);
      expect(result.difficulty).toBe(5.0);
      expect(result.nextReviewAt).toBe(1000 + Math.round(0.25 * DAY_MS));
    });

    it("handles confidence 1", () => {
      const result = initialSchedule(1000, 1);
      expect(result.stability).toBe(2.0);
      expect(result.difficulty).toBe(5.0);
      expect(result.nextReviewAt).toBe(1000 + Math.round(2.0 * DAY_MS));
    });

    it("nextReviewAt is always >= createdAt", () => {
      for (let confidence = 0; confidence <= 1; confidence += 0.1) {
        const result = initialSchedule(1000, confidence);
        expect(result.nextReviewAt).toBeGreaterThanOrEqual(1000);
      }
    });
  });

  describe("updateAfterRating", () => {
    describe("rating 1 (lapse, worst)", () => {
      it("applies lapse factor 0.35 to stability", () => {
        const result = updateAfterRating(2.0, 5.0, 1, 1000);
        expect(result.stability).toBe(Math.max(0.1, 2.0 * 0.35));
      });

      it("increases difficulty by 0.8 (clamped to 10)", () => {
        const result = updateAfterRating(2.0, 5.0, 1, 1000);
        expect(result.difficulty).toBe(5.8);
      });

      it("clamps difficulty to max 10", () => {
        const result = updateAfterRating(2.0, 9.5, 1, 1000);
        expect(result.difficulty).toBe(10);
      });

      it("clamps difficulty to min 1", () => {
        const result = updateAfterRating(2.0, 0.5, 1, 1000);
        expect(result.difficulty).toBe(1.8);
      });

      it("computes nextReviewAt from new stability", () => {
        const result = updateAfterRating(2.0, 5.0, 1, 1000);
        const expectedNextReviewAt =
          1000 + Math.round(result.stability * DAY_MS);
        expect(result.nextReviewAt).toBe(expectedNextReviewAt);
      });

      it("stability never goes below 0.1", () => {
        const result = updateAfterRating(0.01, 5.0, 1, 1000);
        expect(result.stability).toBe(0.1);
      });
    });

    describe("rating 2 (lapse, better)", () => {
      it("applies lapse factor 0.6 to stability", () => {
        const result = updateAfterRating(2.0, 5.0, 2, 1000);
        expect(result.stability).toBe(Math.max(0.1, 2.0 * 0.6));
      });

      it("increases difficulty by 0.8", () => {
        const result = updateAfterRating(2.0, 5.0, 2, 1000);
        expect(result.difficulty).toBe(5.8);
      });

      it("stability never goes below 0.1", () => {
        const result = updateAfterRating(0.01, 5.0, 2, 1000);
        expect(result.stability).toBe(0.1);
      });
    });

    describe("rating 3 (success, neutral)", () => {
      it("applies success formula with ratingBoost 0.8", () => {
        const currentStability = 2.0;
        const currentDifficulty = 5.0;
        const diffFactor = (11 - currentDifficulty) / 10;
        const ratingBoost = 0.8 + 0.2 * (3 - 3);
        const growth = 1.0 + diffFactor * ratingBoost;
        const expectedStability = Math.max(0.1, currentStability * growth);

        const result = updateAfterRating(
          currentStability,
          currentDifficulty,
          3,
          1000,
        );
        expect(result.stability).toBeCloseTo(expectedStability, 10);
      });

      it("decreases difficulty by 0", () => {
        const result = updateAfterRating(2.0, 5.0, 3, 1000);
        expect(result.difficulty).toBe(5.0);
      });
    });

    describe("rating 4 (success, good)", () => {
      it("applies success formula with ratingBoost 1.0", () => {
        const currentStability = 2.0;
        const currentDifficulty = 5.0;
        const diffFactor = (11 - currentDifficulty) / 10;
        const ratingBoost = 0.8 + 0.2 * (4 - 3);
        const growth = 1.0 + diffFactor * ratingBoost;
        const expectedStability = Math.max(0.1, currentStability * growth);

        const result = updateAfterRating(
          currentStability,
          currentDifficulty,
          4,
          1000,
        );
        expect(result.stability).toBeCloseTo(expectedStability, 10);
      });

      it("decreases difficulty by 0.3", () => {
        const result = updateAfterRating(2.0, 5.0, 4, 1000);
        expect(result.difficulty).toBe(4.7);
      });

      it("clamps difficulty to min 1", () => {
        const result = updateAfterRating(2.0, 1.2, 4, 1000);
        expect(result.difficulty).toBe(1);
      });
    });

    describe("rating 5 (success, excellent)", () => {
      it("applies success formula with ratingBoost 1.2", () => {
        const currentStability = 2.0;
        const currentDifficulty = 5.0;
        const diffFactor = (11 - currentDifficulty) / 10;
        const ratingBoost = 0.8 + 0.2 * (5 - 3);
        const growth = 1.0 + diffFactor * ratingBoost;
        const expectedStability = Math.max(0.1, currentStability * growth);

        const result = updateAfterRating(
          currentStability,
          currentDifficulty,
          5,
          1000,
        );
        expect(result.stability).toBeCloseTo(expectedStability, 10);
      });

      it("decreases difficulty by 0.6", () => {
        const result = updateAfterRating(2.0, 5.0, 5, 1000);
        expect(result.difficulty).toBe(4.4);
      });

      it("clamps difficulty to min 1", () => {
        const result = updateAfterRating(2.0, 1.5, 5, 1000);
        expect(result.difficulty).toBe(1);
      });
    });

    describe("edge cases", () => {
      it("handles currentStability = 0 (initializes to 1.0)", () => {
        const result = updateAfterRating(0, 5.0, 3, 1000);
        expect(result.stability).toBeGreaterThan(0);
      });

      it("handles negative currentStability (clamped to 0, then 1.0)", () => {
        const result = updateAfterRating(-1, 5.0, 3, 1000);
        expect(result.stability).toBeGreaterThan(0);
      });

      it("handles currentDifficulty < 1 (clamped to 1)", () => {
        const result = updateAfterRating(2.0, 0.5, 3, 1000);
        expect(result.difficulty).toBeGreaterThanOrEqual(1);
      });

      it("handles currentDifficulty > 10 (clamped to 10)", () => {
        const result = updateAfterRating(2.0, 15, 3, 1000);
        expect(result.difficulty).toBeLessThanOrEqual(10);
      });

      it("handles currentDifficulty = 1 (min boundary)", () => {
        const result = updateAfterRating(2.0, 1, 5, 1000);
        expect(result.difficulty).toBeGreaterThanOrEqual(1);
        expect(result.difficulty).toBeLessThanOrEqual(10);
      });

      it("handles currentDifficulty = 10 (max boundary)", () => {
        const result = updateAfterRating(2.0, 10, 5, 1000);
        expect(result.difficulty).toBeGreaterThanOrEqual(1);
        expect(result.difficulty).toBeLessThanOrEqual(10);
      });

      it("handles nowMs = 0", () => {
        const result = updateAfterRating(2.0, 5.0, 3, 0);
        expect(result.nextReviewAt).toBe(Math.round(result.stability * DAY_MS));
      });

      it("handles large nowMs timestamp", () => {
        const nowMs = 1704067200000; // 2024-01-01
        const result = updateAfterRating(2.0, 5.0, 3, nowMs);
        expect(result.nextReviewAt).toBe(
          nowMs + Math.round(result.stability * DAY_MS),
        );
      });

      it("stability is always >= 0.1", () => {
        for (let rating = 1; rating <= 5; rating++) {
          const result = updateAfterRating(
            0.01,
            5.0,
            rating as 1 | 2 | 3 | 4 | 5,
            1000,
          );
          expect(result.stability).toBeGreaterThanOrEqual(0.1);
        }
      });

      it("difficulty is always between 1 and 10", () => {
        for (let rating = 1; rating <= 5; rating++) {
          const result = updateAfterRating(
            2.0,
            5.0,
            rating as 1 | 2 | 3 | 4 | 5,
            1000,
          );
          expect(result.difficulty).toBeGreaterThanOrEqual(1);
          expect(result.difficulty).toBeLessThanOrEqual(10);
        }
      });

      it("nextReviewAt is always >= nowMs", () => {
        for (let rating = 1; rating <= 5; rating++) {
          const result = updateAfterRating(
            2.0,
            5.0,
            rating as 1 | 2 | 3 | 4 | 5,
            1000,
          );
          expect(result.nextReviewAt).toBeGreaterThanOrEqual(1000);
        }
      });
    });

    describe("success path (ratings 3-5) vs lapse path (ratings 1-2)", () => {
      it("success path increases stability more than lapse path", () => {
        const lapse = updateAfterRating(2.0, 5.0, 1, 1000);
        const success = updateAfterRating(2.0, 5.0, 5, 1000);
        expect(success.stability).toBeGreaterThan(lapse.stability);
      });

      it("lapse path increases difficulty, success path decreases it", () => {
        const lapse = updateAfterRating(2.0, 5.0, 1, 1000);
        const success = updateAfterRating(2.0, 5.0, 5, 1000);
        expect(lapse.difficulty).toBeGreaterThan(5.0);
        expect(success.difficulty).toBeLessThan(5.0);
      });

      it("rating 5 > rating 4 > rating 3 in stability growth", () => {
        const r3 = updateAfterRating(2.0, 5.0, 3, 1000);
        const r4 = updateAfterRating(2.0, 5.0, 4, 1000);
        const r5 = updateAfterRating(2.0, 5.0, 5, 1000);
        expect(r5.stability).toBeGreaterThan(r4.stability);
        expect(r4.stability).toBeGreaterThan(r3.stability);
      });

      it("rating 5 < rating 4 < rating 3 in difficulty", () => {
        const r3 = updateAfterRating(2.0, 5.0, 3, 1000);
        const r4 = updateAfterRating(2.0, 5.0, 4, 1000);
        const r5 = updateAfterRating(2.0, 5.0, 5, 1000);
        expect(r5.difficulty).toBeLessThan(r4.difficulty);
        expect(r4.difficulty).toBeLessThan(r3.difficulty);
      });
    });

    describe("difficulty impact on stability growth", () => {
      it("easier items (low difficulty) grow faster", () => {
        const easy = updateAfterRating(2.0, 2.0, 5, 1000);
        const hard = updateAfterRating(2.0, 8.0, 5, 1000);
        expect(easy.stability).toBeGreaterThan(hard.stability);
      });

      it("harder items (high difficulty) grow slower", () => {
        const easy = updateAfterRating(2.0, 1.0, 5, 1000);
        const hard = updateAfterRating(2.0, 10.0, 5, 1000);
        expect(easy.stability).toBeGreaterThan(hard.stability);
      });
    });
  });

  describe("integration: initialSchedule -> updateAfterRating", () => {
    it("can chain initialSchedule and updateAfterRating", () => {
      const initial = initialSchedule(1000, 0.5);
      const updated = updateAfterRating(
        initial.stability,
        initial.difficulty,
        5,
        initial.nextReviewAt,
      );

      expect(updated.stability).toBeGreaterThan(initial.stability);
      expect(updated.difficulty).toBeLessThan(initial.difficulty);
      expect(updated.nextReviewAt).toBeGreaterThan(initial.nextReviewAt);
    });

    it("multiple rating cycles maintain invariants", () => {
      let state = initialSchedule(1000, 0.5);

      for (let i = 0; i < 5; i++) {
        state = updateAfterRating(
          state.stability,
          state.difficulty,
          5,
          state.nextReviewAt,
        );

        expect(state.stability).toBeGreaterThan(0);
        expect(state.difficulty).toBeGreaterThanOrEqual(1);
        expect(state.difficulty).toBeLessThanOrEqual(10);
        expect(state.nextReviewAt).toBeGreaterThan(0);
      }
    });

    it("recovery from lapse (rating 1) then success (rating 5)", () => {
      let state = initialSchedule(1000, 0.5);
      const initialStability = state.stability;

      // Lapse
      state = updateAfterRating(
        state.stability,
        state.difficulty,
        1,
        state.nextReviewAt,
      );
      const afterLapse = state.stability;
      expect(afterLapse).toBeLessThan(initialStability);

      // Recovery
      state = updateAfterRating(
        state.stability,
        state.difficulty,
        5,
        state.nextReviewAt,
      );
      const afterRecovery = state.stability;
      expect(afterRecovery).toBeGreaterThan(afterLapse);
    });
  });
});
