# CONTRACT: L04.S04 — Compatibility worker

## 1. Sub-LEGO Identity
- **ID**: `L04.S04`
- **Name**: Compatibility worker
- **Owning LEGO**: `L04-node-ecosystem`
- **Ownership Team**: `node-ecosystem`
- **Execution Model**: `worker-capability`
- **Runtime Host**: `H07` (Compatibility Host)
- **State Ownership**: `worker-bridge-sessions`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `rolling-dual-version`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.node.compat.invoke_js.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.node.execute.invoke.v1` (Provider: `L04.S03`)
- `port.storage.binary.stream.v1` (Provider: `L05.S04`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`worker-bridge-sessions`).
4. Model eksekusi mematuhi batasan runtime host `H07` (Compatibility Host).
