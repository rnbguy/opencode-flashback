import type { Config } from "@opencode-ai/sdk";

interface CommandSpec {
  description: string;
  template: string;
}

const COMMANDS: Record<string, CommandSpec> = {
  "flashback:search": {
    description: "Search memories semantically",
    template: "Search my memory for: $ARGUMENTS",
  },
  "flashback:add": {
    description: "Store a new memory",
    template: "Remember this: $ARGUMENTS",
  },
  "flashback:recall": {
    description: "Auto-recall memories relevant to current conversation",
    template: "Recall memories relevant to our current conversation",
  },
  "flashback:list": {
    description: "Browse stored memories (paginated)",
    template: "List my stored memories $ARGUMENTS",
  },
  "flashback:forget": {
    description: "Delete a memory by ID",
    template: "Forget this memory: $ARGUMENTS",
  },
  "flashback:profile": {
    description: "View learned user profile",
    template: "Show my user profile",
  },
  "flashback:stats": {
    description: "Show memory system diagnostics",
    template: "Show memory system stats and diagnostics",
  },
  "flashback:context": {
    description: "Inject project-scoped context into conversation",
    template: "Load project context from memory",
  },
  "flashback:help": {
    description: "Show all available memory commands",
    template: "Show help for all memory commands",
  },
  "flashback:export": {
    description: "Export all memories as JSON or markdown",
    template: "Export my memories $ARGUMENTS",
  },
  "flashback:related": {
    description: "Find semantically related memories for a topic",
    template: "Find memories related to: $ARGUMENTS",
  },
  "flashback:review": {
    description: "Review stale memories that may need updating",
    template: "Review stale memories $ARGUMENTS",
  },
  "flashback:suspend": {
    description: "Temporarily disable a memory without deleting it",
    template: "Suspend this memory: $ARGUMENTS",
  },
  "flashback:consolidate": {
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
