# CONTRACT: L02.S02 — Session lifecycle

## 1. Sub-LEGO Identity
- **ID**: `L02.S02`
- **Name**: Session lifecycle
- **Owning LEGO**: `L02-security`
- **Ownership Team**: `security-kernel`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `active-sessions-store`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.security.session.create.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.security.session.revoke.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.security.context.validate.v1` (Provider: `L02.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`active-sessions-store`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
