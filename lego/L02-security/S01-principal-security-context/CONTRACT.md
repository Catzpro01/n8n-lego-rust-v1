# CONTRACT: L02.S01 — Principal and security context

## 1. Sub-LEGO Identity
- **ID**: `L02.S01`
- **Name**: Principal and security context
- **Owning LEGO**: `L02-security`
- **Ownership Team**: `security-kernel`
- **Execution Model**: `in-process`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `stateless`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `IMPLEMENTED`

---

## 2. Provided Ports
### `port.security.context.create.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.security.context.validate.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`stateless`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
