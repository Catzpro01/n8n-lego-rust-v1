# CONTRACT: L08.S09 — Usage accounting and audit

## 1. Sub-LEGO Identity
- **ID**: `L08.S09`
- **Name**: Usage accounting and audit
- **Owning LEGO**: `L08-agent-mcp`
- **Ownership Team**: `agent-runtime`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `token-audit-records`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `CONTRACTED`

---

## 2. Provided Ports
### `port.agent.usage.record.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.observability.audit.record.v1` (Provider: `L06.S07`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`token-audit-records`).
4. Model eksekusi mematuhi batasan runtime host `H06` (Agent Host).
