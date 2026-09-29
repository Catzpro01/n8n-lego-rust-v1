//! Sub-workflow invocation — task `execution-engine/m2-05-subworkflow-invocation`.
//!
//! Dukungan pemanggilan sub-workflow (node ExecuteWorkflow): runtime memanggil
//! workflow anak melalui [SubworkflowInvoker] dengan dua jaminan acceptance:
//!
//! 1. **Frame context anak terisolasi dari induk** — [isolated_child_context]
//!    membangun `ExecutionContext` baru yang TIDAK berbagi apa pun dengan
//!    induk: `variables` disalin-nol, `static_data`/`credentials`/
//!    `memory_budget`/`cancellation_token` adalah objek segar (bukan `Arc`
//!    yang sama). Pembatalan anak tidak pernah merambat ke induk, dan
//!    anggaran memori anak diukur terpisah.
//! 2. **Payload output anak kembali dengan bersih ke node induk** —
//!    [SubworkflowInvoker::invoke] menyalin item output node terakhir anak
//!    menjadi `Vec<DataRecord>` milik pemanggil (salinan lepas, bukan referensi
//!    buffer anak), dan tidak pernah mencampur item dengan payload induk.
//!
//! Desain berdiri sendiri (seperti `m2-03`/`m8-04`): hanya `WorkflowRunner`
//! yang sudah ada + `ExecutionContext`; wiring minimal di `runtime/mod.rs`.

use crate::runtime::context::ExecutionContext;
use crate::runtime::error::ExecutionError;
use crate::runtime::runner::{WorkflowExecutionResult, WorkflowRunner};
use crate::Workflow;
use n8n_execution_data::{DataRecord, ItemBuffer};
use thiserror::Error;

/// Kegagalan pemanggilan sub-workflow.
#[derive(Debug, Error)]
pub enum SubworkflowError {
    /// Induk sudah dibatalkan sebelum/kena batalkan — panggilan ditolak cepat.
    #[error("parent execution is cancelled; sub-workflow invocation refused")]
    ParentCancelled,
    /// Melebihi batas kedalaman berhenti rekursi (ExecuteWorkflow bersarang).
    #[error("sub-workflow depth {depth} exceeds max {max}")]
    DepthExceeded { depth: u8, max: u8 },
    /// Eksekusi workflow anak gagal; pembungkus asli ikut terbawa.
    #[error("sub-workflow execution failed: {0}")]
    Child(ExecutionError),
}

/// Hasil pemanggilan: payload bersih untuk node induk.
#[derive(Debug)]
pub struct SubworkflowOutcome {
    /// Salinan lepas item output node terakhir anak (urutan pertahankan).
    pub output: Vec<DataRecord>,
    /// Id eksekusi anak (jejak audit; anak = `{parent}/sub/{n}`).
    pub child_execution_id: String,
    /// true bila induk dibatalkan selama anak berjalan — hasil TIDAK dipakai.
    pub parent_cancelled_during_run: bool,
}

/// Bangun frame context anak yang terisolasi penuh dari induk.
/// Setiap `Arc` (static_data, credentials, memory_budget, cancellation_token)
/// dibuat baru — tidak ada struktur yang berbagi dengan parent.
pub fn isolated_child_context(parent: &ExecutionContext, sequence: u64) -> ExecutionContext {
    let child = ExecutionContext::new(
        parent.workflow_id.clone(),
        format!("{}/sub/{}", parent.execution_id, sequence),
    );
    debug_assert!(!std::sync::Arc::ptr_eq(
        &parent.static_data,
        &child.static_data
    ));
    debug_assert!(!std::sync::Arc::ptr_eq(
        &parent.memory_budget,
        &child.memory_budget
    ));
    debug_assert!(!std::sync::Arc::ptr_eq(
        &parent.cancellation_token,
        &child.cancellation_token
    ));
    child
}

/// Pemanggil sub-workflow di atas runner yang sudah ada.
pub struct SubworkflowInvoker {
    runner: WorkflowRunner,
    max_depth: u8,
    /// Penghitung pemanggilan untuk penamaan id anak (urutan, bukan mutu).
    sequence: std::sync::atomic::AtomicU64,
}

