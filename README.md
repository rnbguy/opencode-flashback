# opencode-flashback

Persistent AI memory plugin for OpenCode -- free, local, open-source.

![license](https://img.shields.io/badge/license-Apache--2.0-blue)
![bun](https://img.shields.io/badge/bun-%3E%3D1.2.0-black)

## Features

- Ollama-powered embedding (embeddinggemma) and LLM (glm-4.6:cloud)
- Hybrid BM25+vector search (Orama)
- Auto-capture from coding sessions
- User profile learning
- Dark/light web UI
- 19 tool modes via single `flashback` tool
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

## Tool API

Flashback exposes a single `flashback` tool with a `mode` parameter. The AI agent calls it directly -- there are no slash commands.

```typescript
flashback({ mode: "search", query: "how to deploy" });
flashback({ mode: "add", content: "The project uses Bun for testing" });
flashback({ mode: "recall" });
flashback({ mode: "profile" });
```

If you are writing plugin code (not agent prompts), the handler remains async internally via `execute: async (...) => ...` in `src/plugin.ts`.

### Available Modes

| Mode | Args | Description |
| --- | --- | --- |
| `search` | `query`, `limit?` | Search memories semantically |
| `add` | `content`, `tags?` | Store a new memory |
| `recall` | `limit?` | Auto-recall relevant memories |
| `list` | `limit?`, `offset?` | Browse stored memories (paginated) |
| `forget` | `id` | Delete a memory by ID |
| `profile` | | View learned user profile |
| `stats` | | Show memory system diagnostics |
| `context` | | Inject project-scoped context into conversation |
| `help` | | Show all available modes |
| `export` | `format?` | Export all memories (json or markdown) |
| `related` | `query`, `limit?` | Find related memories |
| `review` | `limit?` | Review stale memories |
| `rate` | `id`, `rating` | Rate a memory (1-5) to schedule next review |
| `suspend` | `id`, `reason?` | Temporarily disable a memory |
| `star` | `id` | Star a memory (protected from eviction) |
| `unstar` | `id` | Unstar a memory |
| `clear` | `duration?`, `confirmed` | Clear all data or memories older than duration |
| `consolidate` | `dryRun?`, `confirmed?` | Detect and merge duplicate memories |
| `webui` | `action?` | Start/stop/restart Web UI (`start`, `stop`, `restart`) |

## Web UI

Flashback includes a local web interface at `http://127.0.0.1:4747` (default port).

The Web UI does **not** auto-start at plugin boot.
Start and stop it explicitly via the tool:

```typescript
flashback({ mode: "webui", action: "start" });
flashback({ mode: "webui", action: "stop" });
flashback({ mode: "webui", action: "restart" });
```

Notes:
- `restart` requires the server to already be running
- if it is not running, restart is skipped with a warning

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

## Comparison

For a focused comparison with related plugins, see `docs/comparison.md`.

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

## Acknowledgments

Inspired by [opencode-mem](https://github.com/tickernelz/opencode-mem).

## Documentation

- Architecture: `docs/architecture.md`
- Design and tradeoffs: `docs/design.md`
- Comparison with opencode-mem and opencode-lore: `docs/comparison.md`
