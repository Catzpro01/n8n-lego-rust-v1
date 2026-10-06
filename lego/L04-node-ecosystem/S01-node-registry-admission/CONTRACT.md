# CONTRACT: L04.S01 — Node registry and admission

## 1. Sub-LEGO Identity
- **ID**: `L04.S01`
- **Name**: Node registry and admission
- **Owning LEGO**: `L04-node-ecosystem`
- **Ownership Team**: `node-ecosystem`
- **Execution Model**: `in-process`
- **Runtime Host**: `H04` (Worker Host)
- **State Ownership**: `node-manifest-catalog`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `IMPLEMENTED`

---

## 2. Provided Ports
### `port.node.registry.query.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.node.registry.register.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`node-manifest-catalog`).
4. Model eksekusi mematuhi batasan runtime host `H04` (Worker Host).
