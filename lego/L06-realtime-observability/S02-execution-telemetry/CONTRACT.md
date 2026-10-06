# CONTRACT: L06.S02 — Execution telemetry

## 1. Sub-LEGO Identity
- **ID**: `L06.S02`
- **Name**: Execution telemetry
- **Owning LEGO**: `L06-realtime-observability`
- **Ownership Team**: `observability`
- **Execution Model**: `in-process`
- **Runtime Host**: `H03` (Execution Host)
- **State Ownership**: `telemetry-metrics-ring`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports

### `port.observability.telemetry.record.v1`
- **Category**: Public Contract / Observability Ingress
- **Transport**: contract-defined
- **Status**: Active
- **Purpose**: Mencatat event telemetry, metrik komputasi, durasi eksekusi node, dan marker span ke dalam bounded ring buffer terisolasi per tenant.
- **Request Shape**:
  ```json
  {
    "tenant_id": "string",
    "execution_id": "string",
    "metric_name": "string",
    "metric_type": "counter | gauge | histogram | span",
    "value": 123.45,
    "labels": { "node_name": "HTTPRequest" }
  }
  ```
- **Response Shape**:
  ```json
  {
    "success": true,
    "metric_id": "string",
    "total_recorded": 100,
    "buffer_len": 50,
    "capacity": 1000,
    "summary": {
      "metric_name": "string",
      "count": 1,
      "avg": 123.45
    }
  }
  ```
- **Error Taxonomy**: `PortErrorCode::BadRequest`, `PortErrorCode::InternalError`, `PortErrorCode::SecurityDenied`
- **Idempotency**: Non-idempotent event recording

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`telemetry-metrics-ring`).
4. Bounded ring buffer: wajib menerapkan kebijakan rotasi/eviksi FIFO berkapasitas terbatas guna mencegah kebocoran memori pada beban streaming terus-menerus.
5. Isolasi multi-tenant: metrik antartenant tidak boleh bercampur atau dapat diakses secara silang.
6. Model eksekusi mematuhi batasan runtime host `H03` (Execution Host).
