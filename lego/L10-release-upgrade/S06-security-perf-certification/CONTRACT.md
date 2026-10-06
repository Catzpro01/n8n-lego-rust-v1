# CONTRACT: L10.S06 — Security/performance certification

## 1. Sub-LEGO Identity
- **ID**: `L10.S06`
- **Name**: Security/performance certification
- **Owning LEGO**: `L10-release-upgrade`
- **Ownership Team**: `release-lifecycle`
- **Execution Model**: `tooling`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `benchmark-audit-traces`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.release.security_audit.scan.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`benchmark-audit-traces`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
