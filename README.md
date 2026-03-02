# opencode-flashback

Persistent AI memory plugin for OpenCode -- free, local, open-source.

![license](https://img.shields.io/badge/license-Apache--2.0-blue)
![bun](https://img.shields.io/badge/bun-%3E%3D1.2.0-black)

## Features

- EmbeddingGemma-300M via WASM (no GPU, no Docker, no Ollama)
- Hybrid BM25+vector search (Orama)
- Auto-capture from coding sessions
- User profile learning
- Dark/light web UI
- 14 commands with 1:1 tool/slash parity
- Cross-platform (Linux, macOS, Windows)
- Zero trustedDependencies

## Why Flashback?

- Privacy: Your memories never leave your machine
- Cost: Persistent memory without the $20/mo editor subscription
- OSS: Apache-2.0 licensed, forkable, no Elastic-license rug pulls
- Control: Selective recall you can tune, not a black box that always loads the same blob
- Simple: Install once, works offline, no extra services

## Quick Start

Add to your `opencode.json` config:

```jsonc
{
  "plugin": ["opencode-flashback"],
}
```

## Configuration

Flashback looks for configuration in `~/.config/opencode/opencode-flashback.jsonc` (JSONC primary, `.json` fallback). If both exist, `.jsonc` values take priority and a warning is shown.

### Secret Handling

For `llm.apiKey`, you can use:

- Direct value: `"sk-..."`
- Environment variable: `"env://OPENAI_API_KEY"`
- File path: `"file://~/.secrets/openai.txt"`

### Retrieval Presets

The `search.retrievalQuality` field supports four presets:

- `fast`: Prioritizes keyword search (30% semantic, 70% keyword)
- `balanced`: Equal weight (50% semantic, 50% keyword)
- `thorough`: Prioritizes semantic search (70% semantic, 30% keyword)
- `custom`: Uses weights defined in `search.hybridWeights`

### Full Schema

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/rnbguy/opencode-flashback/main/schema.json",
  "llm": {
    "provider": "openai-chat", // openai-chat, openai-responses, anthropic, gemini, generic
    "model": "gpt-4o-mini",
    "apiUrl": "https://api.openai.com/v1",
    "apiKey": "env://OPENAI_API_KEY",
  },
  "storage": {
    "path": "~/.local/share/opencode-flashback",
  },
  "memory": {
    "maxResults": 10,
    "autoCapture": true,
    "injection": "first", // first, every
    "excludeCurrentSession": true,
  },
  "web": {
    "port": 4747,
    "enabled": true,
  },
  "search": {
    "retrievalQuality": "balanced",
    "hybridWeights": {
      "semantic": 0.5,
      "keyword": 0.5,
    },
    "rankingWeights": {
      "recency": 0.3,
      "importance": 0.4,
      "semantic": 0.3,
    },
  },
}
```

## Commands

Flashback registers 14 commands programmatically. Use the colon-name syntax:

| Command | Description |
| --- | --- |
| `/memory:search <query>` | Search memories semantically |
| `/memory:add <content>` | Store a new memory |
| `/memory:recall` | Auto-recall relevant memories |
| `/memory:list` | Browse stored memories (paginated) |
| `/memory:forget <id>` | Delete a memory by ID |
| `/memory:profile` | View learned user profile |
| `/memory:stats` | Show memory system diagnostics |
| `/memory:context` | Inject project-scoped context into conversation |
| `/memory:help` | Show all available memory commands |
| `/memory:export [json\|markdown]` | Export all memories |
| `/memory:related <topic>` | Find related memories |
| `/memory:review` | Review stale memories |
| `/memory:suspend <id> [reason]` | Temporarily disable a memory |
| `/memory:consolidate [--dry-run]` | Detect and merge duplicate memories |

## Tool API

AI agents can use the `memory` tool directly:

```typescript
// Search
await context.callTool("memory", { mode: "search", query: "how to deploy" });

// Add
await context.callTool("memory", {
  mode: "add",
  content: "The project uses Bun for testing",
});

// Recall
await context.callTool("memory", { mode: "recall" });

// Profile
await context.callTool("memory", { mode: "profile" });
```

## Web UI

Flashback includes a local web interface at `http://127.0.0.1:4747` (default).

- Browse and search all stored memories
- Manage user profile and learned preferences
- Toggle between dark and light themes
- View system diagnostics and embedding status

## Auto-capture

Flashback automatically extracts memories from your coding sessions when the session becomes idle (`session.idle` event).

- Requires an LLM API key configured in `llm.apiKey`
- Uses "nothink" mode for efficient extraction
- Only captures technical decisions, architectural changes, and bug fixes
- Skips casual chat and non-technical conversations

## Competitive Positioning

Flashback is designed for developers who want persistent memory without cloud dependencies or expensive subscriptions.

| Feature         | Flashback | mem0     | Cursor | Claude    | AGENTS.md |
| --------------- | --------- | -------- | ------ | --------- | --------- |
| Cost            | Free      | Paid/OSS | $20/mo | Free/Paid | Free      |
| Local           | Yes       | Optional | No     | No        | Yes       |
| Setup           | Low       | High     | Zero   | Zero      | Manual    |
| Auto-capture    | Yes       | Yes      | Yes    | Yes       | No        |
| Semantic Search | Yes       | Yes      | Yes    | Yes       | No        |

### When NOT to use Flashback

- Cross-device sync: Flashback is local-only. Use a cloud service if you need sync.
- Team memory: Flashback is designed for individual developers. Use Zep or mem0 for teams.
- Not using OpenCode: Flashback is a dedicated OpenCode plugin.
- Zero setup: If you prefer a managed experience, use native Claude or Cursor memory.

### Scale Limits

Flashback is optimized for local performance:

- 50k memories: ~38ms search time
- RAM usage: ~73MB for vector index (Orama)
- Storage: SQLite with WAL for high-concurrency access

## Development

Prerequisites: Bun >= 1.2.0

```bash
bun install
bun run build
bun test
bun run typecheck
```

## License

Apache-2.0. See [LICENSE](LICENSE) for details.
