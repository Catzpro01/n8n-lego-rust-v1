# n8n-rust-v.4 → n8n-lego-rust-v1 Feature Migration

## Source of truth

Source repository: `Catzpro01/n8n-rust-v.4`

The source repository is READ-ONLY for this migration. No feature implementation is copied by blind merge; requirements are ported into the current LEGO architecture and re-certified against the official n8n reference.

Inventory at migration audit:
- 37 open issues
- 57 closed issues
- 94 total historical issues

## Migration rule

A source issue is classified into one of four buckets:

1. **PRODUCT / RUNTIME** — migrate implementation and compatibility behavior.
2. **SECURITY / PLATFORM** — migrate implementation, negative tests, and operational controls.
3. **ROADMAP / FUTURE PRODUCT** — migrate as an implementation backlog and implement when its requirements are compatible with the current architecture.
4. **GOVERNANCE / MANAGER OPERATIONS** — do not copy as n8n runtime behavior. Preserve only project-level lessons that improve CI, evidence, or delivery safety.

Governance issues must not become user-facing application features.

## Canonical migration tracks

| Track | Source issues | Target in n8n-lego-rust-v1 |
|---|---|---|
| Plugin/runtime/security foundation | #83 | `n8n-runtime-kernel`, credential/runtime policy, plugin boundaries |
| Unlimited workflow/runtime | #75, #97, #91 | lazy/chunked graph, bounded frontier, checkpoints, compatibility oracle |
| Trigger/webhook/ingress | #99, #103–#109 | Rust ingress/control plane, route registry, activation state machine, idempotency/backpressure |
| Identity/auth/credentials | #85, #214–#221 | auth/session/authorization/SecretRef/key management/security tests |
| Node ecosystem | #95, #100 | node admission, trust/runtime locality, native/compatibility worker contracts |
| Dynamic parameters | #223 | dynamic schema/option resolution, caching, race protection, provider boundary |
| Observability | #101 | execution telemetry, diagnostics, health/readiness, replay evidence |
| Frontend LEGO | #240, #241, #245 | official Vue UI compatibility, shared primitives, notification/accessibility parity |
| AI/MCP/agent boundary | #87, #88 | Agent Runtime, Tool Registry, MCP, approval/policy boundary |
| Storage / persistence / recovery | #236 and P8 roadmap | durable state, snapshots, backup/restore, recovery |
| Scheduler/resource intelligence | #79, #111, #233 | admission, overload control, resource budgets, adaptive scheduling |
| Worker/distributed/HA | #235 | worker control plane, leases, queue, recovery, future HA |
| Release/upgrade/compatibility | #230 | migration/versioning/release certification |
| Collaboration/promotion | #231 | workflow environments/promotion boundaries |
| Execution data plane | #232 | bounded data buffers, binary data, streaming, retention |
| Operational resilience | #237, #238 | fault injection, performance certification, operator controls |
| Ecosystem interoperability | #239 | protocol/tool/plugin contracts |
| Future event/automation plane | #228 | event triggers/automation control plane |
| Future execution semantics | #229 | side-effect reliability, idempotency, exactly/at-least-once contracts |
| Future AI/tool optimization | #234 | agent runtime optimizations |
| Future storage lifecycle | #236 | snapshots, DR, persistence lifecycle |

## Intentionally excluded from product migration

These issue families are project-governance/Manager-control-plane concerns rather than n8n runtime features and must not be copied into the application architecture:

- #77, #81, #82, #92, #94
- #121, #130
- #254–#256, #259–#277
- #282, #285, #286
- #294, #295, #307, #415

Their useful engineering practices may be retained as CI/evidence/documentation rules, but their workforce semantics are not runtime features.

## Current verified baseline

### Already present

- Rust workflow model and expression/runtime crates
- `n8n-runtime-kernel`
- bounded Tokio scheduler
- Integration IR
- basic NetworkPolicy anti-SSRF
- durable journal API + Strict/BestEffort policy
- Rust child-process compatibility worker
- Rust Code Node harness for JS/Python
- `$input.all()` / first / last / item
- JS/Python runtime version resolution
- workflow error propagation
- Rust execution through standalone child-process JSON IPC
- single public LEGO port 5677
- official n8n Vue editor surface
- Rust realtime registry + broadcast bridge
- partial credential vault
- queue/error-recovery/subworkflow/binary-data crates

### Still incomplete and therefore part of this migration

