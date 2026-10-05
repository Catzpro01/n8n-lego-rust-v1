# Official n8n Reference Instance (`apps/n8n-reference`)

Official upstream n8n installation serving as the authoritative **Truth Oracle** for semantic diff validation.

## Role
- **Default Port**: `5680` (configurable via `N8N_REFERENCE_PORT` or `N8N_PORT`)
- **Purpose**: Authoritative reference baseline to compare DAG traversal order, item mutation, `pairedItem` linking, and node execution semantics against `n8n-rust` (5678) and `n8n-lego` (5677).
- **Data Isolation**: Persists data strictly into `data/reference/` (ignored from git).

## Running
```bash
npm --prefix apps/n8n-reference start
# Or with custom port:
N8N_REFERENCE_PORT=5680 npm --prefix apps/n8n-reference start
```
