# CONTRACT: L08.S02 — Tool registry

## 1. Sub-LEGO Identity
- **ID**: `L08.S02`
- **Name**: Tool registry
- **Owning LEGO**: `L08-agent-mcp`
- **Ownership Team**: `agent-runtime`
- **Execution Model**: `in-process`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `mcp-tool-catalog`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.agent.tool.register.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.agent.tool.invoke.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`mcp-tool-catalog`).
4. Model eksekusi mematuhi batasan runtime host `H06` (Agent Host).
5. Tool input arguments divalidasi fail-closed terhadap schema parameter sebelum eksekusi.