- durable WAL as the default production execution path
- crash resume / checkpoint recovery
- full n8n execution semantic parity (branch activation, Merge, pairedItem/linking, loops, Wait/resume, retries, error workflows)
- production SecretRef/broker integration
- full auth/session/authorization kernel
- key-provider/envelope encryption rotation/recovery
- API keys/service principals/agent identity
- full node admission/trust/quarantine model
- dynamic parameters/schema runtime
- P4 ingress/trigger/activation protocol
- differential compatibility oracle
- complete observability/replay/operator diagnostics
- large-workflow lazy/chunked graph and bounded-memory execution
- production streaming/binary retention model
- Agent Runtime + MCP + approval/policy layer
- release/upgrade compatibility certification
- collaboration/environment promotion
- future worker fabric / HA
- P12–P23 roadmap capabilities
- removal of silent JS execution fallback in production/certification mode

## Delivery rule

Every migrated capability must have:

1. implementation in the current repo architecture;
2. unit tests;
3. negative/security tests where applicable;
4. n8n reference differential tests where behavior is user-visible;
5. documentation/evidence;
6. exact commit/branch verification;
7. fresh-main verification before completion.

No source issue is considered migrated merely because its title or design document exists in the new repo.


## Additional source issue coverage

The migration scope also includes these implementation-relevant requirements:

- #78 — single-tenant-first VPS-native control plane with future multi-tenant boundaries.
- #79 — burst traffic, overload control, admission/backpressure, graceful degradation.
- #80 — Rust strangler migration while preserving the official n8n UI and node compatibility.
- #84 — installation, upgrade, packaging and compatibility lifecycle.
- #86 — AI provider capability honesty, approval-bound authority and usage accounting.
- #87 — MCP/Agent boundary, node portability, Node Creator and translation contracts.
- #88 — AI decision boundary and human-controlled high-impact actions.
- #93 — lightweight local AI routing/decision runtime as an optional provider/runtime adapter.
- #95/#100 — official/community/private/custom/native node ecosystem admission and runtime locality.
- #96 — VPS operational boundary, gateway health, network binding and remote reachability.
- #98 — parallel milestone isolation and agent/workspace boundaries as delivery infrastructure, not runtime product behavior.
- #99/#103–#109 — trigger/webhook/schedule/event/manual/waiting ingress, route lifecycle, activation/reconciliation, admission, idempotency and performance gates.
- #111 — advanced ingress efficiency and smart runtime features.
- #115 — resilient scraper/browser hybrid node capability.
- #116 — native high-performance node catalog beyond the upstream baseline.
- #210 — uncovered architecture gaps discovered during design discussions; each concrete requirement must be promoted into the migration matrix before implementation.
- #223 — dynamic parameters/schema runtime.
- #224/#225 — advanced runtime/platform feature backlog.
- #228–#239 — post-P11 feature families; these are now part of this migration program because the owner explicitly requested the full feature set, but each capability still needs executable acceptance evidence before it is marked implemented.
- #240/#241/#245 — frontend LEGO evolution, migration foundation, notification/accessibility parity.
- #266/#271/#272/#282/#285/#286/#294/#295/#307/#415 — governance/operations/worker-control requirements; retain only those portions needed to make migration delivery safe and auditable, not as n8n product features.
- #418 — lazy capability discovery and token-aware execution budgets; migrate as runtime capability/budget logic rather than Manager-specific orchestration.

## Feature-fidelity rule for legacy innovations

The source repo contains several innovation proposals whose implementation may be highly domain-specific. They are not copied as opaque old code. Their observable product requirement is re-expressed using the current architecture:

- scraper/browser hybrid -> node capability + isolated runtime locality + bounded network policy;
- native node catalog -> native Rust node registry + admission metadata + compatibility contracts;
- Laya/local AI router -> provider adapter behind the Agent/AI runtime boundary;
- token-aware budgets -> execution-context resource budgets and admission policy;
- frontend migration -> keep the official n8n Vue consumer contract while changing backend/runtime internals.

## Priority order

P0:
- security/auth/credential hardening
- durable WAL/checkpoint/recovery
- execution semantic parity
- ingress correctness and idempotency

P1:
- node admission/runtime locality
- dynamic parameters
- observability/replay
- compatibility oracle
- large-workflow memory model

P2:
- Agent Runtime/MCP/approval
- storage lifecycle/DR
- scheduler/resource intelligence
- release/upgrade certification
- collaboration/promotion

P3:
- worker fabric/HA
- ecosystem interoperability
- advanced future P12–P23 capabilities

## Do not do

- Do not merge the old repository wholesale.
- Do not copy old governance/workforce state into the runtime.
- Do not claim a feature is migrated without executable evidence.
- Do not reintroduce a public 5678 dependency.
- Do not make the reconstructed JS engine an invisible production fallback.
- Do not weaken security or compatibility semantics to make tests green.
