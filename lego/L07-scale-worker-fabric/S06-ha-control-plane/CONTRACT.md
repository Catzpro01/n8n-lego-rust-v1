# CONTRACT: L07.S06 — HA control plane

## 1. Sub-LEGO Identity
- **ID**: `L07.S06`
- **Name**: HA control plane
- **Owning LEGO**: `L07-scale-worker-fabric`
- **Ownership Team**: `fabric-scale`
- **Execution Model**: `control-component`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `cluster-control-lease`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.scale.ha.election.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.scale.ha.leader_query.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`cluster-control-lease`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
