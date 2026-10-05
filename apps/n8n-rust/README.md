# n8n Rust Backend Server (`apps/n8n-rust`)

Standalone high-performance workflow execution engine written in Rust using Axum and Tokio.

## Role
- **Default Port**: `5678` (configurable via `N8N_RUST_PORT` or `PORT`)
- **Engine Type**: Full Async Axum Web Server + DAG Execution Engine
- **Endpoints**:
  - `GET /health`: Health status probe
  - `POST /webhook/:id`: Webhook trigger ingress
  - `GET /rest/workflows`: Workflow management API (n8n compatible)
  - `GET /rest/executions`: Execution history & state API
  - `WS /ws`: Real-time WebSocket event streaming

## Running
```bash
cargo run -p n8n-rust-app
# Or via environment variable:
N8N_RUST_PORT=5678 cargo run -p n8n-rust-app
```
