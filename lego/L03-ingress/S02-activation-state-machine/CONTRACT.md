# CONTRACT: L03.S02 — Activation state machine

## 1. Sub-LEGO Identity
- **ID**: `L03.S02`
- **Name**: Activation state machine
- **Owning LEGO**: `L03-ingress`
- **Ownership Team**: `ingress-gateway`
- **Execution Model**: `control-component`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `active-triggers-registry`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `IMPLEMENTED`

---

## 2. Provided Ports
### `port.ingress.activation.toggle.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.ingress.activation.list.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`active-triggers-registry`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
