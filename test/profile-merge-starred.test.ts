import { describe, expect, it } from "bun:test";
import {
  mergePatterns,
  mergePreferences,
  mergeWorkflows,
} from "../src/core/profile.ts";
import type {
  ProfilePattern,
  ProfilePreference,
  ProfileWorkflow,
} from "../src/types.ts";

describe("profile merge functions: preserve isStarred", () => {
  it("mergePreferences preserves isStarred from existing item", () => {
    const existing: ProfilePreference[] = [
      {
        category: "language",
        description: "Prefers TypeScript",
        confidence: 0.8,
        isStarred: true,
      },
    ];

    const extracted: ProfilePreference[] = [
      {
        category: "language",
        description: "Uses TypeScript for type safety",
        confidence: 0.9,
      },
    ];

    const result = mergePreferences(existing, extracted);

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("language");
    expect(result[0].isStarred).toBe(true);
    expect(result[0].confidence).toBe(0.9);
  });

  it("mergePatterns preserves isStarred from existing item", () => {
    const existing: ProfilePattern[] = [
      {
        category: "testing",
        description: "Uses unit tests",
        isStarred: true,
      },
    ];

    const extracted: ProfilePattern[] = [
      {
        category: "testing",
        description: "Writes comprehensive unit tests",
      },
    ];

    const result = mergePatterns(existing, extracted);

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("testing");
    expect(result[0].isStarred).toBe(true);
    expect(result[0].description).toBe("Writes comprehensive unit tests");
  });

  it("mergeWorkflows preserves isStarred from existing item", () => {
    const existing: ProfileWorkflow[] = [
      {
        description: "Code review process",
        steps: ["Read PR", "Test locally", "Approve"],
        isStarred: true,
      },
    ];

    const extracted: ProfileWorkflow[] = [
      {
        description: "Code review process",
        steps: ["Read PR", "Test locally", "Check CI", "Approve"],
      },
    ];

    const result = mergeWorkflows(existing, extracted);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("Code review process");
    expect(result[0].isStarred).toBe(true);
    expect(result[0].steps).toEqual([
      "Read PR",
      "Test locally",
      "Check CI",
      "Approve",
    ]);
  });

  it("mergePreferences does not add isStarred if not in existing", () => {
    const existing: ProfilePreference[] = [
      {
        category: "language",
        description: "Prefers TypeScript",
        confidence: 0.8,
      },
    ];

    const extracted: ProfilePreference[] = [
      {
        category: "language",
        description: "Uses TypeScript for type safety",
        confidence: 0.9,
      },
    ];

    const result = mergePreferences(existing, extracted);

    expect(result).toHaveLength(1);
    expect(result[0].isStarred).toBeUndefined();
  });

  it("mergePatterns adds new items without isStarred", () => {
    const existing: ProfilePattern[] = [
      {
        category: "testing",
        description: "Uses unit tests",
        isStarred: true,
      },
    ];

    const extracted: ProfilePattern[] = [
      {
        category: "documentation",
        description: "Writes API docs",
      },
    ];

    const result = mergePatterns(existing, extracted);

    expect(result).toHaveLength(2);
    expect(result[0].isStarred).toBe(true);
    expect(result[1].isStarred).toBeUndefined();
  });
});
