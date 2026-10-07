# CONTRACT: L08.S05 — AI provider routing

## 1. Sub-LEGO Identity
- **ID**: `L08.S05`
- **Name**: AI provider routing
- **Owning LEGO**: `L08-agent-mcp`
- **Ownership Team**: `agent-runtime`
- **Execution Model**: `remote-adapter`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `provider-routing-table`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.agent.provider.route.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.agent.provider.chat.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.security.credential.release.v1` (Provider: `L02.S04`)
- `port.agent.budget.enforce.v1` (Provider: `L08.S07`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`provider-routing-table`).
4. Model eksekusi mematuhi batasan runtime host `H06` (Agent Host).
5. Route resolution mendukung failover otomatis ke secondary provider jika primary mengalami kegagalan/unhealthy; jika seluruh provider tidak tersedia, eksekusi gagal tertutup (fail-closed).
