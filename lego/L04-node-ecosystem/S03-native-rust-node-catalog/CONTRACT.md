# CONTRACT: L04.S03 — Native Rust node catalog

## 1. Sub-LEGO Identity
- **ID**: `L04.S03`
- **Name**: Native Rust node catalog
- **Owning LEGO**: `L04-node-ecosystem`
- **Ownership Team**: `node-ecosystem`
- **Execution Model**: `library/pure`
- **Runtime Host**: `H04` (Worker Host)
- **State Ownership**: `stateless`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `IMPLEMENTED`

---

## 2. Provided Ports
### `port.node.execute.invoke.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.security.credential.release.v1` (Provider: `L02.S04`)
- `port.storage.binary.stream.v1` (Provider: `L05.S04`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`stateless`).
4. Model eksekusi mematuhi batasan runtime host `H04` (Worker Host).
