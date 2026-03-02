import { describe, test, expect } from "bun:test";
import { resolveContainerTag, resolveUserTag } from "../core/tags";

// ── sha256hex16 determinism (tested via resolveContainerTag / resolveUserTag) ─

describe("resolveContainerTag", () => {
  test("returns a tag prefixed with mem_project_", () => {
    const result = resolveContainerTag(process.cwd());
    expect(result.tag).toMatch(/^mem_project_[a-f0-9]{16}$/);
  });

  test("returns consistent tag for same directory", () => {
    const a = resolveContainerTag(process.cwd());
    const b = resolveContainerTag(process.cwd());
    expect(a.tag).toBe(b.tag);
  });

  test("returns projectName from directory basename", () => {
    const result = resolveContainerTag(process.cwd());
    // projectName should be the last segment of the project root
    expect(result.projectName.length).toBeGreaterThan(0);
  });

  test("fills user metadata from git config", () => {
    const result = resolveContainerTag(process.cwd());
    // In a git-configured env, these should be non-empty strings
    // In CI without git config, they may be empty — test for string type
    expect(typeof result.userName).toBe("string");
    expect(typeof result.userEmail).toBe("string");
  });

  test("displayName is the project root path", () => {
    const result = resolveContainerTag(process.cwd());
    // displayName is set to projectRoot, which is an absolute path
    expect(result.displayName).toMatch(/^\//);
  });

  test("gitRepoUrl is a string", () => {
    const result = resolveContainerTag(process.cwd());
    expect(typeof result.gitRepoUrl).toBe("string");
  });

  test("projectPath is an absolute path", () => {
    const result = resolveContainerTag(process.cwd());
    expect(result.projectPath).toMatch(/^\//);
  });

  test("different directories produce different tags", () => {
    const a = resolveContainerTag("/tmp");
    const b = resolveContainerTag("/var");
    // These are almost certainly not in a git repo, so they'll get path-based identity
    expect(a.tag).not.toBe(b.tag);
  });
});

describe("resolveUserTag", () => {
  test("returns a tag prefixed with mem_user_", () => {
    const result = resolveUserTag();
    expect(result.tag).toMatch(/^mem_user_[a-f0-9]{16}$/);
  });

  test("returns consistent tag", () => {
    const a = resolveUserTag();
    const b = resolveUserTag();
    expect(a.tag).toBe(b.tag);
  });

  test("displayName is non-empty", () => {
    const result = resolveUserTag();
    // Should resolve to git name, git email, USER env, or "anonymous"
    expect(result.displayName.length).toBeGreaterThan(0);
  });

  test("projectPath and projectName are empty for user tag", () => {
    const result = resolveUserTag();
    expect(result.projectPath).toBe("");
    expect(result.projectName).toBe("");
    expect(result.gitRepoUrl).toBe("");
  });

  test("userName and userEmail are strings", () => {
    const result = resolveUserTag();
    expect(typeof result.userName).toBe("string");
    expect(typeof result.userEmail).toBe("string");
  });
});

// ── Hash determinism ─────────────────────────────────────────────────────────

describe("hash determinism", () => {
  test("same input always produces same hash prefix", () => {
    // Using /tmp as a non-git directory gives path-based identity
    const results = Array.from({ length: 5 }, () =>
      resolveContainerTag("/tmp"),
    );
    const tags = results.map((r) => r.tag);
    expect(new Set(tags).size).toBe(1);
  });
});
