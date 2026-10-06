# LEGO Milestone Plan — n8n-rust-v.4 → n8n-lego-rust-v1

## 1. Tracking model

The migration is managed as:

```
LEGO
└── Sub-LEGO
    └── Work Item (Issue / PR / Test / Evidence)
```

Definitions:

- **LEGO** = a product/platform capability that can be independently declared as a milestone.
- **Sub-LEGO** = a coherent capability inside one LEGO. It has its own acceptance criteria and can be implemented/tested independently.
- **Work Item** = the concrete implementation, test, migration, documentation, or evidence unit.
- **Slice is not a planning primitive** for this repository. Do not create roadmap structure around "slice", "vertical slice", or equivalent terminology.

GitHub milestone names should use the LEGO level. Sub-LEGO identity is carried by a stable identifier in issue titles/labels/documentation.

Recommended identifiers:

```
L00  LEGO Foundation
L01  LEGO Execution
L02  LEGO Security
L03  LEGO Ingress
L04  LEGO Node Ecosystem
L05  LEGO Data & Storage
L06  LEGO Realtime & Observability
L07  LEGO Scale & Worker Fabric
L08  LEGO Agent & MCP
L09  LEGO UI & Compatibility
L10  LEGO Release & Upgrade
L11  LEGO Future Platform
```

Sub-LEGO identifiers use `Lxx.Syy`.

---

## 2. LEGO milestones

### L00 — Foundation

Purpose: runtime contracts and policy primitives required by every other LEGO.

Sub-LEGO:

- **L00.S01 — Runtime contracts**
  - execution envelope
  - lifecycle
  - ownership
  - capability contracts
  - version compatibility
- **L00.S02 — Runtime registry**
  - native Rust
  - compatibility worker
  - isolated process
  - future WASM/remote classes
- **L00.S03 — Policy and resource budgets**
  - trust level
  - permissions
  - CPU/memory/time budgets
  - cancellation/deadline contracts
- **L00.S04 — Health and lifecycle**
  - readiness/liveness
  - worker lifecycle
  - quarantine/recovery
  - audit/event primitives

Primary source scope: #83, #210.

---

### L01 — Execution

Purpose: make Rust the authoritative n8n-compatible execution engine.

Sub-LEGO:

- **L01.S01 — Execution semantics**
  - branch activation
  - Merge
  - pairedItem/linking
  - loops
  - retries
  - error workflows
  - cancellation/timeouts
- **L01.S02 — Wait and resume**
  - durable wait state
  - resume
  - webhook/form/manual resume paths
- **L01.S03 — Sub-workflows**
  - Execute Workflow
  - nested execution lifecycle
  - parent/child propagation
- **L01.S04 — Checkpoint and crash recovery**
  - durable WAL
  - checkpoint
  - restart/resume
  - replay
- **L01.S05 — Unlimited/lazy workflow graph**
  - virtual/lazy nodes
  - bounded frontier
  - fan-out/fan-in control
  - chunked graph state
  - memory budgets
- **L01.S06 — Compatibility oracle**
  - differential execution
  - metamorphic checks
  - restart/resume certification
  - semantic golden cases

Primary source scope: #75, #91, #97, #229.

---

### L02 — Security

Purpose: establish the Rust security/identity/credential kernel.

Sub-LEGO:

- **L02.S01 — Principal and security context**
- **L02.S02 — Session lifecycle**
  - create/refresh/rotate/revoke
  - fixation/replay protection
  - security-version invalidation
- **L02.S03 — Authorization**
  - default deny
  - resource/action policy
  - scope projection
  - bounded authorization cache
- **L02.S04 — Credential broker**
  - metadata vs runtime secret separation
  - SecretRef
  - audience binding
  - single-use release
  - redaction
- **L02.S05 — Cryptography and key lifecycle**
  - encrypted envelope
  - key provider
  - rotation
  - recovery
  - backup manifest
- **L02.S06 — Machine identity**
  - API keys
  - service principals
  - worker/agent/MCP identity
- **L02.S07 — Password/MFA recovery**
  - reset
  - lockout
  - TOTP/recovery
  - step-up auth

