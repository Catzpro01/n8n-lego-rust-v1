# CONTRACT: L10.S03 — Runtime/node compatibility matrix

## 1. Sub-LEGO Identity
- **ID**: `L10.S03`
- **Name**: Runtime/node compatibility matrix
- **Owning LEGO**: `L10-release-upgrade`
- **Ownership Team**: `release-lifecycle`
- **Execution Model**: `tooling`
- **Runtime Host**: `H07` (Compatibility Host)
- **State Ownership**: `compat-matrix-rules`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.release.compat_matrix.evaluate.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.node.registry.query.v1` (Provider: `L04.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`compat-matrix-rules`).
4. Model eksekusi mematuhi batasan runtime host `H07` (Compatibility Host).
