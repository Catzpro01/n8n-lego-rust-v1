# n8n LEGO V2

Rust-first n8n-compatible automation runtime with the official n8n Vue UI kept as the frontend contract.

## Current architecture

- apps/n8n-lego — compatibility gateway and official editor adapter; migration target for Rust control-plane ownership.
- apps/n8n-rust — Rust execution/API application.
- apps/n8n-reference — upstream n8n oracle for semantic compatibility testing.
- crates/* — reusable Rust LEGO modules.
- crates/n8n-lego — the beginner-friendly public facade for the Rust runtime.
- compatibility/* — oracle and regression material.
- workers/* — compatibility and isolation boundary for Node.js/polyglot workloads.

## LEGO V2 direction

LEGO V2 reduces the mental model to three concepts:

1. Workflow — deterministic automation.
2. Agent — adaptive automation with tools, memory and policy.
3. Node/Tool — reusable capability.

Internally, the runtime is still modular and Rust-first:

~~~text
Official n8n Vue UI
        |
        v
LEGO Gateway / API Compatibility
        |
        +------------------------------+
        |                              |
        v                              v
Rust Workflow Runtime             Rust Agent Runtime
        |                              |
        +--------------+---------------+
                       |
                       v
                LEGO Runtime Kernel
                       |
          +------------+-------------+
          |            |             |
          v            v             v
      Native Rust   Integration IR  Compatibility Workers
                       |
                       v
             Durable Storage + Realtime
~~~

See:

- docs/lego-v2/README.md
- docs/lego-v2/ARCHITECTURE.md
- docs/lego-v2/REFERENCE_PLATFORMS.md
- docs/lego-v2/ROADMAP.md

## Beginner path

Start with the facade crate:

~~~rust
use n8n_lego::LegoRuntime;

let runtime = LegoRuntime::new();
println!("built-in nodes: {}", runtime.node_count());
~~~

Then learn the internal workflow/runtime crates only as needed.

## Important compatibility rule

The official n8n editor remains the UI source of truth. Rust migration must be certified against the official n8n reference instance; unsupported behaviour must be reported explicitly rather than masked with fabricated success responses.

## Development instances

The original project convention remains:

| Port | Service |
|---:|---|
| 5677 | LEGO editor/gateway |
| 5678 | Rust application |
| 5680 | Official n8n oracle |

Keep their data directories, credentials, processes and environment isolated.
