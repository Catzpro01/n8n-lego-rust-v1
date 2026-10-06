# CONTRACT: L11.S01 — Event/automation control plane

## 1. Sub-LEGO Identity
- **ID**: `L11.S01`
- **Name**: Event/automation control plane
- **Owning LEGO**: `L11-future-platform`
- **Ownership Team**: `platform-future`
- **Execution Model**: `control-component`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `event-control-bus`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `DESIGNED (Architecture Blueprint Only - Implementation Pending)`

---

## 2. Provided Ports
### `port.future.event_bus.publish.v1`
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
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`event-control-bus`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
