# CONTRACT: L04.S05 — Community/private/custom node compatibility

## 1. Sub-LEGO Identity
- **ID**: `L04.S05`
- **Name**: Community/private/custom node compatibility
- **Owning LEGO**: `L04-node-ecosystem`
- **Ownership Team**: `node-ecosystem`
- **Execution Model**: `worker-capability`
- **Runtime Host**: `H07` (Compatibility Host)
- **State Ownership**: `custom-node-tarballs`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.node.custom.load.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.node.trust.evaluate.v1` (Provider: `L04.S02`)
- `port.node.compat.invoke_js.v1` (Provider: `L04.S04`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`custom-node-tarballs`).
4. Model eksekusi mematuhi batasan runtime host `H07` (Compatibility Host).
