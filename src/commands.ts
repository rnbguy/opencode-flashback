import type { Config } from "@opencode-ai/sdk";

interface CommandSpec {
  description: string;
  template: string;
}

const COMMANDS: Record<string, CommandSpec> = {
  "memory:search": {
    description: "Search memories semantically",
    template: "Search my memory for: $ARGUMENTS",
  },
  "memory:add": {
    description: "Store a new memory",
    template: "Remember this: $ARGUMENTS",
  },
  "memory:recall": {
    description: "Auto-recall memories relevant to current conversation",
    template: "Recall memories relevant to our current conversation",
  },
  "memory:list": {
    description: "Browse stored memories (paginated)",
    template: "List my stored memories $ARGUMENTS",
  },
  "memory:forget": {
    description: "Delete a memory by ID",
    template: "Forget this memory: $ARGUMENTS",
  },
  "memory:profile": {
    description: "View learned user profile",
    template: "Show my user profile",
  },
  "memory:stats": {
    description: "Show memory system diagnostics",
    template: "Show memory system stats and diagnostics",
  },
  "memory:context": {
    description: "Inject project-scoped context into conversation",
    template: "Load project context from memory",
  },
  "memory:help": {
    description: "Show all available memory commands",
    template: "Show help for all memory commands",
  },
  "memory:export": {
    description: "Export all memories as JSON or markdown",
    template: "Export my memories $ARGUMENTS",
  },
  "memory:related": {
    description: "Find semantically related memories for a topic",
    template: "Find memories related to: $ARGUMENTS",
  },
  "memory:review": {
    description: "Review stale memories that may need updating",
    template: "Review stale memories $ARGUMENTS",
  },
  "memory:suspend": {
    description: "Temporarily disable a memory without deleting it",
    template: "Suspend this memory: $ARGUMENTS",
  },
  "memory:consolidate": {
    description: "Detect and merge duplicate or conflicting memories",
    template: "Consolidate duplicate or conflicting memories $ARGUMENTS",
  },
};

export function registerCommands(cfg: Config): void {
  cfg.command ??= {};
  for (const [key, spec] of Object.entries(COMMANDS)) {
    cfg.command[key] = spec;
  }
}
