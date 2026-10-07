# CONTRACT: L06.S07 — Audit and bounded retention

## 1. Sub-LEGO Identity
- **ID**: `L06.S07`
- **Name**: Audit and bounded retention
- **Owning LEGO**: `L06-realtime-observability`
- **Ownership Team**: `observability`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `audit-retention-ledger`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.observability.audit.record.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.observability.audit.query.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`audit-retention-ledger`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
