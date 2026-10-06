# CONTRACT: L04.S06 — Code/polyglot runtime contracts

## 1. Sub-LEGO Identity
- **ID**: `L04.S06`
- **Name**: Code/polyglot runtime contracts
- **Owning LEGO**: `L04-node-ecosystem`
- **Ownership Team**: `node-ecosystem`
- **Execution Model**: `worker-capability`
- **Runtime Host**: `H04` (Worker Host)
- **State Ownership**: `polyglot-isolated-sandbox`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.node.polyglot.execute.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.runtime.budget.allocate.v1` (Provider: `L00.S03`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`polyglot-isolated-sandbox`).
4. Model eksekusi mematuhi batasan runtime host `H04` (Worker Host).