impl SubworkflowInvoker {
    pub fn new(runner: WorkflowRunner, max_depth: u8) -> Self {
        Self {
            runner,
            max_depth,
            sequence: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Runner dengan registry node inti (manualTrigger/start/noOp/set).
    pub fn with_core_registry(max_depth: u8) -> Self {
        Self::new(WorkflowRunner::with_core_registry(), max_depth)
    }

    /// Panggil `child_workflow` dengan `payload` sebagai input node akar anak.
    ///
    /// Isolasi dijamin oleh [isolated_child_context]: tidak ada variable,
    /// static_data, kredensial, anggaran, atau token pembatalan induk yang ikut
    /// menyeberang — hanya item payload yang dibawa (dan itu pun sebagai
    /// salinan item).
    pub async fn invoke(
        &self,
        parent: &ExecutionContext,
        child_workflow: &Workflow,
        payload: Vec<DataRecord>,
        depth: u8,
    ) -> Result<SubworkflowOutcome, SubworkflowError> {
        if parent.is_cancelled() {
            return Err(SubworkflowError::ParentCancelled);
        }
        if depth >= self.max_depth {
            return Err(SubworkflowError::DepthExceeded {
                depth,
                max: self.max_depth,
            });
        }

        let seq = self
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let child_ctx = isolated_child_context(parent, seq);

        // Payload -> buffer input anak (konsumsi item, tanpa berbagi referensi).
        let mut initial = ItemBuffer::new();
        for record in payload {
            initial.push(record);
        }

        let result: WorkflowExecutionResult = self
            .runner
            .run(child_workflow, &child_ctx, Some(initial))
            .await
            .map_err(SubworkflowError::Child)?;

        // Salinan lepas output terakhir anak — kembali bersih ke pemanggil.
        let output: Vec<DataRecord> = result
            .last_node_output()
            .map(|buf| buf.iter().cloned().collect())
            .unwrap_or_default();

        Ok(SubworkflowOutcome {
            output,
            child_execution_id: child_ctx.execution_id.clone(),
            parent_cancelled_during_run: parent.is_cancelled(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::context::MemoryBudget;
    use crate::{Connections, NodeOutputs, OrderedMap};
    use n8n_node_model::INode;
    use serde_json::json;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    fn node(name: &str, node_type: &str) -> INode {
        INode {
            id: name.to_string(),
            name: name.to_string(),
            node_type: node_type.to_string(),
            type_version: 1.0,
            position: [0.0, 0.0],
            parameters: Default::default(),
            disabled: Some(false),
            extra: Default::default(),
        }
    }

    /// Anak tunggal: manualTrigger (PassThrough) — output = input.
    fn passthrough_child() -> Workflow {
        let mut connections: Connections = OrderedMap::new();
        let mut outputs: NodeOutputs = OrderedMap::new();
        outputs.insert("main".to_string(), vec![None]);
        connections.insert("ChildStart".to_string(), outputs);
        Workflow::new(
            Some("child-wf".to_string()),
            Some("Child".to_string()),
            vec![node("ChildStart", "n8n-nodes-base.manualTrigger")],
            connections,
            true,
            None,
            None,
            None,
        )
    }

    fn records(vals: &[u64]) -> Vec<DataRecord> {
        vals.iter()
            .map(|v| DataRecord::new(json!({"v": v})))
            .collect()
    }

    fn vals(rs: &[DataRecord]) -> Vec<u64> {
        rs.iter().map(|r| r.json["v"].as_u64().unwrap()).collect()
    }

    #[test]
    fn test_child_context_fully_isolated_from_parent() {
        // Acceptance 1: frame context anak terisolasi dari induk.
        let mut parent = ExecutionContext::new("wf", "exec-1");
        parent.variables.insert("secret".into(), json!("token"));
        parent
            .static_data
            .write()
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("counter".into(), json!(7));
        parent.memory_budget = Arc::new(MemoryBudget::new(100));
        parent.memory_budget.allocate(60).unwrap();
        parent
            .cancellation_token
            .store(false, std::sync::atomic::Ordering::SeqCst);

        let child = isolated_child_context(&parent, 0);

        // Variabel anak kosong — rahasia induk tidak menyeberang.
        assert!(child.variables.is_empty());
        // Setiap Arc segar (bukan objek yang sama).
        assert!(!Arc::ptr_eq(&parent.static_data, &child.static_data));
        assert!(!Arc::ptr_eq(&parent.memory_budget, &child.memory_budget));
        assert!(!Arc::ptr_eq(
            &parent.cancellation_token,
            &child.cancellation_token
        ));
        assert!(!Arc::ptr_eq(&parent.credentials, &child.credentials));

        // Id anak berbasis induk (jejak), bukan id induk identik.
        assert_ne!(child.execution_id, parent.execution_id);
        assert!(child.execution_id.starts_with("exec-1/sub/"));

        // Pembatalan anak TIDAK merambat ke induk.
        child.cancel();
        assert!(!parent.is_cancelled());
        // Induk yang dibatalkan TIDAK membuat konteks anak baru ikut ter-cancel
        // (token selalu segar — isolasi dua arah).
        parent.cancel();
        assert!(parent.is_cancelled());
        assert!(!isolated_child_context(&parent, 99).is_cancelled());
    }

    #[test]
    fn test_parent_budget_usage_not_shared_with_child() {
        let mut parent = ExecutionContext::new("wf", "exec-2");
        parent.memory_budget = Arc::new(MemoryBudget::new(100));
        parent.memory_budget.allocate(80).unwrap();
        let child = isolated_child_context(&parent, 1);
        // Anggaran anak mulai dari nol (terisolasi), induk tetap 80.
        assert_eq!(child.memory_budget.current_usage(), 0);
        assert_eq!(parent.memory_budget.current_usage(), 80);
    }

    #[tokio::test]
    async fn test_payload_returns_cleanly_to_parent() {
        // Acceptance 2: payload output anak kembali bersih ke node induk.
        let invoker = SubworkflowInvoker::with_core_registry(3);
        let parent = ExecutionContext::new("wf", "exec-3");
        let payload = records(&[1, 2, 3]);

        let outcome = invoker
            .invoke(&parent, &passthrough_child(), payload, 0)
            .await
            .expect("invoke ok");

        // PassThrough: keluaran identik masukan; salinan lepas & berurutan.
        assert_eq!(vals(&outcome.output), vec![1, 2, 3]);
        assert!(outcome.child_execution_id.starts_with("exec-3/sub/"));
        assert!(!outcome.parent_cancelled_during_run);
        // Induk tidak terpengaruh (payload sudah dikonsumsi pemanggil).
        assert!(parent.variables.is_empty());
        assert!(!parent.is_cancelled());
    }

    #[tokio::test]
    async fn test_parent_cancel_refuses_invocation() {
        let invoker = SubworkflowInvoker::with_core_registry(3);
        let parent = ExecutionContext::new("wf", "exec-4");
        parent.cancel();
        let err = invoker
            .invoke(&parent, &passthrough_child(), vec![], 0)
            .await
            .unwrap_err();
        assert!(matches!(err, SubworkflowError::ParentCancelled));
    }

    #[test]
    fn test_depth_guard() {
        let invoker = SubworkflowInvoker::with_core_registry(2);
        let parent = ExecutionContext::new("wf", "exec-5");
        // depth == max -> tolak (tanpa async: guard di depan).
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(invoker.invoke(&parent, &passthrough_child(), vec![], 2));
        assert!(matches!(
            err,
            Err(SubworkflowError::DepthExceeded { depth: 2, max: 2 })
        ));
        // depth < max diterima (lanjut ke eksekusi).
        let err = rt.block_on(invoker.invoke(&parent, &passthrough_child(), vec![], 1));
        assert!(err.is_ok());
    }

    #[tokio::test]
    async fn test_child_failure_propagates_wrapped() {
        let invoker = SubworkflowInvoker::with_core_registry(3);
        let parent = ExecutionContext::new("wf", "exec-6");
        // Node bertipe tak dikenal registry -> ExecutorNotFound dari runner.
        let mut connections: Connections = OrderedMap::new();
        let mut outputs: NodeOutputs = OrderedMap::new();
        outputs.insert("main".to_string(), vec![None]);
        connections.insert("Mystery".to_string(), outputs);
        let child = Workflow::new(
            Some("child-bad".to_string()),
            Some("Bad".to_string()),
            vec![node("Mystery", "n8n-nodes-base.doesNotExist")],
            connections,
            true,
            None,
            None,
            None,
        );
        let err = invoker
            .invoke(&parent, &child, vec![], 0)
            .await
            .unwrap_err();
        match err {
            SubworkflowError::Child(ExecutionError::ExecutorNotFound(t)) => {
                assert_eq!(t, "n8n-nodes-base.doesNotExist");
            }
            other => panic!("expected Child(ExecutorNotFound), got {:?}", other),
        }
        // Kegagalan anak tidak membatalkan induk.
        assert!(!parent.is_cancelled());
    }

    #[test]
    fn test_isolated_context_keeps_static_data_independent() {
        let parent = ExecutionContext::new("wf", "exec-7");
        parent
            .static_data
            .write()
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("runs".into(), json!(1));
        let child = isolated_child_context(&parent, 3);
        // Anak menulis static_data sendiri.
        child
            .static_data
            .write()
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("runs".into(), json!(999));
        // Induk tidak berubah.
        assert_eq!(parent.static_data.read().unwrap()["runs"], json!(1));
        // Token pembatalan juga objek berbeda (bukti non-share).
        let _parent_token: &Arc<AtomicBool> = &parent.cancellation_token;
    }
}
