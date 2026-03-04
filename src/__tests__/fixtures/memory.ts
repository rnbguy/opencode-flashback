import type { Memory } from "../../types.ts";

export function makeTestMemory(
  id: string,
  containerTag: string,
  overrides?: Partial<Memory>,
): Memory {
  const now = Date.now();
  return {
    id,
    content: `content-${id}`,
    embedding: new Float32Array(768),
    containerTag,
    tags: [],
    type: "note",
    isPinned: false,
    createdAt: now,
    updatedAt: now,
    metadata: { importance: 5 },
    userName: "",
    userEmail: "",
    projectPath: "",
    projectName: "",
    gitRepoUrl: "",
    provenance: {
      sessionId: "",
      messageRange: [0, 0] as [number, number],
      toolCallIds: [],
    },
    lastAccessedAt: now,
    accessCount: 0,
    epistemicStatus: { confidence: 0.7, evidenceCount: 1 },
    evictedAt: null,
    suspended: false,
    suspendedReason: null,
    suspendedAt: null,
    stability: 0,
    difficulty: 5.0,
    nextReviewAt: null,
    ...overrides,
  };
}
