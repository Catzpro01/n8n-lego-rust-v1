# Node Compatibility Worker (`workers/node-compat-worker`)

**Status**: Planned (Not Implemented Yet)

## Purpose
Sidecar Node.js worker pool dedicated to running complex community/third-party nodes, dynamic OAuth lifecycles, and proprietary SDKs that require full Node.js ecosystem compatibility.

## Roadmap
- Protocol: JSON-RPC over framed Unix socket / TCP
- Execution isolation from core Rust scheduler
