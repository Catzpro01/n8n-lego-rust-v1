# CONTRACT: L03.S04 — Admission and backpressure

## 1. Sub-LEGO Identity
- **ID**: `L03.S04`
- **Name**: Admission and backpressure
- **Owning LEGO**: `L03-ingress`
- **Ownership Team**: `ingress-gateway`
- **Execution Model**: `in-process`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `rate-limit-buckets`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `IMPLEMENTED`

---

## 2. Provided Ports
### `port.ingress.admission.filter.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`rate-limit-buckets`).
4. Model eksekusi mematuhi batasan runtime host `H01` (Gateway Host).
