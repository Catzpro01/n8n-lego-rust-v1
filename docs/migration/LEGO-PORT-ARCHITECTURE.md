# LEGO Port Architecture

## 1. Core model

The repository uses three independent axes:

text:
Planning
LEGO -> Sub-LEGO

Connectivity
Provided Port <-> Required Port

Deployment
Runtime Host -> hosted Sub-LEGOs

A Sub-LEGO is a replaceable component, not automatically a runtime process.

## 2. Sub-LEGO contract

Every Sub-LEGO owns:

text:
Sub-LEGO
├── CONTRACT.md
├── ports/
│   ├── provided/
│   └── required/
├── implementation/
├── tests/
└── evidence/

A Sub-LEGO may expose zero or more provided ports and consume zero or more required ports.

### Provided port

A provided port is a capability made available to another component.

Required fields:

- port_id
- contract_version
- protocol
- schema
- request/response or event shape
- error model
- timeout
- idempotency
- authorization context
- observability identity
- compatibility policy

### Required port

A required port declares a dependency on a capability without naming or importing the provider's internal implementation.

Required fields:

- port_id
- acceptable contract versions
- invocation semantics
- timeout/deadline
- retry policy
- failure behavior
- security requirements
- backpressure behavior

## 3. Port categories

### Command
State-changing request.

Examples: execution.submit.v1, execution.cancel.v1, credential.release.v1, activation.enable.v1.

### Query
Read-only request.

Examples: execution.inspect.v1, workflow.get.v1, authorization.check.v1.

### Event
Asynchronous state notification.

Examples: execution.started.v1, execution.finished.v1, worker.failed.v1, activation.changed.v1.

### Stream
Bounded data stream.

Examples: binary.read.v1, execution.output.stream.v1, webhook.payload.stream.v1.

### Lifecycle
Component control.

Examples: health.check.v1, component.reconcile.v1, worker.drain.v1.

### Data
Explicit storage ownership boundary.

Examples: execution.append.v1, checkpoint.save.v1, snapshot.restore.v1.

## 4. Connection topology

A valid connection is always:

text:
Consumer Sub-LEGO
      │
      │ required port
      ▼
   Adapter
      │
      │ contract
      ▼
Provider Sub-LEGO
      │
      │ provided port
      ▼
Implementation

The consumer does not know whether the provider is in the same Rust module, another Rust crate, another process, another machine, or a compatibility implementation. Only the contract is stable.

## 5. Runtime hosts

Runtime hosts are deployment units, not milestones.

Initial target hosts:

| Host | Responsibility | Typical hosted Sub-LEGOs |
|---|---|---|
| H01 Gateway Host | HTTP/UI/realtime ingress | L03, L09 edge adapters |
| H02 Control Host | identity, policy, lifecycle | L00, L02, L03 control |
| H03 Execution Host | workflow execution and state machine | L01, selected L05/L06 |
| H04 Worker Host | isolated/parallel node execution | L04, L07 worker capabilities |
| H05 Data Host | durable database/object storage | L05 persistence capabilities |
| H06 Agent Host | agent/tool/MCP execution | L08 |
| H07 Compatibility Host | official n8n/Node compatibility | L04/L09 compatibility adapters |

These are initial deployment boundaries, not mandatory one-to-one mappings.

A host can contain multiple Sub-LEGOs.

A Sub-LEGO can move between hosts without changing its public port contract.

## 6. Execution models

Every Sub-LEGO must declare one execution model:

- **Pure** — deterministic logic with no independent lifecycle.
- **In-process** — hosted inside a shared Rust runtime.
- **Stateful component** — owns state through a data boundary.
- **Worker capability** — runs under a worker host and may be independently scaled.
- **Remote adapter** — local contract with an external implementation.
- **Contract-only** — schemas/events/types with no executable runtime.

This explicitly means **not every Sub-LEGO has a runtime**.

## 7. Scaling model

Scaling is determined by runtime host and port class.

- stateless/query ports can scale horizontally;
- queue-backed worker ports can scale by queue depth/concurrency;
- stateful components scale according to their persistence contract;
- read ports may use replicas/caches without changing the business contract.

Do not create multiple state owners merely to achieve process-level scaling.

## 8. Upgrade model

Contracts use semantic compatibility.

Non-breaking changes can roll forward independently, such as additive optional fields or compatible error extensions.

Breaking changes require a new version:

text:
execution.submit.v1
execution.submit.v2

Migration pattern:

text:
v1 + v2
   ↓
consumers migrate
   ↓
v1 removed

No upgrade may require every Sub-LEGO to be upgraded synchronously.

## 9. Failure isolation

A failure remains inside the smallest useful boundary.

Examples:

- validation failure does not crash the execution host;
- one compatibility worker failure does not terminate the control host;
- one execution cannot corrupt another execution's checkpoint;
- one AI provider failure does not invalidate deterministic workflow execution;
- remote data-provider failure surfaces through the port error contract.

## 10. Security isolation

Every port carries the minimum security context required for the operation.

No port may implicitly grant arbitrary credentials, unrestricted network access, tenant crossing, filesystem access, or operator privileges.

Credential release is itself a port-mediated operation.

## 11. Observability

Every port call must be traceable with:

- correlation ID;
- caller Sub-LEGO;
- provider Sub-LEGO;
- port ID/version;
- runtime host;
- request/result status;
- duration;
- retry count;
- queue wait where applicable;
- resource/budget outcome.

## 12. Milestone acceptance gates

A Sub-LEGO cannot be DONE until:

1. it has a canonical physical root;
2. its execution model is declared;
3. provided/required ports are declared;
4. every external dependency is a port;
5. the port contract is versioned;
6. an adapter exists for the selected runtime host;
7. boundary tests verify provider/consumer compatibility;
8. the component can be moved to another suitable host without changing the contract;
9. scaling behavior is documented;
10. upgrade/rollback behavior is documented.

A LEGO cannot be DONE until all required Sub-LEGOs satisfy these gates.

## 13. Anti-patterns

Forbidden:

- Sub-LEGO = one container.
- Sub-LEGO = one process.
- Sub-LEGO imports another Sub-LEGO internal module.
- Sub-LEGO directly writes another Sub-LEGO state.
- global engine.rs owns unrelated capabilities.
- shared utils.ts contains business behavior from many Sub-LEGOs.

The objective is LEGO-like composition, not microservice proliferation.

## 14. Target end state

text:
             versioned port contracts
                    │
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
 Sub-LEGO A    Sub-LEGO B    Sub-LEGO C
     │              │              │
     └──────┬───────┴───────┬──────┘
            ▼               ▼
       Runtime Host      Runtime Host
            │               │
            └───────┬───────┘
                    ▼
              scalable system

The planning hierarchy remains stable while implementation location, process layout, runtime host, and scaling strategy can evolve independently.
