// -- Core entity types ------------------------------------------------------

export interface Memory {
  id: string;
  content: string;
  embedding: Float32Array;
  containerTag: string;
  tags: string[];
  type: string;
  isPinned: boolean;
  createdAt: number; // Unix ms
  updatedAt: number;
  metadata: Record<string, string | number | boolean | null>;
  displayName: string;
  userName: string;
  userEmail: string;
  projectPath: string;
  projectName: string;
  gitRepoUrl: string;
  sourceFile?: string;
  sourceLine?: number;
  // Round-2 schema additions
  provenance: {
    sessionId: string;
    messageRange: [number, number];
    toolCallIds: string[];
  };
  lastAccessedAt: number; // Unix ms, updated on retrieval
  accessCount: number; // incremented on each retrieval
  epistemicStatus: {
    confidence: number; // 0.0-1.0
    evidenceCount: number;
  };
  evictedAt: number | null; // Unix ms tombstone, null = active
  // Round-4 additions (suspend/review)
  suspended: boolean;
  suspendedReason: string | null;
  suspendedAt: number | null;
  stability: number; // FSRS stability score for review scheduling
  nextReviewAt: number | null; // Unix ms, null = not scheduled
}

export interface SearchResult {
  memory: Memory;
  score: number;
  _debug?: Record<string, string | number | boolean | null>;
}

export interface UserProfile {
  id: string;
  userId: string;
  profileData: {
    preferences: Record<string, string | number | boolean | null>;
    patterns: Record<string, string | number | boolean | null>;
    workflows: Record<string, string | number | boolean | null>;
  };
  version: number;
  createdAt: number;
  lastAnalyzedAt: number;
  totalPromptsAnalyzed: number;
}

export interface UserProfileChangelog {
  id: string;
  profileId: string;
  version: number;
  changeSummary: string;
  profileDataSnapshot: UserProfile["profileData"];
}

export interface UserPrompt {
  id: string;
  sessionId: string;
  messageId: string;
  content: string;
  directory: string;
  isCaptured: boolean;
  isUserLearningCaptured: boolean;
  linkedMemoryId?: string;
}

export interface ContainerTagInfo {
  tag: string;
  displayName: string;
  userName: string;
  userEmail: string;
  projectPath: string;
  projectName: string;
  gitRepoUrl: string;
}

// -- Config types (derived from Zod schema in config.ts) ------------------

// NOTE: PluginConfig is z.infer<typeof ConfigSchema> -- defined in config.ts
// These nested shapes are helpers for type annotations inside config.ts
export interface LlmConfig {
  provider: LLMProvider;
  model: string;
  apiUrl: string;
  apiKey: string;
}

export interface StorageConfig {
  path: string;
}

export interface MemoryConfig {
  maxResults: number;
  autoCapture: boolean;
  injection: "first" | "every";
  excludeCurrentSession: boolean;
}

export interface WebConfig {
  port: number;
  enabled: boolean;
}

export interface SearchConfig {
  retrievalQuality: RetrievalQuality;
  hybridWeights?: { semantic: number; keyword: number };
  rankingWeights?: { recency: number; importance: number; semantic: number };
}

// -- Enum-like union types -------------------------------------------------

export type RetrievalQuality = "fast" | "balanced" | "thorough" | "custom";
export type MemoryTier = "pinned" | "semantic" | "ephemeral";
export type SubsystemState =
  | "uninitialized"
  | "initializing"
  | "ready"
  | "error"
  | "degraded";
export type LLMProvider =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "gemini"
  | "generic";
export type ExportFormat = "json" | "markdown";

// -- API response types ----------------------------------------------------

export interface ErrorResponse {
  success: false;
  error: string;
  code: string;
}

export type ToolResult =
  | { mode: "add"; success: boolean; id: string; message: string }
  | { mode: "search"; results: SearchResult[]; count: number }
  | { mode: "recall"; results: SearchResult[]; count: number }
  | { mode: "forget"; success: boolean; id: string }
  | { mode: "list"; memories: Memory[]; total: number; offset: number }
  | { mode: "profile"; profile: UserProfile | null }
  | { mode: "stats"; stats: DiagnosticsResponse }
  | { mode: "context"; injected: number }
  | { mode: "help"; text: string }
  | { mode: "export"; data: string; format: ExportFormat; count: number }
  | { mode: "related"; results: SearchResult[]; count: number }
  | { mode: "review"; memories: Memory[]; count: number }
  | { mode: "suspend"; success: boolean; id: string }
  | {
      mode: "consolidate";
      candidates: ConsolidationCandidate[];
      merged: number;
      dryRun: boolean;
    };

export interface DiagnosticsResponse {
  memoryCount: number;
  dbSizeBytes: number;
  dbPath: string;
  embeddingModel: string;
  subsystems: Record<string, SubsystemState>;
  version: string;
}

// -- Round-4 new types (suspend / review / export / consolidation) ---------

export interface ReviewSchedule {
  memoryId: string;
  nextReviewAt: number;
  stability: number;
  lastAccessedAt: number;
}

export interface ConsolidationCandidate {
  memoryIds: string[];
  reason: "duplicate" | "contradiction" | "near-duplicate";
  similarity: number;
  suggestion: string; // LLM-generated merge suggestion
}

export interface SuspendedMemory {
  memoryId: string;
  reason: string | null;
  suspendedAt: number;
}
