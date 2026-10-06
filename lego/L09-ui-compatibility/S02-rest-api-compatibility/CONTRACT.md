# CONTRACT: L09.S02 — REST/API compatibility

## 1. Sub-LEGO Identity
- **ID**: `L09.S02`
- **Name**: REST/API compatibility
- **Owning LEGO**: `L09-ui-compatibility`
- **Ownership Team**: `ui-compat`
- **Execution Model**: `in-process`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `rest-endpoint-specs`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `rolling-dual-version`
- **Status**: `IMPLEMENTED`

---

## 2. Provided Ports
### `port.ui.rest.dispatch.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.storage.persistence.load.v1` (Provider: `L05.S01`)
- `port.execution.run.workflow.v1` (Provider: `L01.S01`)
- `port.security.session.create.v1` (Provider: `L02.S02`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`rest-endpoint-specs`).
4. Model eksekusi mematuhi batasan runtime host `H01` (Gateway Host).
