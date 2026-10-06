# CONTRACT: L03.S03 — Schedule/event/manual/form triggers

## 1. Sub-LEGO Identity
- **ID**: `L03.S03`
- **Name**: Schedule/event/manual/form triggers
- **Owning LEGO**: `L03-ingress`
- **Ownership Team**: `ingress-gateway`
- **Execution Model**: `in-process`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `cron-timer-slots`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.ingress.trigger.dispatch.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.execution.run.workflow.v1` (Provider: `L01.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`cron-timer-slots`).
4. Model eksekusi mematuhi batasan runtime host `H01` (Gateway Host).
