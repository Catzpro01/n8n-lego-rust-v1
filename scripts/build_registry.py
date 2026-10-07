"""
Script to build and validate the canonical machine-readable 83 Sub-LEGO registry.
Produces: docs/migration/LEGO-SUBLEGO-REGISTRY.yaml
"""
import yaml
import json
import os

SUBLEGOS_DATA = [
    # L00 Foundation
    {
        "id": "L00.S01", "lego": "L00", "sub": "S01", "name": "Runtime contracts",
        "lego_name": "Foundation", "lego_slug": "L00-foundation", "sub_slug": "S01-runtime-contracts",
        "ownership": "runtime-core", "execution_model": "contract-only", "runtime_host": "H02",
        "state_ownership": "stateless", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.runtime.contract.envelope.v1", "port.runtime.contract.negotiate.v1"],
        "required_ports": []
    },
    {
        "id": "L00.S02", "lego": "L00", "sub": "S02", "name": "Runtime registry",
        "lego_name": "Foundation", "lego_slug": "L00-foundation", "sub_slug": "S02-runtime-registry",
        "ownership": "runtime-core", "execution_model": "in-process", "runtime_host": "H02",
        "state_ownership": "runtime-registry-state", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.runtime.registry.lookup.v1", "port.runtime.registry.register.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L00.S03", "lego": "L00", "sub": "S03", "name": "Policy and resource budgets",
        "lego_name": "Foundation", "lego_slug": "L00-foundation", "sub_slug": "S03-policy-resource-budgets",
        "ownership": "runtime-core", "execution_model": "in-process", "runtime_host": "H02",
        "state_ownership": "policy-budget-store", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.runtime.policy.check.v1", "port.runtime.budget.allocate.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L00.S04", "lego": "L00", "sub": "S04", "name": "Health and lifecycle",
        "lego_name": "Foundation", "lego_slug": "L00-foundation", "sub_slug": "S04-health-lifecycle",
        "ownership": "runtime-core", "execution_model": "in-process", "runtime_host": "H02",
        "state_ownership": "lifecycle-state", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.runtime.lifecycle.probe.v1", "port.runtime.lifecycle.quarantine.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },

    # L01 Execution
    {
        "id": "L01.S01", "lego": "L01", "sub": "S01", "name": "Execution semantics",
        "lego_name": "Execution", "lego_slug": "L01-execution", "sub_slug": "S01-execution-semantics",
        "ownership": "execution-engine", "execution_model": "in-process", "runtime_host": "H03",
        "state_ownership": "workflow-execution-frames", "contract_version": "1.0.0", "compatibility_policy": "rolling-dual-version",
        "status": "TESTED",
        "provided_ports": ["port.execution.run.workflow.v1", "port.execution.cancel.workflow.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1", "port.runtime.budget.allocate.v1", "port.node.execute.invoke.v1", "port.storage.wal.append.v1"]
    },
    {
        "id": "L01.S02", "lego": "L01", "sub": "S02", "name": "Graph Evaluation Engine",
        "lego_name": "Execution", "lego_slug": "L01-execution", "sub_slug": "S02-graph-evaluation-engine",
        "ownership": "execution-engine", "execution_model": "in-process", "runtime_host": "H03",
        "state_ownership": "graph-evaluation-index", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.execution.graph.evaluate.v1", "port.execution.node.status.v1", "port.execution.wait.suspend.v1", "port.execution.wait.resume.v1"],
        "required_ports": ["port.execution.run.workflow.v1", "port.storage.wal.append.v1"]
    },
    {
        "id": "L01.S03", "lego": "L01", "sub": "S03", "name": "Sub-workflows",
        "lego_name": "Execution", "lego_slug": "L01-execution", "sub_slug": "S03-subworkflows",
        "ownership": "execution-engine", "execution_model": "in-process", "runtime_host": "H03",
        "state_ownership": "subworkflow-call-hierarchy", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.execution.subworkflow.invoke.v1"],
        "required_ports": ["port.execution.run.workflow.v1", "port.runtime.budget.allocate.v1"]
    },
    {
        "id": "L01.S04", "lego": "L01", "sub": "S04", "name": "Checkpoint and crash recovery",
        "lego_name": "Execution", "lego_slug": "L01-execution", "sub_slug": "S04-checkpoint-recovery",
        "ownership": "execution-engine", "execution_model": "stateful-component", "runtime_host": "H03",
        "state_ownership": "execution-checkpoint-index", "contract_version": "1.0.0", "compatibility_policy": "rolling-dual-version",
        "status": "TESTED",
        "provided_ports": ["port.execution.checkpoint.save.v1", "port.execution.recovery.replay.v1"],
        "required_ports": ["port.storage.wal.append.v1", "port.storage.wal.read.v1"]
    },
    {
        "id": "L01.S05", "lego": "L01", "sub": "S05", "name": "Unlimited/lazy workflow graph",
        "lego_name": "Execution", "lego_slug": "L01-execution", "sub_slug": "S05-unlimited-lazy-graph",
        "ownership": "execution-engine", "execution_model": "in-process", "runtime_host": "H03",
        "state_ownership": "lazy-graph-frontier", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.execution.graph.expand_frontier.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1", "port.runtime.budget.allocate.v1"]
    },
    {
        "id": "L01.S06", "lego": "L01", "sub": "S06", "name": "Compatibility oracle",
        "lego_name": "Execution", "lego_slug": "L01-execution", "sub_slug": "S06-compatibility-oracle",
        "ownership": "execution-engine", "execution_model": "tooling", "runtime_host": "H07",
        "state_ownership": "golden-differential-corpus", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.execution.oracle.verify.v1"],
        "required_ports": ["port.execution.run.workflow.v1"]
    },

    # L02 Security
    {
        "id": "L02.S01", "lego": "L02", "sub": "S01", "name": "Principal and security context",
        "lego_name": "Security", "lego_slug": "L02-security", "sub_slug": "S01-principal-security-context",
        "ownership": "security-kernel", "execution_model": "in-process", "runtime_host": "H02",
        "state_ownership": "stateless", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.security.context.create.v1", "port.security.context.validate.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L02.S02", "lego": "L02", "sub": "S02", "name": "Session lifecycle",
        "lego_name": "Security", "lego_slug": "L02-security", "sub_slug": "S02-session-lifecycle",
        "ownership": "security-kernel", "execution_model": "stateful-component", "runtime_host": "H02",
        "state_ownership": "session-state-cache", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.security.session.create.v1", "port.security.session.validate.v1", "port.security.session.revoke.v1"],
        "required_ports": ["port.security.context.validate.v1"]
    },
    {
        "id": "L02.S03", "lego": "L02", "sub": "S03", "name": "Authorization",
        "lego_name": "Security", "lego_slug": "L02-security", "sub_slug": "S03-authorization",
        "ownership": "security-kernel", "execution_model": "in-process", "runtime_host": "H02",
        "state_ownership": "authz-policy-cache", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.security.authz.authorize.v1"],
        "required_ports": ["port.security.context.validate.v1"]
    },
    {
        "id": "L02.S04", "lego": "L02", "sub": "S04", "name": "Credential broker",
        "lego_name": "Security", "lego_slug": "L02-security", "sub_slug": "S04-credential-broker",
        "ownership": "security-kernel", "execution_model": "stateful-component", "runtime_host": "H02",
        "state_ownership": "vault-secret-references", "contract_version": "1.0.0", "compatibility_policy": "rolling-dual-version",
        "status": "TESTED",
        "provided_ports": ["port.security.credential.release.v1", "port.security.credential.store.v1"],
        "required_ports": ["port.security.authz.authorize.v1", "port.security.crypto.encrypt.v1"]
    },
    {
        "id": "L02.S05", "lego": "L02", "sub": "S05", "name": "Cryptography and key lifecycle",
        "lego_name": "Security", "lego_slug": "L02-security", "sub_slug": "S05-cryptography-key-lifecycle",
        "ownership": "security-kernel", "execution_model": "in-process", "runtime_host": "H02",
        "state_ownership": "master-key-manifest", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.security.crypto.encrypt.v1", "port.security.crypto.decrypt.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L02.S06", "lego": "L02", "sub": "S06", "name": "Machine identity",
        "lego_name": "Security", "lego_slug": "L02-security", "sub_slug": "S06-machine-identity",
        "ownership": "security-kernel", "execution_model": "stateful-component", "runtime_host": "H02",
        "state_ownership": "machine-identity-keystore", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.security.machine.token.v1", "port.security.machine.authenticate.v1"],
        "required_ports": ["port.security.context.create.v1"]
    },
    {
        "id": "L02.S07", "lego": "L02", "sub": "S07", "name": "Password/MFA recovery",
        "lego_name": "Security", "lego_slug": "L02-security", "sub_slug": "S07-password-mfa-recovery",
        "ownership": "security-kernel", "execution_model": "stateful-component", "runtime_host": "H02",
        "state_ownership": "credential-recovery-tokens", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.security.recovery.initiate.v1", "port.security.mfa.verify.v1"],
        "required_ports": ["port.security.authz.authorize.v1"]
    },

    # L03 Ingress
    {
        "id": "L03.S01", "lego": "L03", "sub": "S01", "name": "Webhook routing",
        "lego_name": "Ingress", "lego_slug": "L03-ingress", "sub_slug": "S01-webhook-routing",
        "ownership": "ingress-gateway", "execution_model": "in-process", "runtime_host": "H01",
        "state_ownership": "webhook-route-table", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.ingress.webhook.receive.v1"],
        "required_ports": ["port.ingress.admission.filter.v1", "port.ingress.dedup.check.v1", "port.execution.run.workflow.v1"]
    },
    {
        "id": "L03.S02", "lego": "L03", "sub": "S02", "name": "Activation state machine",
        "lego_name": "Ingress", "lego_slug": "L03-ingress", "sub_slug": "S02-activation-state-machine",
        "ownership": "ingress-gateway", "execution_model": "control-component", "runtime_host": "H02",
        "state_ownership": "active-triggers-registry", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.ingress.activation.toggle.v1", "port.ingress.activation.list.v1"],
        "required_ports": ["port.security.authz.authorize.v1"]
    },
    {
        "id": "L03.S03", "lego": "L03", "sub": "S03", "name": "Schedule/event/manual/form triggers",
        "lego_name": "Ingress", "lego_slug": "L03-ingress", "sub_slug": "S03-schedule-event-triggers",
        "ownership": "ingress-gateway", "execution_model": "in-process", "runtime_host": "H01",
        "state_ownership": "cron-timer-slots", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.ingress.trigger.dispatch.v1"],
        "required_ports": ["port.execution.run.workflow.v1"]
    },
    {
        "id": "L03.S04", "lego": "L03", "sub": "S04", "name": "Admission and backpressure",
        "lego_name": "Ingress", "lego_slug": "L03-ingress", "sub_slug": "S04-admission-backpressure",
        "ownership": "ingress-gateway", "execution_model": "in-process", "runtime_host": "H01",
        "state_ownership": "rate-limit-buckets", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.ingress.admission.filter.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L03.S05", "lego": "L03", "sub": "S05", "name": "Idempotency/deduplication",
        "lego_name": "Ingress", "lego_slug": "L03-ingress", "sub_slug": "S05-idempotency-deduplication",
        "ownership": "ingress-gateway", "execution_model": "stateful-component", "runtime_host": "H01",
        "state_ownership": "dedup-hash-cache", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.ingress.dedup.check.v1", "port.ingress.idempotency.dedupe.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L03.S06", "lego": "L03", "sub": "S06", "name": "Response plans and streaming payloads",
        "lego_name": "Ingress", "lego_slug": "L03-ingress", "sub_slug": "S06-response-plans-streaming",
        "ownership": "ingress-gateway", "execution_model": "in-process", "runtime_host": "H01",
        "state_ownership": "pending-response-waiters", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.ingress.response.stream.v1", "port.ingress.response.plan.v1"],
        "required_ports": ["port.storage.binary.stream.v1"]
    },
    {
        "id": "L03.S07", "lego": "L03", "sub": "S07", "name": "Startup reconciliation and recovery",
        "lego_name": "Ingress", "lego_slug": "L03-ingress", "sub_slug": "S07-startup-reconciliation",
        "ownership": "ingress-gateway", "execution_model": "control-component", "runtime_host": "H02",
        "state_ownership": "reconciliation-markers", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.ingress.reconcile.execute.v1", "port.ingress.reconciliation.sync.v1"],
        "required_ports": ["port.ingress.activation.list.v1", "port.storage.persistence.load.v1"]
    },

    # L04 Node Ecosystem
    {
        "id": "L04.S01", "lego": "L04", "sub": "S01", "name": "Node registry and admission",
        "lego_name": "Node Ecosystem", "lego_slug": "L04-node-ecosystem", "sub_slug": "S01-node-registry-admission",
        "ownership": "node-ecosystem", "execution_model": "in-process", "runtime_host": "H04",
        "state_ownership": "node-manifest-catalog", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.node.registry.query.v1", "port.node.registry.register.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L04.S02", "lego": "L04", "sub": "S02", "name": "Trust/quarantine/runtime locality",
        "lego_name": "Node Ecosystem", "lego_slug": "L04-node-ecosystem", "sub_slug": "S02-trust-quarantine-locality",
        "ownership": "node-ecosystem", "execution_model": "in-process", "runtime_host": "H04",
        "state_ownership": "node-trust-tiers", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.node.trust.evaluate.v1"],
        "required_ports": ["port.security.authz.authorize.v1"]
    },
    {
        "id": "L04.S03", "lego": "L04", "sub": "S03", "name": "Native Rust node catalog",
        "lego_name": "Node Ecosystem", "lego_slug": "L04-node-ecosystem", "sub_slug": "S03-native-rust-node-catalog",
        "ownership": "node-ecosystem", "execution_model": "library/pure", "runtime_host": "H04",
        "state_ownership": "stateless", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.node.execute.invoke.v1"],
        "required_ports": ["port.security.credential.release.v1", "port.storage.binary.stream.v1"]
    },
    {
        "id": "L04.S04", "lego": "L04", "sub": "S04", "name": "Compatibility worker",
        "lego_name": "Node Ecosystem", "lego_slug": "L04-node-ecosystem", "sub_slug": "S04-compatibility-worker",
        "ownership": "node-ecosystem", "execution_model": "worker-capability", "runtime_host": "H07",
        "state_ownership": "worker-bridge-sessions", "contract_version": "1.0.0", "compatibility_policy": "rolling-dual-version",
        "status": "TESTED",
        "provided_ports": ["port.node.compat.invoke_js.v1"],
        "required_ports": ["port.node.execute.invoke.v1", "port.storage.binary.stream.v1"]
    },
    {
        "id": "L04.S05", "lego": "L04", "sub": "S05", "name": "Community/private/custom node compatibility",
        "lego_name": "Node Ecosystem", "lego_slug": "L04-node-ecosystem", "sub_slug": "S05-community-custom-nodes",
        "ownership": "node-ecosystem", "execution_model": "worker-capability", "runtime_host": "H07",
        "state_ownership": "custom-node-tarballs", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.node.custom.load.v1"],
        "required_ports": ["port.node.trust.evaluate.v1", "port.node.compat.invoke_js.v1"]
    },
    {
        "id": "L04.S06", "lego": "L04", "sub": "S06", "name": "Code/polyglot runtime contracts",
        "lego_name": "Node Ecosystem", "lego_slug": "L04-node-ecosystem", "sub_slug": "S06-code-polyglot-runtime",
        "ownership": "node-ecosystem", "execution_model": "worker-capability", "runtime_host": "H04",
        "state_ownership": "polyglot-isolated-sandbox", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.node.polyglot.execute.v1"],
        "required_ports": ["port.runtime.budget.allocate.v1"]
    },
    {
        "id": "L04.S07", "lego": "L04", "sub": "S07", "name": "Browser/scraper hybrid capability",
        "lego_name": "Node Ecosystem", "lego_slug": "L04-node-ecosystem", "sub_slug": "S07-browser-scraper-hybrid",
        "ownership": "node-ecosystem", "execution_model": "worker-capability", "runtime_host": "H04",
        "state_ownership": "browser-session-pool", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.node.browser.render.v1", "port.node.browser.hybrid.v1"],
        "required_ports": ["port.runtime.budget.allocate.v1"]
    },
    {
        "id": "L04.S08", "lego": "L04", "sub": "S08", "name": "Dynamic parameter/schema runtime",
        "lego_name": "Node Ecosystem", "lego_slug": "L04-node-ecosystem", "sub_slug": "S08-dynamic-parameter-schema",
        "ownership": "node-ecosystem", "execution_model": "in-process", "runtime_host": "H04",
        "state_ownership": "dynamic-schema-cache", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.node.schema.resolve_options.v1"],
        "required_ports": ["port.node.registry.query.v1"]
    },

    # L05 Data and Storage
    {
        "id": "L05.S01", "lego": "L05", "sub": "S01", "name": "Workflow/execution persistence",
        "lego_name": "Data and Storage", "lego_slug": "L05-data-storage", "sub_slug": "S01-workflow-execution-persistence",
        "ownership": "data-persistence", "execution_model": "stateful-component", "runtime_host": "H05",
        "state_ownership": "workflow-metadata-store", "contract_version": "1.0.0", "compatibility_policy": "rolling-dual-version",
        "status": "TESTED",
        "provided_ports": ["port.storage.persistence.save.v1", "port.storage.persistence.load.v1"],
        "required_ports": ["port.security.context.validate.v1"]
    },
    {
        "id": "L05.S02", "lego": "L05", "sub": "S02", "name": "Durable WAL and transactions",
        "lego_name": "Data and Storage", "lego_slug": "L05-data-storage", "sub_slug": "S02-durable-wal-transactions",
        "ownership": "data-persistence", "execution_model": "stateful-component", "runtime_host": "H05",
        "state_ownership": "wal-append-records", "contract_version": "1.0.0", "compatibility_policy": "rolling-dual-version",
        "status": "TESTED",
        "provided_ports": ["port.storage.wal.append.v1", "port.storage.wal.read.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L05.S03", "lego": "L05", "sub": "S03", "name": "Execution data plane",
        "lego_name": "Data and Storage", "lego_slug": "L05-data-storage", "sub_slug": "S03-execution-data-plane",
        "ownership": "data-persistence", "execution_model": "stateful-component", "runtime_host": "H05",
        "state_ownership": "execution-item-blobs", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.storage.dataplane.store_handle.v1", "port.storage.dataplane.read_handle.v1"],
        "required_ports": ["port.runtime.budget.allocate.v1"]
    },
    {
        "id": "L05.S04", "lego": "L05", "sub": "S04", "name": "Binary data and streaming",
        "lego_name": "Data and Storage", "lego_slug": "L05-data-storage", "sub_slug": "S04-binary-data-streaming",
        "ownership": "data-persistence", "execution_model": "stateful-component", "runtime_host": "H05",
        "state_ownership": "blob-filesystem-chunks", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.storage.binary.stream.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L05.S05", "lego": "L05", "sub": "S05", "name": "Retention/compaction",
        "lego_name": "Data and Storage", "lego_slug": "L05-data-storage", "sub_slug": "S05-retention-compaction",
        "ownership": "data-persistence", "execution_model": "control-component", "runtime_host": "H05",
        "state_ownership": "retention-policy-index", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.storage.retention.compact.v1"],
        "required_ports": ["port.storage.persistence.load.v1", "port.storage.wal.read.v1"]
    },
    {
        "id": "L05.S06", "lego": "L05", "sub": "S06", "name": "Snapshot/backup/restore",
        "lego_name": "Data and Storage", "lego_slug": "L05-data-storage", "sub_slug": "S06-snapshot-backup-restore",
        "ownership": "data-persistence", "execution_model": "control-component", "runtime_host": "H05",
        "state_ownership": "backup-snapshot-metadata", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.storage.backup.create.v1", "port.storage.backup.restore.v1", "port.storage.backup.snapshot.v1"],
        "required_ports": ["port.storage.persistence.load.v1"]
    },
    {
        "id": "L05.S07", "lego": "L05", "sub": "S07", "name": "Disaster recovery",
        "lego_name": "Data and Storage", "lego_slug": "L05-data-storage", "sub_slug": "S07-disaster-recovery",
        "ownership": "data-persistence", "execution_model": "control-component", "runtime_host": "H05",
        "state_ownership": "dr-replication-state", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.storage.dr.sync.v1", "port.storage.dr.replicate.v1"],
        "required_ports": ["port.storage.backup.restore.v1"]
    },
    {
        "id": "L05.S08", "lego": "L05", "sub": "S08", "name": "Environment promotion",
        "lego_name": "Data and Storage", "lego_slug": "L05-data-storage", "sub_slug": "S08-environment-promotion",
        "ownership": "data-persistence", "execution_model": "in-process", "runtime_host": "H05",
        "state_ownership": "promotion-manifest-store", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.storage.promotion.export.v1", "port.storage.promotion.import.v1", "port.storage.environment.promote.v1"],
        "required_ports": ["port.storage.persistence.load.v1", "port.security.credential.release.v1"]
    },

    # L06 Realtime and Observability
    {
        "id": "L06.S01", "lego": "L06", "sub": "S01", "name": "Realtime event contract",
        "lego_name": "Realtime and Observability", "lego_slug": "L06-realtime-observability", "sub_slug": "S01-realtime-event-contract",
        "ownership": "observability", "execution_model": "in-process", "runtime_host": "H01",
        "state_ownership": "websocket-active-sockets", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.observability.realtime.publish.v1", "port.observability.realtime.subscribe.v1"],
        "required_ports": ["port.security.context.validate.v1"]
    },
    {
        "id": "L06.S02", "lego": "L06", "sub": "S02", "name": "Execution telemetry",
        "lego_name": "Realtime and Observability", "lego_slug": "L06-realtime-observability", "sub_slug": "S02-execution-telemetry",
        "ownership": "observability", "execution_model": "in-process", "runtime_host": "H03",
        "state_ownership": "telemetry-metrics-ring", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.observability.telemetry.record.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L06.S03", "lego": "L06", "sub": "S03", "name": "Node/plugin/worker diagnostics",
        "lego_name": "Realtime and Observability", "lego_slug": "L06-realtime-observability", "sub_slug": "S03-node-worker-diagnostics",
        "ownership": "observability", "execution_model": "in-process", "runtime_host": "H04",
        "state_ownership": "diagnostics-ring-buffer", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.observability.diagnostics.capture.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L06.S04", "lego": "L06", "sub": "S04", "name": "Health/readiness",
        "lego_name": "Realtime and Observability", "lego_slug": "L06-realtime-observability", "sub_slug": "S04-health-readiness",
        "ownership": "observability", "execution_model": "in-process", "runtime_host": "H02",
        "state_ownership": "system-readiness-map", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.observability.health.check.v1"],
        "required_ports": ["port.runtime.lifecycle.probe.v1"]
    },
    {
        "id": "L06.S05", "lego": "L06", "sub": "S05", "name": "Replay and causal diagnostics",
        "lego_name": "Realtime and Observability", "lego_slug": "L06-realtime-observability", "sub_slug": "S05-replay-causal-diagnostics",
        "ownership": "observability", "execution_model": "stateful-component", "runtime_host": "H03",
        "state_ownership": "causal-trace-index", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.observability.replay.trace.v1"],
        "required_ports": ["port.storage.wal.read.v1"]
    },
    {
        "id": "L06.S06", "lego": "L06", "sub": "S06", "name": "Resource pressure and queue metrics",
        "lego_name": "Realtime and Observability", "lego_slug": "L06-realtime-observability", "sub_slug": "S06-resource-pressure-metrics",
        "ownership": "observability", "execution_model": "in-process", "runtime_host": "H02",
        "state_ownership": "pressure-telemetry-sampler", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.observability.metrics.pressure.v1", "port.observability.pressure.poll.v1"],
        "required_ports": ["port.runtime.budget.allocate.v1"]
    },
    {
        "id": "L06.S07", "lego": "L06", "sub": "S07", "name": "Audit and bounded retention",
        "lego_name": "Realtime and Observability", "lego_slug": "L06-realtime-observability", "sub_slug": "S07-audit-bounded-retention",
        "ownership": "observability", "execution_model": "stateful-component", "runtime_host": "H02",
        "state_ownership": "audit-retention-ledger", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.observability.audit.record.v1", "port.observability.audit.query.v1"],
        "required_ports": ["port.security.context.validate.v1"]
    },

    # L07 Scale and Worker Fabric
    {
        "id": "L07.S01", "lego": "L07", "sub": "S01", "name": "Scheduler/resource intelligence",
        "lego_name": "Scale and Worker Fabric", "lego_slug": "L07-scale-worker-fabric", "sub_slug": "S01-scheduler-resource-intelligence",
        "ownership": "fabric-scale", "execution_model": "control-component", "runtime_host": "H02",
        "state_ownership": "worker-capacity-table", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.scale.scheduler.dispatch.v1"],
        "required_ports": ["port.scale.queue.dequeue.v1"]
    },
    {
        "id": "L07.S02", "lego": "L07", "sub": "S02", "name": "Burst admission and graceful degradation",
        "lego_name": "Scale and Worker Fabric", "lego_slug": "L07-scale-worker-fabric", "sub_slug": "S02-burst-admission-degradation",
        "ownership": "fabric-scale", "execution_model": "in-process", "runtime_host": "H01",
        "state_ownership": "degradation-thresholds", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.scale.admission.throttle.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L07.S03", "lego": "L07", "sub": "S03", "name": "Queue/lease model",
        "lego_name": "Scale and Worker Fabric", "lego_slug": "L07-scale-worker-fabric", "sub_slug": "S03-queue-lease-model",
        "ownership": "fabric-scale", "execution_model": "stateful-component", "runtime_host": "H05",
        "state_ownership": "job-queue-leases", "contract_version": "1.0.0", "compatibility_policy": "rolling-dual-version",
        "status": "TESTED",
        "provided_ports": ["port.scale.queue.enqueue.v1", "port.scale.queue.dequeue.v1", "port.scale.queue.ack.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L07.S04", "lego": "L07", "sub": "S04", "name": "Worker lifecycle",
        "lego_name": "Scale and Worker Fabric", "lego_slug": "L07-scale-worker-fabric", "sub_slug": "S04-worker-lifecycle",
        "ownership": "fabric-scale", "execution_model": "control-component", "runtime_host": "H02",
        "state_ownership": "worker-heartbeat-state", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.scale.worker.register.v1", "port.scale.worker.heartbeat.v1", "port.scale.worker.drain.v1"],
        "required_ports": ["port.runtime.lifecycle.probe.v1"]
    },
    {
        "id": "L07.S05", "lego": "L07", "sub": "S05", "name": "Worker recovery and failover",
        "lego_name": "Scale and Worker Fabric", "lego_slug": "L07-scale-worker-fabric", "sub_slug": "S05-worker-recovery-failover",
        "ownership": "fabric-scale", "execution_model": "control-component", "runtime_host": "H02",
        "state_ownership": "failover-election-state", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.scale.worker.failover.v1", "port.scale.failover.reclaim.v1"],
        "required_ports": ["port.scale.queue.ack.v1", "port.scale.worker.heartbeat.v1"]
    },
    {
        "id": "L07.S06", "lego": "L07", "sub": "S06", "name": "HA control plane",
        "lego_name": "Scale and Worker Fabric", "lego_slug": "L07-scale-worker-fabric", "sub_slug": "S06-ha-control-plane",
        "ownership": "fabric-scale", "execution_model": "control-component", "runtime_host": "H02",
        "state_ownership": "cluster-control-lease", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.scale.ha.election.v1", "port.scale.ha.leader_query.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L07.S07", "lego": "L07", "sub": "S07", "name": "Ingress/runtime efficiency",
        "lego_name": "Scale and Worker Fabric", "lego_slug": "L07-scale-worker-fabric", "sub_slug": "S07-ingress-runtime-efficiency",
        "ownership": "fabric-scale", "execution_model": "in-process", "runtime_host": "H01",
        "state_ownership": "backpressure-tuning-state", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.scale.runtime.tune.v1", "port.scale.efficiency.buffer_pool.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },

    # L08 Agent and MCP
    {
        "id": "L08.S01", "lego": "L08", "sub": "S01", "name": "Agent state machine",
        "lego_name": "Agent and MCP", "lego_slug": "L08-agent-mcp", "sub_slug": "S01-agent-state-machine",
        "ownership": "agent-runtime", "execution_model": "stateful-component", "runtime_host": "H06",
        "state_ownership": "agent-session-state-machine", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.agent.session.execute.v1", "port.agent.engine.run.v1"],
        "required_ports": ["port.agent.tool.invoke.v1", "port.agent.provider.chat.v1", "port.agent.memory.retrieve.v1"]
    },
    {
        "id": "L08.S02", "lego": "L08", "sub": "S02", "name": "Tool registry",
        "lego_name": "Agent and MCP", "lego_slug": "L08-agent-mcp", "sub_slug": "S02-tool-registry",
        "ownership": "agent-runtime", "execution_model": "in-process", "runtime_host": "H06",
        "state_ownership": "mcp-tool-catalog", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.agent.tool.register.v1", "port.agent.tool.invoke.v1"],
        "required_ports": ["port.security.authz.authorize.v1"]
    },
    {
        "id": "L08.S03", "lego": "L08", "sub": "S03", "name": "Workflow-as-tool",
        "lego_name": "Agent and MCP", "lego_slug": "L08-agent-mcp", "sub_slug": "S03-workflow-as-tool",
        "ownership": "agent-runtime", "execution_model": "in-process", "runtime_host": "H06",
        "state_ownership": "workflow-tool-manifests", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.agent.workflow.tool.v1", "port.agent.wf_tool.bridge.v1"],
        "required_ports": ["port.execution.run.workflow.v1", "port.agent.tool.register.v1"]
    },
    {
        "id": "L08.S04", "lego": "L08", "sub": "S04", "name": "Human approval and policy boundary",
        "lego_name": "Agent and MCP", "lego_slug": "L08-agent-mcp", "sub_slug": "S04-human-approval-policy",
        "ownership": "agent-runtime", "execution_model": "stateful-component", "runtime_host": "H06",
        "state_ownership": "human-approval-inbox", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.agent.policy.approve.v1", "port.agent.approval.request.v1", "port.agent.approval.submit.v1"],
        "required_ports": ["port.security.authz.authorize.v1"]
    },
    {
        "id": "L08.S05", "lego": "L08", "sub": "S05", "name": "AI provider routing",
        "lego_name": "Agent and MCP", "lego_slug": "L08-agent-mcp", "sub_slug": "S05-ai-provider-routing",
        "ownership": "agent-runtime", "execution_model": "remote-adapter", "runtime_host": "H06",
        "state_ownership": "provider-routing-table", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.agent.provider.route.v1", "port.agent.provider.chat.v1"],
        "required_ports": ["port.security.credential.release.v1", "port.agent.budget.enforce.v1"]
    },
    {
        "id": "L08.S06", "lego": "L08", "sub": "S06", "name": "Memory",
        "lego_name": "Agent and MCP", "lego_slug": "L08-agent-mcp", "sub_slug": "S06-agent-memory",
        "ownership": "agent-runtime", "execution_model": "stateful-component", "runtime_host": "H06",
        "state_ownership": "conversation-history-chunks", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "CONTRACTED",
        "provided_ports": ["port.agent.memory.store.v1", "port.agent.memory.retrieve.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L08.S07", "lego": "L08", "sub": "S07", "name": "Token/execution budgets",
        "lego_name": "Agent and MCP", "lego_slug": "L08-agent-mcp", "sub_slug": "S07-token-execution-budgets",
        "ownership": "agent-runtime", "execution_model": "in-process", "runtime_host": "H06",
        "state_ownership": "token-consumption-counters", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "CONTRACTED",
        "provided_ports": ["port.agent.budget.enforce.v1"],
        "required_ports": ["port.runtime.budget.allocate.v1"]
    },
    {
        "id": "L08.S08", "lego": "L08", "sub": "S08", "name": "MCP interoperability",
        "lego_name": "Agent and MCP", "lego_slug": "L08-agent-mcp", "sub_slug": "S08-mcp-interoperability",
        "ownership": "agent-runtime", "execution_model": "remote-adapter", "runtime_host": "H06",
        "state_ownership": "mcp-server-processes", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "CONTRACTED",
        "provided_ports": ["port.agent.mcp.connect.v1", "port.agent.mcp.call_tool.v1"],
        "required_ports": ["port.agent.tool.register.v1"]
    },
    {
        "id": "L08.S09", "lego": "L08", "sub": "S09", "name": "Usage accounting and audit",
        "lego_name": "Agent and MCP", "lego_slug": "L08-agent-mcp", "sub_slug": "S09-usage-accounting-audit",
        "ownership": "agent-runtime", "execution_model": "stateful-component", "runtime_host": "H06",
        "state_ownership": "token-audit-records", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "CONTRACTED",
        "provided_ports": ["port.agent.usage.record.v1"],
        "required_ports": ["port.observability.audit.record.v1"]
    },

    # L09 UI and Compatibility
    {
        "id": "L09.S01", "lego": "L09", "sub": "S01", "name": "Official Vue surface compatibility",
        "lego_name": "UI and Compatibility", "lego_slug": "L09-ui-compatibility", "sub_slug": "S01-vue-surface-compatibility",
        "ownership": "ui-compat", "execution_model": "in-process", "runtime_host": "H01",
        "state_ownership": "ui-static-bundle", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.ui.static.serve.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L09.S02", "lego": "L09", "sub": "S02", "name": "REST/API compatibility",
        "lego_name": "UI and Compatibility", "lego_slug": "L09-ui-compatibility", "sub_slug": "S02-rest-api-compatibility",
        "ownership": "ui-compat", "execution_model": "in-process", "runtime_host": "H01",
        "state_ownership": "rest-endpoint-specs", "contract_version": "1.0.0", "compatibility_policy": "rolling-dual-version",
        "status": "TESTED",
        "provided_ports": ["port.ui.rest.dispatch.v1"],
        "required_ports": ["port.storage.persistence.load.v1", "port.execution.run.workflow.v1", "port.security.session.create.v1"]
    },
    {
        "id": "L09.S03", "lego": "L09", "sub": "S03", "name": "Realtime/browser compatibility",
        "lego_name": "UI and Compatibility", "lego_slug": "L09-ui-compatibility", "sub_slug": "S03-browser-realtime-compatibility",
        "ownership": "ui-compat", "execution_model": "in-process", "runtime_host": "H01",
        "state_ownership": "browser-sock-clients", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.ui.browser_sock.stream.v1"],
        "required_ports": ["port.observability.realtime.publish.v1"]
    },
    {
        "id": "L09.S04", "lego": "L09", "sub": "S04", "name": "Notifications/accessibility parity",
        "lego_name": "UI and Compatibility", "lego_slug": "L09-ui-compatibility", "sub_slug": "S04-notifications-accessibility",
        "ownership": "ui-compat", "execution_model": "in-process", "runtime_host": "H01",
        "state_ownership": "ui-banner-notifs", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "CONTRACTED",
        "provided_ports": ["port.ui.notifications.publish.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L09.S05", "lego": "L09", "sub": "S05", "name": "Enterprise-facing compatibility surfaces",
        "lego_name": "UI and Compatibility", "lego_slug": "L09-ui-compatibility", "sub_slug": "S05-enterprise-compatibility-surfaces",
        "ownership": "ui-compat", "execution_model": "in-process", "runtime_host": "H01",
        "state_ownership": "enterprise-license-claims", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "TESTED",
        "provided_ports": ["port.ui.enterprise.features.v1"],
        "required_ports": ["port.security.authz.authorize.v1"]
    },
    {
        "id": "L09.S06", "lego": "L09", "sub": "S06", "name": "Frontend migration/decommission plan",
        "lego_name": "UI and Compatibility", "lego_slug": "L09-ui-compatibility", "sub_slug": "S06-frontend-migration-decommission",
        "ownership": "ui-compat", "execution_model": "contract-only", "runtime_host": "H07",
        "state_ownership": "decommission-milestones", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "CONTRACTED",
        "provided_ports": ["port.ui.decommission.audit.v1"],
        "required_ports": []
    },

    # L10 Release and Upgrade
    {
        "id": "L10.S01", "lego": "L10", "sub": "S01", "name": "Installation/packaging",
        "lego_name": "Release and Upgrade", "lego_slug": "L10-release-upgrade", "sub_slug": "S01-installation-packaging",
        "ownership": "release-lifecycle", "execution_model": "tooling", "runtime_host": "H01",
        "state_ownership": "package-artifacts", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "CONTRACTED",
        "provided_ports": ["port.release.packaging.build.v1"],
        "required_ports": []
    },
    {
        "id": "L10.S02", "lego": "L10", "sub": "S02", "name": "Database/schema migrations",
        "lego_name": "Release and Upgrade", "lego_slug": "L10-release-upgrade", "sub_slug": "S02-database-schema-migrations",
        "ownership": "release-lifecycle", "execution_model": "tooling", "runtime_host": "H05",
        "state_ownership": "migration-version-ledger", "contract_version": "1.0.0", "compatibility_policy": "rolling-dual-version",
        "status": "TESTED",
        "provided_ports": ["port.release.migration.apply.v1"],
        "required_ports": ["port.storage.persistence.save.v1"]
    },
    {
        "id": "L10.S03", "lego": "L10", "sub": "S03", "name": "Runtime/node compatibility matrix",
        "lego_name": "Release and Upgrade", "lego_slug": "L10-release-upgrade", "sub_slug": "S03-node-compat-matrix",
        "ownership": "release-lifecycle", "execution_model": "tooling", "runtime_host": "H07",
        "state_ownership": "compat-matrix-rules", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "CONTRACTED",
        "provided_ports": ["port.release.compat_matrix.evaluate.v1"],
        "required_ports": ["port.node.registry.query.v1"]
    },
    {
        "id": "L10.S04", "lego": "L10", "sub": "S04", "name": "Upgrade/rollback",
        "lego_name": "Release and Upgrade", "lego_slug": "L10-release-upgrade", "sub_slug": "S04-upgrade-rollback",
        "ownership": "release-lifecycle", "execution_model": "control-component", "runtime_host": "H02",
        "state_ownership": "upgrade-stage-offsets", "contract_version": "1.0.0", "compatibility_policy": "rolling-dual-version",
        "status": "CONTRACTED",
        "provided_ports": ["port.release.lifecycle.upgrade_step.v1", "port.release.lifecycle.rollback_step.v1"],
        "required_ports": ["port.release.migration.apply.v1", "port.scale.worker.drain.v1"]
    },
    {
        "id": "L10.S05", "lego": "L10", "sub": "S05", "name": "Release certification",
        "lego_name": "Release and Upgrade", "lego_slug": "L10-release-upgrade", "sub_slug": "S05-release-certification",
        "ownership": "release-lifecycle", "execution_model": "tooling", "runtime_host": "H02",
        "state_ownership": "certification-test-results", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "CONTRACTED",
        "provided_ports": ["port.release.certify.run_gates.v1"],
        "required_ports": ["port.observability.health.check.v1"]
    },
    {
        "id": "L10.S06", "lego": "L10", "sub": "S06", "name": "Security/performance certification",
        "lego_name": "Release and Upgrade", "lego_slug": "L10-release-upgrade", "sub_slug": "S06-security-perf-certification",
        "ownership": "release-lifecycle", "execution_model": "tooling", "runtime_host": "H02",
        "state_ownership": "benchmark-audit-traces", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "CONTRACTED",
        "provided_ports": ["port.release.security_audit.scan.v1"],
        "required_ports": ["port.security.authz.authorize.v1"]
    },

    # L11 Future Platform
    {
        "id": "L11.S01", "lego": "L11", "sub": "S01", "name": "Event/automation control plane",
        "lego_name": "Future Platform", "lego_slug": "L11-future-platform", "sub_slug": "S01-event-automation-control",
        "ownership": "platform-future", "execution_model": "control-component", "runtime_host": "H02",
        "state_ownership": "event-control-bus", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "DESIGNED",
        "provided_ports": ["port.future.event_bus.publish.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L11.S02", "lego": "L11", "sub": "S02", "name": "Execution side-effect reliability",
        "lego_name": "Future Platform", "lego_slug": "L11-future-platform", "sub_slug": "S02-execution-side-effect-reliability",
        "ownership": "platform-future", "execution_model": "stateful-component", "runtime_host": "H03",
        "state_ownership": "side-effect-outbox", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "DESIGNED",
        "provided_ports": ["port.future.side_effect.record.v1"],
        "required_ports": ["port.storage.wal.append.v1"]
    },
    {
        "id": "L11.S03", "lego": "L11", "sub": "S03", "name": "Advanced scheduler/resource intelligence",
        "lego_name": "Future Platform", "lego_slug": "L11-future-platform", "sub_slug": "S03-advanced-scheduler-intelligence",
        "ownership": "platform-future", "execution_model": "control-component", "runtime_host": "H02",
        "state_ownership": "ml-resource-heuristics", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "DESIGNED",
        "provided_ports": ["port.future.smart_schedule.plan.v1"],
        "required_ports": ["port.scale.scheduler.dispatch.v1"]
    },
    {
        "id": "L11.S04", "lego": "L11", "sub": "S04", "name": "Worker/distributed execution extensions",
        "lego_name": "Future Platform", "lego_slug": "L11-future-platform", "sub_slug": "S04-worker-distributed-extensions",
        "ownership": "platform-future", "execution_model": "worker-capability", "runtime_host": "H04",
        "state_ownership": "mesh-worker-leases", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "DESIGNED",
        "provided_ports": ["port.future.cluster.dispatch.v1"],
        "required_ports": ["port.scale.worker.register.v1"]
    },
    {
        "id": "L11.S05", "lego": "L11", "sub": "S05", "name": "Storage lifecycle/DR extensions",
        "lego_name": "Future Platform", "lego_slug": "L11-future-platform", "sub_slug": "S05-storage-lifecycle-dr-extensions",
        "ownership": "platform-future", "execution_model": "control-component", "runtime_host": "H05",
        "state_ownership": "cold-archive-tiers", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "DESIGNED",
        "provided_ports": ["port.future.cold_archive.store.v1"],
        "required_ports": ["port.storage.backup.create.v1"]
    },
    {
        "id": "L11.S06", "lego": "L11", "sub": "S06", "name": "Operator/edge control plane",
        "lego_name": "Future Platform", "lego_slug": "L11-future-platform", "sub_slug": "S06-operator-edge-control-plane",
        "ownership": "platform-future", "execution_model": "control-component", "runtime_host": "H01",
        "state_ownership": "edge-cluster-nodes", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "DESIGNED",
        "provided_ports": ["port.future.edge.sync.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L11.S07", "lego": "L11", "sub": "S07", "name": "Ecosystem interoperability",
        "lego_name": "Future Platform", "lego_slug": "L11-future-platform", "sub_slug": "S07-ecosystem-interoperability",
        "ownership": "platform-future", "execution_model": "library/pure", "runtime_host": "H07",
        "state_ownership": "stateless", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "DESIGNED",
        "provided_ports": ["port.future.ecosystem.convert.v1"],
        "required_ports": ["port.runtime.contract.envelope.v1"]
    },
    {
        "id": "L11.S08", "lego": "L11", "sub": "S08", "name": "Advanced Agent/AI optimization",
        "lego_name": "Future Platform", "lego_slug": "L11-future-platform", "sub_slug": "S08-advanced-agent-ai-optimization",
        "ownership": "platform-future", "execution_model": "in-process", "runtime_host": "H06",
        "state_ownership": "prompt-cache-mesh", "contract_version": "1.0.0", "compatibility_policy": "semver-additive",
        "status": "DESIGNED",
        "provided_ports": ["port.future.speculative_llm.predict.v1"],
        "required_ports": ["port.agent.engine.run.v1"]
    }
]

def main():
    assert len(SUBLEGOS_DATA) == 83, f"Expected 83 Sub-LEGOs, got {len(SUBLEGOS_DATA)}"
    
    # Enforce staged taxonomy invariants:
    # Ladder: DESIGNED -> CONTRACTED -> IMPLEMENTED -> TESTED -> CERTIFIED
    valid_statuses = {"DESIGNED", "CONTRACTED", "IMPLEMENTED", "TESTED", "CERTIFIED"}
    status_counts = {s: 0 for s in valid_statuses}
    for item in SUBLEGOS_DATA:
        st = item["status"]
        assert st in valid_statuses, f"Invalid status {st} in Sub-LEGO {item['id']}"
        status_counts[st] += 1

    assert status_counts["CERTIFIED"] == 0, f"Overclaim: expected 0 CERTIFIED, got {status_counts['CERTIFIED']}"
    assert status_counts["TESTED"] == 64, f"Expected 64 TESTED, got {status_counts['TESTED']}"
    assert status_counts["IMPLEMENTED"] == 0, f"Expected 0 IMPLEMENTED, got {status_counts['IMPLEMENTED']}"
    assert status_counts["CONTRACTED"] == 11, f"Expected 11 CONTRACTED, got {status_counts['CONTRACTED']}"
    assert status_counts["DESIGNED"] == 8, f"Expected 8 DESIGNED, got {status_counts['DESIGNED']}"

    priority_tested = {
        'L00.S01', 'L00.S02', 'L00.S03', 'L00.S04',
        'L01.S01', 'L01.S02', 'L01.S03', 'L01.S04', 'L01.S05', 'L01.S06',
        'L02.S01', 'L02.S02', 'L02.S03', 'L02.S04', 'L02.S05', 'L02.S06', 'L02.S07',
        'L03.S01', 'L03.S02', 'L03.S03', 'L03.S04', 'L03.S05', 'L03.S06', 'L03.S07',
        'L04.S01', 'L04.S02', 'L04.S03', 'L04.S04', 'L04.S05', 'L04.S06', 'L04.S07', 'L04.S08',
        'L05.S01', 'L05.S02', 'L05.S03', 'L05.S04', 'L05.S05', 'L05.S06', 'L05.S07', 'L05.S08',
        'L06.S01', 'L06.S02', 'L06.S03', 'L06.S04', 'L06.S05', 'L06.S06', 'L06.S07',
        'L07.S01', 'L07.S02', 'L07.S03', 'L07.S04', 'L07.S05', 'L07.S06', 'L07.S07',
        'L08.S01', 'L08.S02', 'L08.S03', 'L08.S04', 'L08.S05',
        'L09.S01', 'L09.S02', 'L09.S03', 'L09.S05',
        'L10.S02'
    }
    actual_tested = {item['id'] for item in SUBLEGOS_DATA if item['status'] == 'TESTED'}
    assert actual_tested == priority_tested, f"TESTED Sub-LEGOs do not match priority list: {actual_tested ^ priority_tested}"

    # Check all required ports have a provider
    all_provided = set()
    for item in SUBLEGOS_DATA:
        for p in item["provided_ports"]:
            assert p not in all_provided, f"Duplicate provided port: {p}"
            all_provided.add(p)
            
    for item in SUBLEGOS_DATA:
        for req in item["required_ports"]:
            assert req in all_provided, f"Orphan required port {req} in Sub-LEGO {item['id']}"

    # Build hierarchical YAML representation
    legos_dict = {}
    for item in SUBLEGOS_DATA:
        lego_id = item["lego"]
        if lego_id not in legos_dict:
            legos_dict[lego_id] = {
                "name": item["lego_name"],
                "path": f"lego/{item['lego_slug']}",
                "sublegos": {}
            }
        
        sub_id = item["sub"]
        legos_dict[lego_id]["sublegos"][sub_id] = {
            "id": item["id"],
            "name": item["name"],
            "ownership": item["ownership"],
            "canonical_path": f"lego/{item['lego_slug']}/{item['sub_slug']}",
            "execution_model": item["execution_model"],
            "runtime_host": item["runtime_host"],
            "state_ownership": item["state_ownership"],
            "contract_version": item["contract_version"],
            "compatibility_policy": item["compatibility_policy"],
            "status": item["status"],
            "contract_path": f"lego/{item['lego_slug']}/{item['sub_slug']}/CONTRACT.md",
            "ports": {
                "provided": item["provided_ports"],
                "required": item["required_ports"],
                "transport": "contract-defined"
            }
        }

    output_doc = {
        "version": 1,
        "planning_model": "lego-sublego-work-item",
        "path_root": "lego",
        "total_sublegos": len(SUBLEGOS_DATA),
        "rules": {
            "primary_work_item_identity": "sublego:Lxx.Syy",
            "one_file_one_sublego": True,
            "one_sublego_one_capability": True,
            "cross_sublego_private_imports": False,
            "cyclic_sublego_dependencies": False,
            "shared_behavior_in_contracts": False,
            "no_process_per_sublego": True,
            "fail_closed_durable_wal": True
        },
        "runtime_hosts": {
            "H01": {"name": "Gateway Host", "responsibility": "HTTP/UI/realtime ingress"},
            "H02": {"name": "Control Host", "responsibility": "identity, policy, lifecycle, cluster HA"},
            "H03": {"name": "Execution Host", "responsibility": "workflow execution and state machine"},
            "H04": {"name": "Worker Host", "responsibility": "isolated/parallel node execution"},
            "H05": {"name": "Data Host", "responsibility": "durable database, WAL, object storage"},
            "H06": {"name": "Agent Host", "responsibility": "agent, tool, MCP execution"},
            "H07": {"name": "Compatibility Host", "responsibility": "official n8n/Node compatibility adapters"}
        },
        "legos": legos_dict
    }

    yaml_path = os.path.join("docs", "migration", "LEGO-SUBLEGO-REGISTRY.yaml")
    with open(yaml_path, "w", encoding="utf-8") as f:
        yaml.dump(output_doc, f, sort_keys=False, indent=2)

    json_path = os.path.join("docs", "migration", "LEGO-SUBLEGO-REGISTRY.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(output_doc, f, indent=2)

    print(f"Successfully generated {yaml_path} and {json_path} with {len(SUBLEGOS_DATA)} Sub-LEGOs.")

if __name__ == "__main__":
    main()
