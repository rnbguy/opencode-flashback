# Comparison: opencode-flashback vs opencode-mem vs opencode-lore

This comparison is based on repository docs and source patterns from:

- `tickernelz/opencode-mem`
- `BYK/opencode-lore`
- this repository (`opencode-flashback`)

## Quick Matrix

| Dimension | opencode-flashback | opencode-mem | opencode-lore |
| --- | --- | --- | --- |
| Primary model | Tool-driven persistent memory | Tool-driven persistent memory | Distillation-first context management |
| Tool call style in docs | `flashback({ mode: ... })` | `memory({ mode: ... })` | `recall` tool + hook-driven behavior |
| Storage | SQLite + Orama index state | SQLite + HNSW stack | SQLite FTS5 + distillation tables + knowledge |
| Retrieval | Hybrid keyword + vector | Vector-centric memory retrieval | Keyword/FTS recall + distilled context |
| UI | Built-in local web UI | Built-in local web UI | No primary web UI focus |
| Control model | Explicit modes (18) | Explicit modes (compact set) | Mostly automatic via transform/event hooks |

## Tool Invocation Style

The key doc fix in this repo: examples now show direct tool calls (`flashback({...})`) for agent-level usage.

- `opencode-mem` README examples also use direct calls (`memory({...})`)
- plugin internals still execute asynchronously under the hood (`execute: async (...)`)

In short:

- Agent prompt usage: direct tool call syntax
- Plugin implementation: async execute handlers

## Architecture Differences

### opencode-flashback

- Single rich `flashback` tool with mode-based operations
- Strong explicit memory management surface (`star`, `suspend`, `rate`, `review`, `consolidate`)
- Hybrid search and local web management UI

### opencode-mem

- Similar explicit tool-first model (`memory` tool)
- README positions it around persistent memory + vector database flow
- Direct-call usage style in docs aligns with flashback docs after this update

### opencode-lore

- Hook-heavy architecture that reshapes context automatically
- Three-tier memory concept (temporal, distillation, long-term knowledge)
- Focus is context survivability and compression behavior rather than explicit mode operations

## Tradeoffs

- If you want explicit, inspectable memory operations and UI controls, flashback/mem-style tools are strong fits.
- If you want background context shaping with minimal agent action, lore-style distillation is stronger.
- These approaches are complementary: explicit memory tools can coexist with distillation-based context management.

## Why this matters for flashback docs

- Users reading memory plugin docs should see the same invocation shape used by agents.
- The docs now avoid confusion between agent-facing calls and plugin-internal async implementation details.
