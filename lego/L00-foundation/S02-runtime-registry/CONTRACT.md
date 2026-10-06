# CONTRACT: L00.S02 — Runtime Registry

## 1. Sub-LEGO Identity
- **ID**: `L00.S02`
- **Name**: Runtime registry
- **Owning LEGO**: `L00-foundation`
- **Ownership Team**: `runtime-core`
- **Execution Model**: `in-process`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `runtime-registry-state`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`

---

## 2. Provided Ports

### `port.runtime.registry.lookup.v1`
- **Category**: Query
- **Purpose**: Mencari metadata Sub-LEGO, capability, dan endpoint port berdasarkan sublego_id atau port_id.
- **Request Shape**: `{ "sublego_id": Option<string>, "port_id": Option<string> }`
- **Response Shape**: `{ "sublego": Option<SubLegoMetadata>, "matched_ports": Vec<string> }`
- **Error Taxonomy**: `PortErrorCode::NotFound`, `PortErrorCode::BadRequest`
- **Idempotency**: Idempotent

### `port.runtime.registry.register.v1`
- **Category**: Command
- **Purpose**: Mendaftarkan Sub-LEGO baru secara dinamis ke runtime registry.
- **Request Shape**: `{ "sublego": SubLegoMetadata }`
- **Response Shape**: `{ "registered": bool, "id": string }`
- **Error Taxonomy**: `PortErrorCode::Conflict`, `PortErrorCode::BadRequest`
- **Idempotency**: Idempotent

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)

---

## 4. Invariants & Rules
1. Registry bertindak sebagai authoritative catalog runtime untuk seluruh Sub-LEGO dan port binding.
2. Dilarang mendaftarkan Sub-LEGO duplikat atau port ID duplikat dari provider yang berbeda (fail-closed).
3. Lookup harus thread-safe (memakai synchronized read lock) dan berkinerja tinggi (in-process direct lookup).
4. Sub-LEGO yang didaftarkan wajib memiliki contract version yang valid dan runtime host yang terdefinisi (H01–H07).
