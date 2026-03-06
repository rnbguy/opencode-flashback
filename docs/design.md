# Design

This document explains key design decisions and operational flows in `opencode-flashback`.

## Design Goals

- Local-first memory for OpenCode sessions
- Single tool surface (`flashback`) instead of many commands
- Config-driven behavior with safe defaults
- Fast retrieval by combining vector and keyword signals
- Traceable provenance and durable storage in SQLite

## Core Flows

### Add Memory Flow

```text
┌──────────────────────────┐
│                          │
│    flashback add mode    │
│                          │
└─────────────┬────────────┘
              │
              │
              │
              │
              ▼
┌──────────────────────────┐
│                          │
│  plugin handleToolCall   │
│                          │
└─────────────┬────────────┘
              │
              │
              │
              │
              ▼
┌──────────────────────────┐
│                          │
│     engine.addMemory     │
│                          │
└─────────────┬────────────┘
              │
              │
              │
              │
              ▼
┌──────────────────────────┐
│                          │
│  embed document vector   │
│                          │
└─────────────┬────────────┘
              │
              │
              │
              │
              ▼
┌──────────────────────────┐
│                          │
│     duplicate check      │
│                          │
└─────────────┬────────────┘
              │
              │
              │
              │
              ▼
┌──────────────────────────┐
│                          │
│ sqlite transaction write │
│                          │
└─────────────┬────────────┘
              │
              │
              │
              │
              ▼
┌──────────────────────────┐
│                          │
│  increment db_revision   │
│                          │
└─────────────┬────────────┘
              │
              │
              │
              │
              ▼
┌──────────────────────────┐
│                          │
│    mark search stale     │
│                          │
└──────────────────────────┘
```

### Search Flow

```text
┌─────────────────────────────────────┐
│                                     │
│        flashback search mode        │
│                                     │
└──────────────────┬──────────────────┘
                   │
                   │
                   │
                   │
                   ▼
┌─────────────────────────────────────┐
│                                     │
│        plugin handleToolCall        │
│                                     │
└──────────────────┬──────────────────┘
                   │
                   │
                   │
                   │
                   ▼
┌─────────────────────────────────────┐
│                                     │
│        engine.searchMemories        │
│                                     │
└──────────────────┬──────────────────┘
                   │
                   │
                   │
                   │
                   ▼
┌─────────────────────────────────────┐
│                                     │
│          embed query vector         │
│                                     │
└──────────────────┬──────────────────┘
                   │
                   │
                   │
                   │
                   ▼
┌─────────────────────────────────────┐
│                                     │
│        search.ts hybridSearch       │
│                                     │
└──────────────────┬──────────────────┘
                   │
                   │
                   │
                   │
                   ▼
┌─────────────────────────────────────┐
│                                     │
│        Orama BM25 plus vector       │
│                                     │
└──────────────────┬──────────────────┘
                   │
                   │
                   │
                   │
                   ▼
┌─────────────────────────────────────┐
│                                     │
│ ranking recency/importance/semantic │
│                                     │
└──────────────────┬──────────────────┘
                   │
                   │
                   │
                   │
                   ▼
┌─────────────────────────────────────┐
│                                     │
│               results               │
│                                     │
└─────────────────────────────────────┘
```

Both diagrams were generated with `beautiful-mermaid` using `bun -e`.

## Why a Single Tool with Modes

- Keeps the tool contract compact for agents
- Extends behavior without changing tool discovery semantics
- Avoids slash-command surface and lets mode enforce intent

## Data Isolation Strategy

- Container tags scope memory by project/container context
- Search/retrieval operations apply tag filtering
- Cross-process coherence uses `db_revision` invalidation

## Consistency and Concurrency

- SQLite transactional writes for dedupe + insert paths
- WAL mode for read/write concurrency
- Meta flags prevent duplicated re-embed work across processes

## Security Posture

- CSRF protection and token rotation in web layer
- Request body size checks
- Strict container tag derivation from directory context

## Operational Tradeoffs

- Hybrid search improves recall quality vs keyword-only systems
- Embedding path adds model/runtime dependency and startup cost
- Explicit memory tool calls give more control, but less automation than fully transparent systems
