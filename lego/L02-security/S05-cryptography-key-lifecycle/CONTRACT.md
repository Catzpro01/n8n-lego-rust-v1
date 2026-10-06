# CONTRACT: L02.S05 — Cryptography and key lifecycle

## 1. Sub-LEGO Identity
- **ID**: `L02.S05`
- **Name**: Cryptography and key lifecycle
- **Owning LEGO**: `L02-security`
- **Ownership Team**: `security-kernel`
- **Execution Model**: `in-process`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `master-key-manifest`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.security.crypto.encrypt.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.security.crypto.decrypt.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`master-key-manifest`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
