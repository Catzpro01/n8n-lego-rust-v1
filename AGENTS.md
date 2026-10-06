# AGENTS.md — Mandatory Agent Runtime Policy & Governance

This document defines the authoritative, binding governance policy for the **Antigravity Coordinator** and **every sub-agent** operating within the `n8n-lego-rust-v1` monorepo.

Compliance with this document and its referenced contracts is **non-negotiable, fail-closed, and evidence-first**.

---

## 1. Governance Authority Hierarchy

Every agent must resolve instructions strictly through this single descending canonical hierarchy of authority:

```text
1. PLATFORM / SYSTEM (Developer safety & platform constraints)
   ↓
2. LATEST USER INSTRUCTION (Direct user prompt / override)
   ↓
3. MASTER EXECUTION CONTRACT (docs/migration/ANTIGRAVITY-MASTER-EXECUTION-CONTRACT.md)
   ↓
4. AGENTS.md (Root Agent Governance Policy & Bootstrap Pointer)
   ↓
5. AGENTIC EXECUTION STANDARD (docs/migration/ANTIGRAVITY-AGENTIC-EXECUTION-STANDARD.md)
   ↓
6. ACTIVE ISSUE / ACCEPTANCE CRITERIA (e.g. Issue #4)
   ↓
7. TASK-SPECIFIC PROMPT & SCOPED INSTRUCTIONS
   ↓
8. ANTIGRAVITY COORDINATOR EXECUTION
   ↓
9. SUB-AGENTS EXECUTION
```

* **Bootstrap & Enforcement Anchor**: `AGENTS.md` serves as the repository bootstrap and enforcement anchor pointing to this single canonical hierarchy; it is not a competing or divergent source of precedence.
* **No Weakening**: A lower layer MUST NOT silently reinterpret, reduce, or weaken a requirement defined by a higher layer.
* **Conflict Resolution**: If two documents conflict, the agent must preserve the stricter requirement and report the conflict.
* **Reports Are Not Authority**: `./report.md` and chat outputs are evidence ledgers, NEVER authoritative sources of truth. The repository state is the sole source of truth.

---

## 2. Mandatory Master Execution Contract

All agent operations are governed by the 32 sections of:
`docs/migration/ANTIGRAVITY-MASTER-EXECUTION-CONTRACT.md`

### Core Tenets:
1. **Repository State as Source of Truth**:
   ```text
   UNKNOWN     != COMPLETE
   PARTIAL     != COMPLETE
   CONTRACTED  != IMPLEMENTED
   IMPLEMENTED != TESTED
   TESTED      != CERTIFIED
   LOCAL       != REMOTE
   DOCUMENTED  != EXECUTED
   DECLARED    != VERIFIED
   GREEN CI    != FULL COMPATIBILITY
   FILE EXISTS != CAPABILITY WORKS
   ```
2. **Quality Precedence**:
   $$\text{Security / Correctness} > \text{Evidence Truthfulness} > \text{Durability / Recovery} > \text{Compatibility} > \text{Performance} > \text{Delivery Speed}$$
   Time pressure, token budgets, or agent capacity must NEVER be used to lower the quality floor.
3. **No Premature Completion**:
   The only defensible terminal states are: `COMPLETE`, `BLOCKED`, or `FAILED`.
4. **No Certification Self-Awarded**:
   Agents are implementers and evidence collectors. Final certification belongs strictly to independent review (Maintainer / Human).
5. **No Architectural Shortcuts**:
   Forbidden: placeholders called production, empty folders called migration, direct private cross-sublego imports, god modules, silent fallbacks from durable to in-memory, or disabled/weakened tests.

---

## 3. Mandatory Sub-Agent Result Protocol

Every sub-agent invoked via `invoke_subagent` MUST report its execution results using the following rigid, parseable format. The Coordinator MUST reject any sub-agent output that does not conform to this structure:

```text
SUB-AGENT RESULT
STATUS: <COMPLETE | PARTIAL | BLOCKED | FAILED | NOT VERIFIED>
TASK: <Exact delegated task description>
SCOPE: <Exact subsystem, Sub-LEGO id, or directories affected>
FILES: <List of added, modified, or deleted files>
TESTS: <Exact commands run>
EXIT CODES: <List of test exit codes>
COMMIT: <Local or remote commit SHA where changes reside>
LOCAL/REMOTE: <LOCAL | REMOTE>
EVIDENCE: <Key facts, invariant outputs, or benchmark numbers observed>
REMAINING: <Explicit remaining work in assigned scope>
UNVERIFIED: <Explicit list of invariants or behaviors NOT yet verified>
BLOCKERS: <Concrete blockers encountered, or NONE>
CHECKPOINT: <State description enabling safe resumption if interrupted>
```

The Coordinator MUST NOT accept vague conversational summaries (e.g. *"Done"*, *"Implemented"*, *"Tests passed"*) as proof of completion.

---

## 4. Sub-Agent Lifecycle & Fault Tolerance

1. **Parent Failure ≠ Cancel Sub-Agents**:
   The parent coordinator must not arbitrarily terminate sub-agents due to parent context changes or tool failures.
2. **Interruption vs Completion**:
   If an infrastructure error or timeout forces cancellation, the event MUST be reported as an **execution interruption**, not completion.
3. **Recovery First**:
   On sub-agent failure, capture the failure, preserve working state, inspect git status, retry safely, and resume from the last verified checkpoint.

---

## 5. Scope & Repository Boundaries

* **Authorized Target**: `Catzpro01/n8n-lego-rust-v1` (`origin`)
* **Read-Only Oracle**: `Catzpro01/n8n-rust-v.4` (`upstream-v4`)
* **Forbidden to Touch**: `Catzpro01/n8nrustv.4`
* **Target Architecture**:
  * 11 LEGOs (`L00`–`L11`), 83 stable Sub-LEGOs (`Lxx.Syy`).
  * 7 Runtime Hosts (`H01`–`H07`).
  * Transport-neutral typed Ports with fail-closed Security Context.
  * 0 private cross-Sub-LEGO imports in `lego/`.
