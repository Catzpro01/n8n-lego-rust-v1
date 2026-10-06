# CONTRACT: L03.S07 — Startup reconciliation and recovery

## 1. Sub-LEGO Identity
- **ID**: `L03.S07`
- **Name**: Startup reconciliation and recovery
- **Owning LEGO**: `L03-ingress`
- **Ownership Team**: `ingress-gateway`
- **Execution Model**: `control-component`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `reconciliation-markers`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.ingress.reconcile.execute.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.ingress.activation.list.v1` (Provider: `L03.S02`)
- `port.storage.persistence.load.v1` (Provider: `L05.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`reconciliation-markers`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
