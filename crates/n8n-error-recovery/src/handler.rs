//! Error Trigger Dispatcher (LEGO `error-recovery`).
//!
//! Bertanggung jawab memetakan kegagalan node atau workflow ke workflow penangan
//! error (`Error Trigger Workflow` n8n):
//! - Registrasi relasi workflow sumber -> workflow penangan error.
//! - Normalisasi payload kegagalan ke format standar n8n `errorTrigger`.
//! - Asynchronous event dispatching dan kanal notifikasi.
//! - Global fallback error handler.

use chrono::{DateTime, Utc};
use n8n_common::INodeExecutionData;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use tokio::sync::broadcast;
use uuid::Uuid;

/// Informasi detail kegagalan node atau workflow.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowErrorPayload {
    /// ID eksekusi yang mengalami kegagalan.
    pub execution_id: String,
    /// ID workflow yang gagal.
    pub workflow_id: String,
    /// Nama workflow yang gagal (jika diketahui).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_name: Option<String>,
    /// Nama node yang menyebabkan kegagalan.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_node_name: Option<String>,
    /// Tipe node yang menyebabkan kegagalan (cth: `n8n-nodes-base.httpRequest`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_node_type: Option<String>,
    /// Pesan kesalahan utama.
    pub error_message: String,
    /// Stack trace kesalahan (jika ada).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_stack: Option<String>,
    /// Detail atau metadata error tambahan.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_details: Option<serde_json::Value>,
    /// Mode eksekusi (cth: "manual", "trigger", "webhook", "integrated").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// ID eksekusi asal jika ini merupakan retry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_of: Option<String>,
    /// Waktu terjadinya error.
    pub timestamp: DateTime<Utc>,
}

impl WorkflowErrorPayload {
    pub fn new(
        execution_id: impl Into<String>,
        workflow_id: impl Into<String>,
        error_message: impl Into<String>,
    ) -> Self {
        Self {
            execution_id: execution_id.into(),
            workflow_id: workflow_id.into(),
            workflow_name: None,
            failed_node_name: None,
            failed_node_type: None,
            error_message: error_message.into(),
            error_stack: None,
            error_details: None,
            mode: None,
            retry_of: None,
            timestamp: Utc::now(),
        }
    }

    /// Membentuk representasi JSON yang persis dengan output node `Error Trigger` n8n.
    pub fn to_n8n_trigger_json(&self) -> serde_json::Value {
        let mut node_obj = serde_json::Map::new();
        if let Some(node_name) = &self.failed_node_name {
            node_obj.insert("name".into(), serde_json::Value::String(node_name.clone()));
        }
        if let Some(node_type) = &self.failed_node_type {
            node_obj.insert("type".into(), serde_json::Value::String(node_type.clone()));
        }

        let mut error_obj = serde_json::Map::new();
        error_obj.insert(
            "message".into(),
            serde_json::Value::String(self.error_message.clone()),
        );
        if let Some(stack) = &self.error_stack {
            error_obj.insert("stack".into(), serde_json::Value::String(stack.clone()));
        }
        if !node_obj.is_empty() {
            error_obj.insert("node".into(), serde_json::Value::Object(node_obj));
        }
        if let Some(details) = &self.error_details {
            error_obj.insert("details".into(), details.clone());
        }

        let mut execution_obj = serde_json::Map::new();
        execution_obj.insert(
            "id".into(),
            serde_json::Value::String(self.execution_id.clone()),
        );
        if let Some(retry_of) = &self.retry_of {
            execution_obj.insert("retryOf".into(), serde_json::Value::String(retry_of.clone()));
        }
        if let Some(last_node) = &self.failed_node_name {
            execution_obj.insert(
                "lastNodeExecuted".into(),
                serde_json::Value::String(last_node.clone()),
            );
        }
        if let Some(mode) = &self.mode {
            execution_obj.insert("mode".into(), serde_json::Value::String(mode.clone()));
        }
        execution_obj.insert("error".into(), serde_json::Value::Object(error_obj));

        let mut workflow_obj = serde_json::Map::new();
        workflow_obj.insert(
            "id".into(),
            serde_json::Value::String(self.workflow_id.clone()),
        );
        if let Some(wf_name) = &self.workflow_name {
            workflow_obj.insert("name".into(), serde_json::Value::String(wf_name.clone()));
        }

        serde_json::json!({
            "execution": execution_obj,
            "workflow": workflow_obj
        })
    }

    /// Mengonversi ke struktur standar `INodeExecutionData`.
    pub fn to_execution_data(&self) -> INodeExecutionData {
        INodeExecutionData {
            json: self.to_n8n_trigger_json(),
            binary: None,
            paired_item: None,
        }
    }
}

/// Binding antara source workflow dan target error workflow.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorWorkflowBinding {
    pub source_workflow_id: String,
    pub error_workflow_id: String,
    pub enabled: bool,
}

