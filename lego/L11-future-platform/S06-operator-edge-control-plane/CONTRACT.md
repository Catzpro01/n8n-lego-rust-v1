# CONTRACT: L11.S06 — Operator/edge control plane

## 1. Sub-LEGO Identity
- **ID**: `L11.S06`
- **Name**: Operator/edge control plane
- **Owning LEGO**: `L11-future-platform`
- **Ownership Team**: `platform-future`
- **Execution Model**: `control-component`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `edge-cluster-nodes`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.future.edge.sync.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`edge-cluster-nodes`).
4. Model eksekusi mematuhi batasan runtime host `H01` (Gateway Host).
5. Privileged operator actions wajib diautentikasi dan diverifikasi dengan scope `operator.admin`.
