# CONTRACT: L10.S04 — Upgrade/rollback

## 1. Sub-LEGO Identity
- **ID**: `L10.S04`
- **Name**: Upgrade/rollback
- **Owning LEGO**: `L10-release-upgrade`
- **Ownership Team**: `release-lifecycle`
- **Execution Model**: `control-component`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `upgrade-stage-offsets`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `rolling-dual-version`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.release.lifecycle.upgrade_step.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.release.lifecycle.rollback_step.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.release.migration.apply.v1` (Provider: `L10.S02`)
- `port.scale.worker.drain.v1` (Provider: `L07.S04`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`upgrade-stage-offsets`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
