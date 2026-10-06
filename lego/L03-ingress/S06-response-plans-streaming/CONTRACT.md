# CONTRACT: L03.S06 — Response plans and streaming payloads

## 1. Sub-LEGO Identity
- **ID**: `L03.S06`
- **Name**: Response plans and streaming payloads
- **Owning LEGO**: `L03-ingress`
- **Ownership Team**: `ingress-gateway`
- **Execution Model**: `in-process`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `pending-response-waiters`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.ingress.response.stream.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.storage.binary.stream.v1` (Provider: `L05.S04`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`pending-response-waiters`).
4. Model eksekusi mematuhi batasan runtime host `H01` (Gateway Host).
