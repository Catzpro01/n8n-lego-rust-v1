# CONTRACT: L00.S03 — Policy and Resource Budgets

## 1. Sub-LEGO Identity
- **ID**: `L00.S03`
- **Name**: Policy and resource budgets
- **Owning LEGO**: `L00-foundation`
- **Ownership Team**: `runtime-core`
- **Execution Model**: `in-process`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `policy-budget-store`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`

---

## 2. Provided Ports

### `port.runtime.policy.check.v1`
- **Category**: Query / Security
- **Purpose**: Memeriksa otorisasi security context terhadap required scope untuk pemanggilan port.
- **Request Shape**: `{ "principal": string, "tenant": string, "required_scope": string }`
- **Response Shape**: `{ "allowed": bool, "reason": Option<string> }`
- **Error Taxonomy**: `PortErrorCode::Forbidden`, `PortErrorCode::Unauthorized`
- **Idempotency**: Idempotent

### `port.runtime.budget.allocate.v1`
- **Category**: Command / Resource
- **Purpose**: Mengalokasikan resource budget (memory bytes, execution timeout, cpu shares, stream bytes) dan menerbitkan lease.
- **Request Shape**: `{ "tenant": string, "requested_budget": ResourceBudget }`
- **Response Shape**: `{ "allocated_budget": ResourceBudget, "lease_id": string }`
- **Error Taxonomy**: `PortErrorCode::RateLimited`, `PortErrorCode::BadRequest`
- **Idempotency**: Non-idempotent (stateful lease reservation)

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)

---

## 4. Invariants & Rules
1. Policy checking harus default-deny: pemanggilan tanpa authority scope yang eksplisit wajib ditolak (`SecurityDenied`).
2. Alokasi budget tidak boleh melampaui hard limit runtime (maks 512 MB memory, maks 300.000 ms duration).
3. Setiap alokasi menerbitkan `lease_id` unik dan dapat dilepaskan kembali ke pool saat eksekusi selesai.
