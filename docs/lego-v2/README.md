# LEGO V2

LEGO V2 is the next architecture for n8n-lego-rust-v1.

The goal is not to replace the official n8n UI. The goal is to make the backend feel like a single, beginner-friendly product while keeping a Rust-first, high-performance runtime underneath.

## Product shape

~~~text
Official n8n Vue UI
        |
        v
LEGO Gateway / API Compatibility
        |
        +-------------------------------+
        |                               |
        v                               v
Rust Workflow Runtime              Rust Agent Runtime
        |                               |
        +---------------+---------------+
                        |
                        v
                 LEGO Runtime Kernel
                        |
        +---------------+----------------+
        |               |                |
        v               v                v
 Native Rust      Integration IR    Compatibility Workers
 nodes             (HTTP/API)       (Node.js / polyglot)
        |
        v
Execution Data Plane + Realtime + Durable Storage
~~~

## The beginner rule

A beginner should be able to understand the project from three concepts:

1. Workflow — deterministic automation.
2. Agent — adaptive automation with tools, memory and approval.
3. Node/Tool — a reusable capability.

Everything else is implementation detail.

## Design rules

- Keep the official n8n editor and wire contracts.
- Prefer Rust on the request/control/execution hot path.
- Keep runtime modules in-process; LEGO is an architectural boundary, not an IPC boundary.
- Use out-of-process workers only where isolation or compatibility requires it.
- Never return fake successful data for an unimplemented feature. Use explicit capability/unsupported errors.
- Make state durable before adding distributed scaling.
- Keep one easy local development path and one explicit production topology.
- Use the official n8n instance as the semantic oracle.
- Treat Agent Mode as an additional runtime mode, not as a replacement for deterministic workflows.
