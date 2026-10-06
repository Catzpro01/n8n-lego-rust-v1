# CONTRACT: L04.S02 — Trust/quarantine/runtime locality

## 1. Sub-LEGO Identity
- **ID**: `L04.S02`
- **Name**: Trust/quarantine/runtime locality
- **Owning LEGO**: `L04-node-ecosystem`
- **Ownership Team**: `node-ecosystem`
- **Execution Model**: `in-process`
- **Runtime Host**: `H04` (Worker Host)
- **State Ownership**: `node-trust-tiers`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.node.trust.evaluate.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.security.authz.authorize.v1` (Provider: `L02.S03`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`node-trust-tiers`).
4. Model eksekusi mematuhi batasan runtime host `H04` (Worker Host).
