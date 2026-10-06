# CONTRACT: L09.S03 — Realtime/browser compatibility

## 1. Sub-LEGO Identity
- **ID**: `L09.S03`
- **Name**: Realtime/browser compatibility
- **Owning LEGO**: `L09-ui-compatibility`
- **Ownership Team**: `ui-compat`
- **Execution Model**: `in-process`
- **Runtime Host**: `H01` (Gateway Host)
- **State Ownership**: `browser-sock-clients`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.ui.browser_sock.stream.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active
- **Capability**: Manages realtime browser streaming connections, channel subscriptions, and event distribution.

---

## 3. Required Ports
- `port.observability.realtime.publish.v1` (Provider: `L06.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`browser-sock-clients`).
4. Model eksekusi mematuhi batasan runtime host `H01` (Gateway Host).