Primary source scope: #85, #214–#221.

---

### L03 — Ingress

Purpose: make triggers and ingress first-class Rust control-plane capabilities.

Sub-LEGO:

- **L03.S01 — Webhook routing**
- **L03.S02 — Activation state machine**
- **L03.S03 — Schedule/event/manual/form triggers**
- **L03.S04 — Admission and backpressure**
- **L03.S05 — Idempotency/deduplication**
- **L03.S06 — Response plans and streaming payloads**
- **L03.S07 — Startup reconciliation and recovery**

Primary source scope: #99, #103–#109, #228, #96.

---

### L04 — Node Ecosystem

Purpose: preserve the n8n node ecosystem while progressively moving execution to Rust.

Sub-LEGO:

- **L04.S01 — Node registry and admission**
- **L04.S02 — Trust/quarantine/runtime locality**
- **L04.S03 — Native Rust node catalog**
- **L04.S04 — Compatibility worker**
- **L04.S05 — Community/private/custom node compatibility**
- **L04.S06 — Code/polyglot runtime contracts**
- **L04.S07 — Browser/scraper hybrid capability**
- **L04.S08 — Dynamic parameter/schema runtime**

Primary source scope: #80, #95, #100, #115, #116, #223.

---

### L05 — Data & Storage

Purpose: make execution state and data durable, bounded, and recoverable.

Sub-LEGO:

- **L05.S01 — Workflow/execution persistence**
- **L05.S02 — Durable WAL and transactions**
- **L05.S03 — Execution data plane**
- **L05.S04 — Binary data and streaming**
- **L05.S05 — Retention/compaction**
- **L05.S06 — Snapshot/backup/restore**
- **L05.S07 — Disaster recovery**
- **L05.S08 — Environment promotion**

Primary source scope: #232, #236, #231.

---

### L06 — Realtime & Observability

Purpose: provide authoritative execution state, diagnostics, and operational evidence.

Sub-LEGO:

- **L06.S01 — Realtime event contract**
- **L06.S02 — Execution telemetry**
- **L06.S03 — Node/plugin/worker diagnostics**
- **L06.S04 — Health/readiness**
- **L06.S05 — Replay and causal diagnostics**
- **L06.S06 — Resource pressure and queue metrics**
- **L06.S07 — Audit and bounded retention**

Primary source scope: #101, #237, #307 (engineering evidence only).

---

### L07 — Scale & Worker Fabric

Purpose: handle burst traffic, resource pressure, and future distributed execution without weakening semantics.

Sub-LEGO:

- **L07.S01 — Scheduler/resource intelligence**
- **L07.S02 — Burst admission and graceful degradation**
- **L07.S03 — Queue/lease model**
- **L07.S04 — Worker lifecycle**
- **L07.S05 — Worker recovery and failover**
- **L07.S06 — HA control plane**
- **L07.S07 — Ingress/runtime efficiency**

Primary source scope: #79, #111, #233, #235.

---

### L08 — Agent & MCP

Purpose: add an agentic runtime without weakening deterministic workflow semantics.

Sub-LEGO:

- **L08.S01 — Agent state machine**
- **L08.S02 — Tool registry**
- **L08.S03 — Workflow-as-tool**
- **L08.S04 — Human approval and policy boundary**
- **L08.S05 — AI provider routing**
- **L08.S06 — Memory**
- **L08.S07 — Token/execution budgets**
- **L08.S08 — MCP interoperability**
- **L08.S09 — Usage accounting and audit**

Primary source scope: #86, #87, #88, #93, #234, #418.

---

### L09 — UI & Compatibility

Purpose: preserve the official n8n Vue UI and public contracts while changing the backend/runtime.

Sub-LEGO:

- **L09.S01 — Official Vue surface compatibility**
- **L09.S02 — REST/API compatibility**
- **L09.S03 — Realtime/browser compatibility**
- **L09.S04 — Notifications/accessibility parity**
- **L09.S05 — Enterprise-facing compatibility surfaces**
- **L09.S06 — Frontend migration/decommission plan**

