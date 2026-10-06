# CONTRACT: L03.S01 — Webhook Routing

## 1. Sub-LEGO Identity
- **ID**: `L03.S01`
- **Name**: Webhook routing
- **Owning LEGO**: `L03-ingress`
- **Ownership Team**: `ingress-gateway`
- **Execution Model**: `in-process`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `webhook-route-table`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`

---

## 2. Provided Ports

### `port.ingress.webhook.receive.v1`
- **Category**: Command
- **Purpose**: Menerima request HTTP webhook masuk, mencocokkan route path dan method, lalu mendispatch ke eksekusi workflow.
- **Request Shape**: `{ "tenant_id": string, "http_method": string, "path": string, "headers": Map, "body": Value }`
- **Response Shape**: `{ "accepted": bool, "workflow_id": string, "execution_id": Option<string> }`
- **Error Taxonomy**: `PortErrorCode::NotFound`, `PortErrorCode::Unauthorized`, `PortErrorCode::RateLimited`
- **Idempotency**: Non-idempotent

---

## 3. Required Ports
- `port.ingress.admission.filter.v1` (Provider: `L03.S03`)
- `port.ingress.dedup.check.v1` (Provider: `L03.S04`)
- `port.execution.run.workflow.v1` (Provider: `L01.S01`)

---

## 4. Invariants & Rules
1. Pencocokan webhook route wajib terisolasi per tenant (multi-tenant safe).
2. Route matching harus deterministik berdasarkan kombinasi (tenant, http_method, path).
3. Jalur webhook yang tidak terdaftar harus langsung ditolak dengan status NotFound (404) tanpa memicu alokasi beban pada Execution Host.
