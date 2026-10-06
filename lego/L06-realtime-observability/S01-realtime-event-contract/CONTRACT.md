# CONTRACT: L06.S01 — Realtime Event Contract

## 1. Sub-LEGO Identity
- **ID**: `L06.S01`
- **Name**: Realtime event contract
- **Owning LEGO**: `L06-realtime-observability`
- **Ownership Team**: `observability`
- **Execution Model**: `in-process`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `websocket-active-sockets`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`

---

## 2. Provided Ports

### `port.observability.realtime.publish.v1`
- **Category**: Event
- **Purpose**: Mempublikasikan event telemetry dan perubahan state eksekusi ke subscriber websocket yang aktif.
- **Request Shape**: `{ "tenant_id": string, "channel": string, "event_name": string, "payload": Value }`
- **Response Shape**: `{ "delivered_subscribers": usize }`
- **Error Taxonomy**: `PortErrorCode::BadRequest`, `PortErrorCode::InternalError`
- **Idempotency**: Idempotent

### `port.observability.realtime.subscribe.v1`
- **Category**: Stream
- **Purpose**: Mendaftarkan koneksi socket klien ke channel realtime dalam batas isolasi tenant.
- **Request Shape**: `{ "socket_id": string, "tenant_id": string, "channel": string }`
- **Response Shape**: `{ "subscribed": bool, "channel": string }`
- **Error Taxonomy**: `PortErrorCode::Unauthorized`, `PortErrorCode::Conflict`
- **Idempotency**: Idempotent

---

## 3. Required Ports
- `port.security.context.validate.v1` (Provider: `L02.S01`)

---

## 4. Invariants & Rules
1. Event realtime wajib menghormati isolasi tenant: klien dari tenant A tidak boleh menerima broadcast event tenant B.
2. Dilarang mempublikasikan plaintext rahasia / credentials di dalam payload event realtime.
3. Subscription harus mengelola lifecycle socket secara aman dan membersihkan state saat koneksi terputus.
