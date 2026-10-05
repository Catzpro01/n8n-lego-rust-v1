# LEGO V2 Architecture

## 1. Control plane

The control plane owns:

- HTTP and n8n-compatible REST contracts
- authentication and authorization
- workflow CRUD
- credentials and secret boundaries
- webhook ingress
- execution lifecycle
- realtime session/push
- health/readiness
- audit and observability

The control plane should become Rust-first.

## 2. Runtime kernel

The kernel is the only hot-path orchestration layer.

Core concepts:

- ExecutionContext
- ExecutionFrame
- NodeExecutor
- ItemBuffer
- cancellation token
- deadline
- bounded concurrency
- execution journal
- retry policy
- wait/resume state

The kernel MUST NOT serialize JSON between internal Rust crates merely because the repository is split into LEGO modules.

## 3. Three execution tiers

### Tier A — Native Rust

Use for high-volume, deterministic, platform-critical nodes.

Examples:

- Set
- If
- Merge
- Split / Loop
- HTTP
- Webhook
- Schedule
- data transforms
- storage adapters

### Tier B — Integration IR

Declarative integrations compiled into a small internal representation:

- HTTP method
- URL template
- headers
- query
- body
- authentication reference
- pagination
- retry/backoff
- response extraction
- rate-limit policy

This should handle the large middle of API integrations without writing a custom Rust executor for every SaaS.

### Tier C — Compatibility workers

Use for:

- existing Node.js n8n nodes
- community packages
- SDK-heavy integrations
- arbitrary JavaScript/Python/Go/PHP code
- legacy behaviour that must match upstream

Workers are isolated processes. The kernel is not.

## 4. Workflow mode and Agent mode

### Workflow mode

Deterministic graph execution.

Guarantees should include:

- stable node ordering
- explicit branching
- retries
- cancellation
- wait/resume
- idempotency
- paired-item semantics
- execution replay

### Agent mode

Adaptive state machine using:

- planner/reasoner interface
- ToolRegistry
- memory
- policy engine
- approval gates
- budgets
- max iterations
- execution deadlines
- audit trail

A workflow is a first-class agent tool.

## 5. Data plane

The hot path should use typed Rust structures and reference-counted immutable state where possible.

Preferred data lifecycle:

workflow JSON -> validated model -> compiled runtime plan -> execution frames -> results

Do not repeatedly clone the complete workflow graph for every node.

## 6. Storage

Development:

- SQLite with WAL

Production:

- PostgreSQL

The storage contract must be backend-neutral. Execution state, workflow state, credentials metadata and agent memory must not be stored in unrelated ad-hoc JSON files.

## 7. Realtime

Rust owns the canonical realtime session/push layer.

Required behaviours:

- heartbeat
- reconnect
- authenticated sessions
- origin validation
- execution/node events
- bounded payloads
- session lifecycle

The existing JavaScript push server remains only until browser parity tests prove the Rust path is safe to cut over.

## 8. Beginner experience

The public repository should expose:

~~~text
lego/
├── docs/lego-v2/        # architecture and tutorials
├── crates/n8n-lego/     # simple Rust facade
├── crates/              # internal Lego modules
├── apps/                # runtime applications
└── compatibility/       # oracle tests
~~~

The facade is intentionally small. A beginner should not need to understand every internal crate to run a workflow.

## 9. Non-goals

- Rewriting the official Vue editor
- Copying n8n source implementation line-for-line
- Forcing every node to become native Rust
- Turning deterministic workflow execution into an LLM-controlled system
- Using a message broker for every local execution step
