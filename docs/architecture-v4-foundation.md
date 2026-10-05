# n8n Rust Engine v4 Architecture Specification
**Version**: `v4.0.0-alpha.1` (Foundation Phase / Smoke Test Validation)  
**Status**: Experimental Architecture Prototype  
**Auditor Target**: Internal & External Code Review (Staff Engineer / Principal Tier)

---

## 1. System Topology & 3-Environment Oracle Strategy

To achieve 100% behavioral parity with official n8n without guessing edge-case semantics, the project maintains three explicit service roles:

| Port | Service Name | Purpose |
|---|---|---|
| **5677** | `n8n-lego` | Custom lightweight UI frontend adapter running Vue 3 / editor bundle. |
| **5678** | `n8n-rust` | High-performance standalone Rust execution engine (Axum + Tokio + SQLite). |
| **5680** | `n8n-reference` | Official n8n Docker/Node instance acting as the authoritative truth Oracle. |

### Semantic Diff Testing
Rather than asserting HTTP status codes alone, test suites run the identical workflow JSON through `n8n-reference` (port 5680) and `n8n-rust` (port 5678), diffing:
- Node execution order
- Item count & mutation
- `pairedItem` linking metadata
- Branch routing (IF/Switch ports)
- Error states & retry counts

---

## 2. Execution Architecture

```
                      ┌─────────────────────────┐
                      │    n8n Vue Editor UI    │
                      └────────────┬────────────┘
                                   │ REST / WebSocket
                      ┌────────────▼────────────┐
                      │    Axum HTTP Router     │
                      └────────────┬────────────┘
                                   │
                      ┌────────────▼────────────┐
                      │    Workflow Executor    │
                      │   (Tokio DAG Engine)    │
                      └────────────┬────────────┘
                                   │
         ┌─────────────────────────┼─────────────────────────┐
         │                         │                         │
┌────────▼────────┐       ┌────────▼────────┐       ┌────────▼────────┐
│  Tier 1: Native │       │ Tier 2: Decl IR │       │ Tier 3: Compat  │
│   Rust Nodes    │       │ IntegrationSpec │       │  Worker Pool    │
│ (20 Core Nodes) │       │ (Reqwest Proxy) │       │  (Node.js SDK)  │
└─────────────────┘       └─────────────────┘       └─────────────────┘
```

### Tier 1 — Native Rust Core Nodes
Frequently used core nodes implemented directly in Rust for sub-millisecond execution:
- Flow control: `manualTrigger`, `webhook`, `respondToWebhook`, `scheduleTrigger`, `cron`, `wait`, `noOp`, `executeWorkflow`
- Data manipulation: `set`, `crypto`, `if`, `switch`, `merge`, `splitInBatches`
- Data sources: `sqlite`, `httpRequest`, `postgres`, `redis`

### Tier 2 — Declarative Integration IR (`IntegrationSpec`)
For REST-like external services (e.g. Telegram, Slack, Discord, Webhooks), parameters are compiled into an `IntegrationSpec` struct:
- Base URL, Path, HTTP Method
- Headers, Query parameters with URL encoding
- Body serialization
- Auth strategy: Bearer, Basic, ApiKey, QueryParam
- Asynchronous execution via pooled `reqwest::Client`.

### Tier 3 — Node.js Compatibility Worker (Planned)
For SDK-heavy, stateful OAuth, or proprietary third-party integrations, execution is delegated to an isolated Node.js sidecar worker preserving original n8n execution semantics.

---

## 3. Polyglot Code Node Execution

### Step 1 (Current: Piped In-Memory IPC)
- **Zero-Disk I/O**: Eliminates `/tmp` file read/write operations.
- Input data (including `pairedItem` tracking) is serialized directly to the process's standard input pipe (`stdin`).
- Output JSON is read asynchronously from standard output (`stdout`) with a strict 10-second timeout guard.
- **RuntimeRegistry Caching**: Binary paths for runtimes (`node`, `python3`, etc.) are resolved once at startup via `which` or `mise which` and cached in an in-memory `RwLock<HashMap>`, completely removing `mise exec` invocation latency from the hot path.

### Step 2 (Roadmap Target: Long-Lived Worker Pool)
- Transitioning from per-invocation process spawning to persistent, warm worker processes communicating via framed streams over length-prefixed protocol.

---

## 4. Node Execution Resiliency & Testing Modes

To support offline local testing when external database daemons (e.g., PostgreSQL, Redis) are not active on developer machines:
- A `simulated` fallback returns explicit mock execution items.
- In production, execution mode is strictly configured via `NODE_EXECUTION_MODE=real`.
