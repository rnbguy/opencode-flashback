const DAY_MS = 86_400_000;
export const MAX_STABILITY_DAYS = 365;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

export function initialStabilityDays(confidence: number): number {
  return 0.25 + 1.75 * clamp(confidence, 0, 1);
}

export function initialSchedule(
  createdAt: number,
  confidence: number,
): {
  stability: number;
  difficulty: number;
  nextReviewAt: number;
} {
  const stability = initialStabilityDays(confidence);
  return {
    stability,
    difficulty: 5.0,
    nextReviewAt: createdAt + Math.round(stability * DAY_MS),
  };
}

export function updateAfterRating(
  currentStability: number,
  currentDifficulty: number,
  rating: 1 | 2 | 3 | 4 | 5,
  nowMs: number,
): {
  stability: number;
  difficulty: number;
  nextReviewAt: number;
} {
  let s = Math.max(0.0, currentStability);
  let d = clamp(currentDifficulty, 1, 10);

  if (s === 0.0) {
    s = 1.0;
  }

  if (rating <= 2) {
    const lapseFactor = rating === 1 ? 0.35 : 0.6;
    s = Math.max(0.1, s * lapseFactor);
    d = clamp(d + 0.8, 1, 10);
  } else {
    const diffFactor = (11 - d) / 10;
    const ratingBoost = 0.8 + 0.2 * (rating - 3);
    const growth = 1.0 + diffFactor * ratingBoost;
    s = Math.max(0.1, s * growth);
    d = clamp(d - 0.3 * (rating - 3), 1, 10);
  }
  s = Math.min(s, MAX_STABILITY_DAYS);

  const nextReviewAt = nowMs + Math.round(s * DAY_MS);
  return { stability: s, difficulty: d, nextReviewAt };
}
