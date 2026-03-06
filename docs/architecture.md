# Architecture

This document describes how `opencode-flashback` is structured today.

## System Layout

```text
┌─────────────────────────────────┐
│                                 │
│         OpenCode Runtime        │
│                                 │
└────────────────┬────────────────┘
                 │
                 │
                 │
                 │
                 ▼
┌─────────────────────────────────┐
│                                 │
│ flashback tool in src/plugin.ts │
│                                 │
└─────────────────────────────────┘
                 │
                 │
                 ├──────────────────────────────────────┐
                 │                                      │
                 ▼                                      ▼
┌─────────────────────────────────┐     ┌──────────────────────────────┐
│                                 │     │                              │
│  MemoryEngine in src/engine.ts  │     │  web/server.ts + web/app.ts  │
│                                 │     │                              │
└─────────────────────────────────┘     └──────────────────────────────┘
                 │
                 │
                 ├──────────────────────────────────────┬──────────────────────────────────┐
                 │                                      │                                  │
                 ▼                                      ▼                                  ▼
┌─────────────────────────────────┐     ┌──────────────────────────────┐     ┌───────────────────────────┐
│                                 │     │                              │     │                           │
│          Core services          │     │ search.ts Orama hybrid index │     │ db/database.ts bun:sqlite │
│                                 │     │                              │     │                           │
└─────────────────────────────────┘     └──────────────────────────────┘     └───────────────────────────┘
                 │
                 │
                 ├──────────────────────────────────────┬──────────────────────────────────┬──────────────────────────┐
                 │                                      │                                  │                          │
                 ▼                                      ▼                                  ▼                          ▼
┌─────────────────────────────────┐     ┌──────────────────────────────┐     ┌───────────────────────────┐     ┌────────────┐
│                                 │     │                              │     │                           │     │            │
│            memory.ts            │     │          capture.ts          │     │       consolidate.ts      │     │ profile.ts │
│                                 │     │                              │     │                           │     │            │
└─────────────────────────────────┘     └──────────────────────────────┘     └───────────────────────────┘     └────────────┘
```

Diagram generated with `beautiful-mermaid` using `bun -e`.

## Entry Points

- `src/index.ts`: package entry, exports plugin
- `src/plugin.ts`: registers single `flashback` tool, chat hooks, and event handling
- `src/engine.ts`: central orchestration layer used by tool handlers and background flows

## Main Subsystems

- `src/core/memory.ts`: add/search/recall/list/forget/export/star/suspend/rate/review
- `src/search.ts`: Orama hybrid retrieval (keyword + vector) and ranking
- `src/db/database.ts`: SQLite persistence, migrations, meta keys, revision tracking
- `src/core/capture.ts`: idle-triggered extraction and memory write pipeline
- `src/core/consolidate.ts`: duplicate candidate detection and merge flow
- `src/core/profile.ts`: user preference and workflow profile synthesis
- `src/core/ai/embed.ts`: embedding generation and cache/circuit-breaker behavior
- `src/core/ai/generate.ts` + `src/core/ai/providers.ts`: LLM provider abstraction
- `src/web/server.ts` + `src/web/app.ts`: local web API and UI

## Persistence Model

- SQLite via `bun:sqlite`
- WAL mode and migration-driven schema lifecycle in `src/db/database.ts`
- `memories` table for durable memory records + metadata + review fields
- `meta` table for process coordination (`db_revision`, embedding model/dimension, reembed guards)
- `user_profiles` and `user_prompts` for profile learning and capture provenance

## API Surface (Web)

Implemented in `src/web/server.ts`:

- `GET /api/csrf-token`
- `GET /api/diagnostics`
- `GET /api/memories`
- `POST /api/memories`
- `POST /api/memories/:id/star`
- `POST /api/memories/:id/unstar`
- `GET /api/memories/:id`
- `DELETE /api/memories/:id`
- `GET /api/search`
- `GET /api/profile`
- `POST /api/profile/items/:section/:index/star`
- `POST /api/profile/items/:section/:index/unstar`
- `DELETE /api/profile/items/:section/:index`

## Tool API Surface

Single tool: `flashback` (mode-based API), defined in `src/plugin.ts`.

Modes:

- `search`, `add`, `recall`, `list`, `forget`
- `profile`, `stats`, `context`, `help`
- `export`, `related`, `review`, `rate`
- `suspend`, `star`, `unstar`, `clear`, `consolidate`
