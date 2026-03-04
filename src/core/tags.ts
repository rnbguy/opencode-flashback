import { basename, dirname, isAbsolute, normalize, resolve, sep } from "path";
import type { ContainerTagInfo } from "../types";

// -- Tag caching ----------------------------------------------------------

const tagCache = new Map<string, ContainerTagInfo>();
let userTagCached: ContainerTagInfo | null = null;

// -- SHA-256 hashing ----------------------------------------------------------

function sha256hex16(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex").slice(0, 16);
}

// -- Git command helpers ------------------------------------------------------

function gitCmd(args: string[], cwd?: string): string | null {
  try {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;

    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      stderr: "ignore",
      env,
    });
    if (result.exitCode !== 0) return null;
    const output = result.stdout.toString().trim();
    return output || null;
  } catch {
    // git command failed -- container tag unavailable in non-git directories
    return null;
  }
}

function getGitEmail(): string | null {
  return gitCmd(["config", "user.email"]);
}

function getGitName(): string | null {
  return gitCmd(["config", "user.name"]);
}

function getGitRepoUrl(directory: string): string | null {
  return gitCmd(["config", "--get", "remote.origin.url"], directory);
}

function getGitCommonDir(directory: string): string | null {
  const commonDir = gitCmd(["rev-parse", "--git-common-dir"], directory);
  if (!commonDir) return null;

  return isAbsolute(commonDir)
    ? normalize(commonDir)
    : normalize(resolve(directory, commonDir));
}

function getGitTopLevel(directory: string): string | null {
  return gitCmd(["rev-parse", "--show-toplevel"], directory);
}

// -- Project identity resolution ----------------------------------------------

function getProjectRoot(directory: string): string {
  const commonDir = getGitCommonDir(directory);
  if (commonDir && basename(commonDir) === ".git") {
    return dirname(commonDir);
  }

  const topLevel = getGitTopLevel(directory);
  if (topLevel) {
    return topLevel;
  }

  return directory;
}

function getProjectName(directory: string): string {
  const normalized = normalize(directory);
  const parts = normalized.split(sep).filter((p) => p);
  return parts[parts.length - 1] || directory;
}

function getProjectIdentity(directory: string): string {
  const commonDir = getGitCommonDir(directory);
  if (commonDir) {
    return `git-common:${commonDir}`;
  }

  const gitRepoUrl = getGitRepoUrl(directory);
  if (gitRepoUrl) {
    return `remote:${gitRepoUrl}`;
  }

  return `path:${normalize(directory)}`;
}

// -- User identity resolution -------------------------------------------------

function getUserIdentity(): string {
  // Try git email first (primary)
  const email = getGitEmail();
  if (email) return email;

  // Try git name (secondary)
  const name = getGitName();
  if (name) return name;

  // Try environment variables (tertiary)
  const envUser = process.env.USER || process.env.USERNAME;
  if (envUser) return envUser;

  // Final fallback
  return "anonymous";
}

// -- Public API ---------------------------------------------------------------

/**
 * Resolve container tag info for a project directory.
 * Returns project-scoped tag with both project and user metadata.
 */
export function resolveContainerTag(directory: string): ContainerTagInfo {
  const cached = tagCache.get(directory);
  if (cached) return cached;

  const projectRoot = getProjectRoot(directory);
  const projectName = getProjectName(projectRoot);
  const projectIdentity = getProjectIdentity(projectRoot);
  const gitRepoUrl = getGitRepoUrl(directory);

  // User metadata
  const userEmail = getGitEmail() || "";
  const userName = getGitName() || "";

  // Project tag
  const projectTag = `mem_project_${sha256hex16(projectIdentity)}`;

  const result = {
    tag: projectTag,
    userName,
    userEmail,
    projectPath: projectRoot,
    projectName,
    gitRepoUrl: gitRepoUrl || "",
  };

  tagCache.set(directory, result);
  return result;
}

/**
 * Resolve container tag info for the current user.
 * Returns user-scoped tag with user metadata only.
 */
export function resolveUserTag(): ContainerTagInfo {
  if (userTagCached) return userTagCached;

  const userIdentity = getUserIdentity();
  const userEmail = getGitEmail() || "";
  const userName = getGitName() || "";

  // User tag
  const userTag = `mem_user_${sha256hex16(userIdentity)}`;

  const result = {
    tag: userTag,
    userName,
    userEmail,
    projectPath: "",
    projectName: "",
    gitRepoUrl: "",
  };

  userTagCached = result;
  return result;
}

/** @internal -- test-only */
export function _resetTagCache(): void {
  tagCache.clear();
  userTagCached = null;
}