/// Hasil dari proses dispatching error trigger.
#[derive(Debug, Clone, PartialEq)]
pub enum DispatchResult {
    /// Sukses dipetakan dan siap dieksekusi.
    Dispatched {
        error_workflow_id: String,
        payload: serde_json::Value,
        execution_data: INodeExecutionData,
    },
    /// Tidak ada error workflow yang terdaftar untuk workflow sumber.
    NoHandlerConfigured { source_workflow_id: String },
    /// Binding terdaftar tetapi dinonaktifkan.
    Disabled { error_workflow_id: String },
}

/// Event notifikasi saat terjadi error dispatch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorTriggerEvent {
    pub event_id: Uuid,
    pub target_workflow_id: String,
    pub payload: WorkflowErrorPayload,
}

/// Dispatcher utama untuk memetakan dan menyalurkan event kegagalan ke error workflow.
pub struct ErrorTriggerDispatcher {
    bindings: RwLock<HashMap<String, ErrorWorkflowBinding>>,
    global_fallback_workflow_id: RwLock<Option<String>>,
    event_sender: broadcast::Sender<ErrorTriggerEvent>,
}

impl Default for ErrorTriggerDispatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl ErrorTriggerDispatcher {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(128);
        Self {
            bindings: RwLock::new(HashMap::new()),
            global_fallback_workflow_id: RwLock::new(None),
            event_sender: tx,
        }
    }

    /// Mendaftarkan error workflow untuk suatu source workflow.
    pub fn register_error_workflow(
        &self,
        source_workflow_id: impl Into<String>,
        error_workflow_id: impl Into<String>,
    ) {
        let src = source_workflow_id.into();
        let target = error_workflow_id.into();
        let mut map = self.bindings.write().unwrap();
        map.insert(
            src.clone(),
            ErrorWorkflowBinding {
                source_workflow_id: src,
                error_workflow_id: target,
                enabled: true,
            },
        );
    }

    /// Menonaktifkan atau mengaktifkan binding tertentu.
    pub fn set_binding_enabled(&self, source_workflow_id: &str, enabled: bool) -> bool {
        let mut map = self.bindings.write().unwrap();
        if let Some(binding) = map.get_mut(source_workflow_id) {
            binding.enabled = enabled;
            true
        } else {
            false
        }
    }

    /// Menghapus error workflow untuk suatu source workflow.
    pub fn unregister_error_workflow(&self, source_workflow_id: &str) -> Option<String> {
        let mut map = self.bindings.write().unwrap();
        map.remove(source_workflow_id)
            .map(|b| b.error_workflow_id)
    }

    /// Mengatur global fallback error workflow jika workflow spesifik tidak dikonfigurasi.
    pub fn set_global_fallback_workflow(&self, fallback_workflow_id: Option<String>) {
        let mut global = self.global_fallback_workflow_id.write().unwrap();
        *global = fallback_workflow_id;
    }

    /// Mendapatkan target error workflow untuk source workflow tertentu.
    pub fn get_error_workflow(&self, source_workflow_id: &str) -> Option<String> {
        let map = self.bindings.read().unwrap();
        if let Some(binding) = map.get(source_workflow_id) {
            if binding.enabled {
                return Some(binding.error_workflow_id.clone());
            }
        }
        let global = self.global_fallback_workflow_id.read().unwrap();
        global.clone()
    }

    /// Berlangganan event error trigger.
    pub fn subscribe(&self) -> broadcast::Receiver<ErrorTriggerEvent> {
        self.event_sender.subscribe()
    }

    /// Memetakan payload kesalahan ke target workflow penangan error dan menyiarkan event.
    pub fn dispatch(&self, payload: &WorkflowErrorPayload) -> DispatchResult {
        let target_workflow = {
            let map = self.bindings.read().unwrap();
            if let Some(binding) = map.get(&payload.workflow_id) {
                if !binding.enabled {
                    return DispatchResult::Disabled {
                        error_workflow_id: binding.error_workflow_id.clone(),
                    };
                }
                Some(binding.error_workflow_id.clone())
            } else {
                let global = self.global_fallback_workflow_id.read().unwrap();
                global.clone()
            }
        };

        match target_workflow {
            Some(target_id) => {
                let json_payload = payload.to_n8n_trigger_json();
                let execution_data = payload.to_execution_data();

                // Siarkan event ke listener asinkron (abaikan jika tidak ada receiver aktif)
                let _ = self.event_sender.send(ErrorTriggerEvent {
                    event_id: Uuid::new_v4(),
                    target_workflow_id: target_id.clone(),
                    payload: payload.clone(),
                });

                DispatchResult::Dispatched {
                    error_workflow_id: target_id,
                    payload: json_payload,
                    execution_data,
                }
            }
            None => DispatchResult::NoHandlerConfigured {
                source_workflow_id: payload.workflow_id.clone(),
            },
        }
    }
}
