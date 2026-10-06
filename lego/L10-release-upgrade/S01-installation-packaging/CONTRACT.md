# CONTRACT: L10.S01 — Installation/packaging

## 1. Sub-LEGO Identity
- **ID**: `L10.S01`
- **Name**: Installation/packaging
- **Owning LEGO**: `L10-release-upgrade`
- **Ownership Team**: `release-lifecycle`
- **Execution Model**: `tooling`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `package-artifacts`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.release.packaging.build.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- *None*

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`package-artifacts`).
4. Model eksekusi mematuhi batasan runtime host `H01` (Gateway Host).
