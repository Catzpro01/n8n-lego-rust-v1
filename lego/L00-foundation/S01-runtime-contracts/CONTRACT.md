# CONTRACT: L00.S01 — Runtime Contracts

## 1. Sub-LEGO Identity
- **ID**: `L00.S01`
- **Name**: Runtime Contracts
- **Owning LEGO**: `L00-foundation`
- **Ownership Team**: `runtime-core`
- **Execution Model**: `contract-only`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `stateless`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`

---

## 2. Provided Ports

### `port.runtime.contract.envelope.v1`
- **Category**: Command / Control
- **Purpose**: Menetapkan standar envelope eksekusi dan security context pada setiap pemanggilan port.
- **Request Shape**: `PortInvocation` (memuat caller_sublego, provider_sublego, security_context, payload).
- **Response Shape**: `PortResponse` (memuat status, telemetry, payload).
- **Error Taxonomy**: `PortErrorCode` (BadRequest, Unauthorized, Forbidden, NotFound, Timeout, Cancelled, VersionMismatch).
- **Idempotency**: Opsional via `idempotency_key`.

### `port.runtime.contract.negotiate.v1`
- **Category**: Lifecycle
- **Purpose**: Negosiasi versi semantik contract antara consumer dan provider.
- **Request Shape**: `{ "requested_version": "1.0.0" }`
- **Response Shape**: `{ "selected_version": "1.0.0", "status": "Compatible" }`

---

## 3. Required Ports
- *None (Foundation Layer)*

---

## 4. Invariants & Rules
1. Setiap panggilan yang melintasi trust boundary wajib menyertakan `SecurityContext`.
2. Provider tidak boleh membongkar rahasia (credentials) mentah di dalam payload JSON umum.
3. Payload di atas ambang batas budget wajib ditransformasi menjadi `DataHandle` atau `StreamPort`.