Primary source scope: #240, #241, #245, #80.

Important: UI flags or empty endpoints do not count as complete Enterprise backend semantics.

---

### L10 — Release & Upgrade

Purpose: make migration operable as a production platform lifecycle.

Sub-LEGO:

- **L10.S01 — Installation/packaging**
- **L10.S02 — Database/schema migrations**
- **L10.S03 — Runtime/node compatibility matrix**
- **L10.S04 — Upgrade/rollback**
- **L10.S05 — Release certification**
- **L10.S06 — Security/performance certification**

Primary source scope: #84, #230, #221/P5.8.

---

### L11 — Future Platform

Purpose: hold P12–P23 capabilities that depend on the earlier LEGO contracts.

Sub-LEGO:

- **L11.S01 — Event/automation control plane**
- **L11.S02 — Execution side-effect reliability**
- **L11.S03 — Advanced scheduler/resource intelligence**
- **L11.S04 — Worker/distributed execution extensions**
- **L11.S05 — Storage lifecycle/DR extensions**
- **L11.S06 — Operator/edge control plane**
- **L11.S07 — Ecosystem interoperability**
- **L11.S08 — Advanced Agent/AI optimization**

Primary source scope: #228–#239 and remaining P12–P23 requirements.

---

## 3. Milestone rules

### LEGO completion

A LEGO is **DONE** only when:

1. every required Sub-LEGO is DONE;
2. implementation exists in the current repository;
3. automated tests pass;
4. negative/security tests pass where relevant;
5. official-n8n differential tests pass for user-visible semantics;
6. observability/evidence exists;
7. recovery/restart behavior is tested where applicable;
8. the final state is verified from the latest main commit.

### Sub-LEGO completion

A Sub-LEGO is **DONE** only when its acceptance criteria are executable and independently verifiable.

A Sub-LEGO may span multiple pull requests, but the milestone hierarchy must remain stable.

### Work-item rule

Issues and PRs should reference exactly one primary Sub-LEGO:

```
[LEGO L01.S04] Durable WAL + checkpoint recovery
[LEGO L03.S05] Webhook idempotency
[LEGO L08.S04] Human approval policy
```

Do not create planning items named as "slice".

---

## 4. Recommended GitHub representation

GitHub Milestone is the **LEGO** level:

- `LEGO L00 — Foundation`
- `LEGO L01 — Execution`
- `LEGO L02 — Security`
- `LEGO L03 — Ingress`
- `LEGO L04 — Node Ecosystem`
- `LEGO L05 — Data & Storage`
- `LEGO L06 — Realtime & Observability`
- `LEGO L07 — Scale & Worker Fabric`
- `LEGO L08 — Agent & MCP`
- `LEGO L09 — UI & Compatibility`
- `LEGO L10 — Release & Upgrade`
- `LEGO L11 — Future Platform`

Sub-LEGO should use a stable label or title prefix:

`sublego:L01.S04`

or

`[LEGO L01.S04]`

One issue can have many supporting references, but only one **primary** Sub-LEGO.

---

## 5. Migration ordering

The dependency order is:

```
L00 Foundation
   ↓
L01 Execution ─────────────┐
L02 Security ──────────────┤
L03 Ingress ───────────────┤
L04 Node Ecosystem ────────┤
   ↓                       ↓
L05 Data & Storage     L06 Realtime & Observability
   ↓                       ↓
L07 Scale & Worker Fabric
   ↓
L08 Agent & MCP
   ↓
L09 UI & Compatibility
   ↓
L10 Release & Upgrade
   ↓
L11 Future Platform
```

The arrows describe dependency/readiness, not implementation exclusivity. Work may proceed in parallel when its Sub-LEGO dependencies are already satisfied.

## 6. What changes from the previous plan

The previous "track/slice" language is retired.

Use only:

- **LEGO** for the milestone/epic level.
- **Sub-LEGO** for the capability level.
- **Work Item** for implementation/test/evidence.

Historical issue numbers remain source references; they are not themselves the new milestone hierarchy.
