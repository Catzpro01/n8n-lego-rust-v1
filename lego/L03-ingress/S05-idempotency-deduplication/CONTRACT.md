# CONTRACT: L03.S05 — Idempotency/deduplication

## 1. Sub-LEGO Identity
- **ID**: `L03.S05`
- **Name**: Idempotency/deduplication
- **Owning LEGO**: `L03-ingress`
- **Ownership Team**: `ingress-gateway`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `dedup-hash-cache` (alias: `idempotency-keys`)
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.ingress.dedup.check.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.ingress.idempotency.dedupe.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`dedup-hash-cache` / `idempotency-keys`).
4. Model eksekusi mematuhi batasan runtime host `H01` (Gateway Host).
5. Fail-closed: Request terdeteksi in-flight ditolak untuk mencegah double execution.
6. Cached responses disimpan dengan TTL definitif dan direplay transparan untuk repeated valid keys.
