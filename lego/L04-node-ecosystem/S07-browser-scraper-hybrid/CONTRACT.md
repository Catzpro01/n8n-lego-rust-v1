# CONTRACT: L04.S07 — Browser/scraper hybrid capability

## 1. Sub-LEGO Identity
- **ID**: `L04.S07`
- **Name**: Browser/scraper hybrid capability
- **Owning LEGO**: `L04-node-ecosystem`
- **Ownership Team**: `node-ecosystem`
- **Execution Model**: `worker-capability`
- **Runtime Host**: `H04` (Worker Host)
- **State Ownership**: `browser-session-pool`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.node.browser.render.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.node.browser.hybrid.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.runtime.budget.allocate.v1` (Provider: `L00.S03`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`browser-session-pool`).
4. Model eksekusi mematuhi batasan runtime host `H04` (Worker Host).
5. Fail-closed security: Invocations without valid authority scope, tenant, or with invalid targets are rejected.
6. Pool capacity bounds and TTL expiration are strictly enforced without memory leakage.
