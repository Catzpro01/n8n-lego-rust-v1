# LEGO V2 Roadmap

## Phase A — Foundation cleanup

- Freeze the current main branch as the compatibility baseline.
- Keep old repositories read-only.
- Introduce the LEGO facade crate.
- Correct documentation so it describes the actual architecture, not the intended one.
- Make apps/n8n-lego stop owning execution semantics.

## Phase B — Rust control plane

- Move workflow CRUD to Rust.
- Move execution REST API to Rust.
- Move webhook ingress to Rust.
- Move realtime to Rust and complete browser parity.
- Add storage abstraction with SQLite WAL and PostgreSQL implementation.

## Phase C — Runtime Kernel

Implement:

- ExecutionContext
- ExecutionFrame
- bounded scheduler
- cancellation/deadlines
- retries
- wait/resume
- execution journal
- branch/merge/loop semantics
- paired-item/linking semantics
- durable replay

## Phase D — Node ecosystem

Tier A:

- core control-flow nodes
- data transformation nodes
- HTTP/webhook nodes
- schedule/trigger nodes

Tier B:

- Integration IR
- generated API clients where practical
- pagination/rate-limit/retry policies

Tier C:

- Node.js compatibility worker
- polyglot code worker
- community package adapter

## Phase E — Agent Runtime

- AgentState
- ToolRegistry
- workflow-as-tool
- memory layers
- approval policies
- model/provider abstraction
- MCP tool boundary
- budget and iteration limits
- audit events
- streaming agent events

## Phase F — Oracle certification

Every migration feature must compare LEGO against the official n8n reference for:

- HTTP status/body envelope
- workflow persistence
- node execution order
- output items
- pairedItem
- errors
- retries
- wait/resume
- webhooks
- realtime events
- auth/permissions

## Definition of Done

LEGO V2 is ready when:

1. The official n8n Vue UI runs unchanged.
2. Common n8n workflows execute through Rust by default.
3. JavaScript/community nodes still work through compatibility workers.
4. A failed process can recover an in-flight durable execution.
5. Agent Mode can safely call workflows and tools.
6. Oracle conformance tests protect compatibility.
7. A beginner can start the stack without reading the internal crate graph.
