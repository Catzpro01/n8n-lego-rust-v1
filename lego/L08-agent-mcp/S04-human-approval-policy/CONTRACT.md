# CONTRACT: L08.S04 — Human approval and policy boundary

## 1. Sub-LEGO Identity
- **ID**: `L08.S04`
- **Name**: Human approval and policy boundary
- **Owning LEGO**: `L08-agent-mcp`
- **Ownership Team**: `agent-runtime`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `pending-human-approvals`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.agent.approval.request.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.agent.approval.submit.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`pending-human-approvals`).
4. Model eksekusi mematuhi batasan runtime host `H06` (Agent Host).
