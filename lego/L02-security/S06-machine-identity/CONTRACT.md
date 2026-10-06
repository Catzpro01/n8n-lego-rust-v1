# CONTRACT: L02.S06 — Machine identity

## 1. Sub-LEGO Identity
- **ID**: `L02.S06`
- **Name**: Machine identity
- **Owning LEGO**: `L02-security`
- **Ownership Team**: `security-kernel`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `machine-api-keys`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.security.machine.authenticate.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.security.context.create.v1` (Provider: `L02.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`machine-api-keys`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
