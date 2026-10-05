//! P4.2 (Agent 2) — **Activation + Generation Lifecycle** runtime.
//!
//! Mesin deterministic yang menjalankan [`ActivationState`] machine
//! (`ingress.contracts@0.1.0`): transisi hanya lewat [`CANONICAL_TRANSITIONS`],
//! setiap entry ke `Activating` menerbitkan [`Generation`] baru (monotonic per
//! workflow), dan setiap record yang tersimpan **selalu** lolos
//! [`ActivationRecord::validate`] — registry tidak dapat memegang state ilegal.
//!
//! Tujuan utama P4.2 (master prompt): *aktivasi lama tidak boleh terus
//! memproses request setelah generation baru aktif*. Itu dijamin dua lapis:
//!
//! 1. [`ActivationRegistry::may_serve`] — gate serving: state harus serving
//!    (`Active`/`Degraded`) **dan** [`fence_generation`] (exact match);
//! 2. `expected: Option<Generation>` pada setiap command mutasi — optimistic
//!    concurrency (CAS): caller menyatakan generation yang ia putuskan;
//!    ketidakcocokan = `StaleCommand`, tidak ada transisi.
//!
//! Yang sengaja **tidak** ada di sini (batas scope):
//!
//! * journal transaksi / crash recovery / leader failover → P4.7 (registry
//!   adalah single-writer sync; locking eksternal milik host — transaksi
//!   journalable karena tiap command adalah langkah atomic murni);
//! * scheduler/trigger execution → P4.4 & P3/trigger-LEGO (modul ini tidak
//!   memanggil trigger; ia mengatur *state* dan menerbitkan niat);
//! * HTTP surface → P4.3; idempotency surface mirip-n8n diekspresikan sebagai
//!   [`ActivateOutcome`]/[`DeactivateOutcome`] (lihat catatan kompatibilitas
//!   pada masing-masing variant).
//!
//! Kompatibilitas n8n (jangkar `trigger.contract.md` Phase-2):
//! `activationMode` verbatim; activate-on-active = idempotent surface
//! (≈HTTP 200 `{active:true}`); deactivate pada workflow yang tidak aktif =
//! `NotActive` (≈`remove` unknown → warning + HTTP 200); activation error
//! terekspos lewat `record.last_error` (≈`GET /rest/active-workflows/error/:id`).

use crate::ingress_contract::{
    fence_generation, ActivationError, ActivationMode, ActivationRecord, ActivationState,
    Generation, IngressContractError, WorkflowIdentity, CANONICAL_TRANSITIONS,
};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Error runtime — terstruktur, tanpa panic
// ---------------------------------------------------------------------------

/// Kegagalan command activation. Setiap varian adalah alasan yang dapat
/// dijadikan observability record / reason code downstream.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ActivationTransitionError {
    #[error("workflow '{workflow_id}' tidak memiliki activation record")]
    UnknownWorkflow { workflow_id: String },

    #[error("workflow '{workflow_id}': transisi {from:?} -> {to:?} ilegal menurut CANONICAL_TRANSITIONS")]
    IllegalTransition {
        workflow_id: String,
        from: ActivationState,
        to: ActivationState,
    },

    #[error("workflow '{workflow_id}': command menyatakan generation {expected}, state saat ini {found} (race — baca ulang state)")]
    StaleCommand {
        workflow_id: String,
        expected: u64,
        found: u64,
    },

    #[error("workflow '{workflow_id}': drain graceful wajib membawa drain_deadline_ms")]
    DeadlineRequired { workflow_id: String },

    #[error("workflow '{workflow_id}': invariant kontrak dilanggar: {source}")]
    Invariant {
        workflow_id: String,
        source: IngressContractError,
    },
}

type CommandResult<T> = Result<T, ActivationTransitionError>;

// ---------------------------------------------------------------------------
// Outcome permukaan idempotent (parity dengan surface n8n)
// ---------------------------------------------------------------------------

/// Hasil [`ActivationRegistry::activate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActivateOutcome {
    /// Aktivasi dimulai: record kini `Activating` dengan generation baru.
    /// Caller wajib menutup dengan `commit_activation` / `fail_activation` /
    /// `abort_activation`.
    Started { generation: Generation },
    /// Sudah `Active` — idempotent (≈ n8n `POST /workflows/:id/activate`
    /// pada workflow aktif → HTTP 200). Generation tidak berubah.
    AlreadyActive { generation: Generation },
    /// Aktivasi lain sedang berjalan (serialization boundary; ≈ n8n yang
    /// men-serialkan activation per workflow).
    AlreadyActivating { generation: Generation },
}

/// Strategi deaktivasi — eksplisit, tidak ada kebijakan tersembunyi.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeactivationKind {
    /// `Active/Degraded → Draining` dengan deadline; selesaikan request
    /// berjalan, lalu `finish_drain` → teardown.
    Graceful { drain_deadline_ms: u64 },
    /// `Active/Degraded → Deactivating` segera (shutdown/update keras).
    Immediate,
}

/// Hasil [`ActivationRegistry::deactivate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeactivateOutcome {
    /// Kini `Draining` (graceful).
    Draining,
    /// Kini `Deactivating` (immediate).
    Deactivating,
    /// Sudah `Draining` — idempotent.
    AlreadyDraining,
    /// Sudah `Deactivating` — idempotent.
    AlreadyDeactivating,
    /// Aktivasi yang sedang berjalan dibatalkan bersih (`Activating → Inactive`).
    CancelledActivation,
    /// Workflow tidak aktif — idempotent surface
    /// (≈ n8n `ActiveWorkflows.remove` unknown → warning + HTTP 200).
    NotActive,
}

/// Target aktivasi yang di-antrikan saat `update` (registrasi lama di-drain
/// dulu; aktivasi baru memakai identitas ini setelah `Inactive`). Disimpan di
/// runtime registry — bukan bagian [`ActivationRecord`] yang beku.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingUpdate {
    pub target: WorkflowIdentity,
    pub activation_mode: ActivationMode,
}

/// Rencana rekonsiliasi startup — value murni; *execution*-nya milik host
/// (deterministik: urut leksikografik workflow id, lihat [`BTreeMap`]).
///
/// Start dari `to_resume_drain` (selesaikan transaksi yang terputus),
/// lalu `to_deactivate` (basmi route/trigger yang tersisa), lalu
/// `to_retry_failed`, lalu `to_activate`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcilePlan {
    /// Persisted-active yang belum punya record serving.
    pub to_activate: Vec<WorkflowIdentity>,
    /// Record serving/aktif yang tidak ada di desired → harus diturunkan
    /// (route/trigger basi tidak boleh terus melayani).
    pub to_deactivate: Vec<String>,
    /// `Failed` yang masih diinginkan → retry activation.
    pub to_retry_failed: Vec<String>,
    /// Terputus di `Draining`/`Deactivating` → lanjutkan teardown
    /// (tidak ada request baru yang boleh masuk selama itu).
    pub to_resume_drain: Vec<String>,
}

// ---------------------------------------------------------------------------
// ActivationRegistry — single-writer, deterministic, fail-closed
// ---------------------------------------------------------------------------

/// Registry activation canonical P4 (in-memory; persistensi = journal P4.7).
///
/// Satu record per workflow. Iterasi deterministik lewat [`BTreeMap`].
#[derive(Debug, Default)]
pub struct ActivationRegistry {
    records: BTreeMap<String, ActivationRecord>,
    pending_updates: BTreeMap<String, PendingUpdate>,
}

impl ActivationRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn record(&self, workflow_id: &str) -> Option<&ActivationRecord> {
        self.records.get(workflow_id)
    }

    pub fn generation(&self, workflow_id: &str) -> Option<Generation> {
        self.records
            .get(workflow_id)
            .map(|record| record.generation)
    }

    /// Iterasi deterministik (urut workflow id).
    pub fn records(&self) -> impl Iterator<Item = &ActivationRecord> {
        self.records.values()
    }

    pub fn pending_update(&self, workflow_id: &str) -> Option<&PendingUpdate> {
        self.pending_updates.get(workflow_id)
    }

    // ------------------------------------------------------------ gate P4.1

    /// Gate kanonik "bolehkah request ini dilayani": state serving **dan**
    /// fence generation exact-match. Inilah penegak "aktivasi lama tidak
    /// boleh terus memproses request setelah generation baru aktif".
    pub fn may_serve(
        &self,
        workflow_id: &str,
        observed: Generation,
    ) -> Result<(), ActivationTransitionError> {
        let record = self.records.get(workflow_id).ok_or_else(|| {
            ActivationTransitionError::UnknownWorkflow {
                workflow_id: workflow_id.to_string(),
            }
        })?;
        if !record.state.is_serving() {
            return Err(ActivationTransitionError::IllegalTransition {
                workflow_id: workflow_id.to_string(),
                from: record.state,
                to: ActivationState::Active,
            });
        }
        fence_generation(observed, record.generation).map_err(|source| {
            ActivationTransitionError::Invariant {
                workflow_id: workflow_id.to_string(),
                source,
            }
        })
    }

    // --------------------------------------------------------- primitive CAS

    fn expect_generation(
        record: &ActivationRecord,
        expected: Option<Generation>,
    ) -> CommandResult<()> {
        if let Some(expected) = expected {
            if expected != record.generation {
                return Err(ActivationTransitionError::StaleCommand {
                    workflow_id: record.workflow.workflow_id.clone(),
                    expected: expected.get(),
                    found: record.generation.get(),
                });
            }
        }
        Ok(())
    }

    fn take_record(
        &mut self,
        workflow_id: &str,
        expected: Option<Generation>,
    ) -> CommandResult<ActivationRecord> {
        let record = self.records.get(workflow_id).cloned().ok_or_else(|| {
            ActivationTransitionError::UnknownWorkflow {
                workflow_id: workflow_id.to_string(),
            }
        })?;
        Self::expect_generation(&record, expected)?;
        Ok(record)
    }

    fn put_record(&mut self, record: ActivationRecord) -> CommandResult<()> {
        // Fail-closed: registry tidak pernah menyimpan record ilegal.
        record
            .validate()
            .map_err(|source| ActivationTransitionError::Invariant {
                workflow_id: record.workflow.workflow_id.clone(),
                source,
            })?;
        self.records
            .insert(record.workflow.workflow_id.clone(), record);
        Ok(())
    }

    /// Satu-satunya jalan transisi record: cek [`CANONICAL_TRANSITIONS`],
    /// set timestamp, lalu terapkan invariant:
    /// * `last_error` hanya hidup pada state `Failed`/`Degraded` — memasuki
    ///   state lain membersihkannya (riwayat fault selesai di boundary itu);
    /// * `drain_deadline_ms` wajib ada persis pada `Draining`, hilang di state lain.
    /// Record hasil divalidasi sebelum disimpan (lihat [`Self::put_record`]).
    fn transition(
        mut record: ActivationRecord,
        to: ActivationState,
        now_ms: u64,
        error: Option<ActivationError>,
        drain_deadline_ms: Option<u64>,
    ) -> CommandResult<ActivationRecord> {
        let from = record.state;
        let workflow_id = record.workflow.workflow_id.clone();
        if !from.can_transition(to) {
            return Err(ActivationTransitionError::IllegalTransition {
                workflow_id: workflow_id.clone(),
                from,
                to,
            });
        }
        let drain_deadline_ms = if to == ActivationState::Draining {
            match drain_deadline_ms {
                Some(deadline) => Some(deadline),
                None => {
                    return Err(ActivationTransitionError::DeadlineRequired { workflow_id });
                }
            }
        } else {
            None
        };
        record.state = to;
        record.entered_state_at_ms = now_ms;
        record.updated_at_ms = now_ms;
        record.last_error = if matches!(to, ActivationState::Failed | ActivationState::Degraded) {
            error
        } else {
            None
        };
        record.drain_deadline_ms = drain_deadline_ms;
        debug_assert!(
            CANONICAL_TRANSITIONS.contains(&(from, to)),
            "transisi dicek di atas"
        );
        Ok(record)
    }

    // ------------------------------------------------------ command lifecycle

    /// `INACTIVE/tanpa-record → ACTIVATING` (atau retry `FAILED → ACTIVATING`).
    /// Menerbitkan generation baru yang monotonic per workflow. Mengembalikan
    /// generation yang diterbitkan — caller wajib menempelkannya pada semua
    /// route/fence yang didaftarkan selama aktivasi ini.
    pub fn begin_activation(
        &mut self,
        workflow: WorkflowIdentity,
        activation_mode: ActivationMode,
        owner_instance: Option<String>,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<Generation> {
        let workflow_id = workflow.workflow_id.clone();
        let existing = match self.records.get(&workflow_id) {
            Some(record) => {
                Self::expect_generation(record, expected)?;
                Some(record.clone())
            }
            None => None,
        };
        let mut record = existing.unwrap_or_else(|| {
            ActivationRecord::new(
                workflow,
                ActivationState::Inactive,
                Generation::new(0),
                activation_mode,
                now_ms,
            )
        });
        let next_generation = record.generation.next();
        record.activation_mode = activation_mode;
        let mut record = Self::transition(record, ActivationState::Activating, now_ms, None, None)?;
        record.generation = next_generation;
        record.owner_instance = owner_instance.or(record.owner_instance);
        self.put_record(record)?;
        Ok(next_generation)
    }

    /// `ACTIVATING → ACTIVE` — commit setelah registrasi route/trigger selesai.
    pub fn commit_activation(
        &mut self,
        workflow_id: &str,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<()> {
        let record = self.take_record(workflow_id, expected)?;
        let record = Self::transition(record, ActivationState::Active, now_ms, None, None)?;
        self.pending_updates.remove(workflow_id);
        self.put_record(record)
    }

    /// `ACTIVATING → INACTIVE` — batal bersih tanpa error (rollback parsial
    /// selesai; ≈ n8n menutup kembali trigger yang sempat start).
    pub fn abort_activation(
        &mut self,
        workflow_id: &str,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<()> {
        let record = self.take_record(workflow_id, expected)?;
        let record = Self::transition(record, ActivationState::Inactive, now_ms, None, None)?;
        self.put_record(record)
    }

    /// `ACTIVATING → FAILED` — error tercatat (≈ `ActivationErrorsService`).
    pub fn fail_activation(
        &mut self,
        workflow_id: &str,
        error: ActivationError,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<()> {
        let record = self.take_record(workflow_id, expected)?;
        let record = Self::transition(record, ActivationState::Failed, now_ms, Some(error), None)?;
        self.put_record(record)
    }

    /// `ACTIVE → DEGRADED` — sebagian rute/trigger gagal, workflow tetap
    /// melayani (lihat [`ActivationState::is_serving`]).
    pub fn mark_degraded(
        &mut self,
        workflow_id: &str,
        error: ActivationError,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<()> {
        let record = self.take_record(workflow_id, expected)?;
        let record =
            Self::transition(record, ActivationState::Degraded, now_ms, Some(error), None)?;
        self.put_record(record)
    }

    /// `DEGRADED → ACTIVE` — pemulihan penuh, error dibersihkan.
    pub fn mark_recovered(
        &mut self,
        workflow_id: &str,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<()> {
        let record = self.take_record(workflow_id, expected)?;
        let record = Self::transition(record, ActivationState::Active, now_ms, None, None)?;
        self.put_record(record)
    }

    /// `DEGRADED → FAILED` — eskalasi menjadi kegagalan penuh.
    pub fn escalate_failure(
        &mut self,
        workflow_id: &str,
        error: ActivationError,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<()> {
        let record = self.take_record(workflow_id, expected)?;
        let record = Self::transition(record, ActivationState::Failed, now_ms, Some(error), None)?;
        self.put_record(record)
    }

    /// `ACTIVE/DEGRADED → DRAINING` — deadline wajib (bounded drain).
    pub fn begin_drain(
        &mut self,
        workflow_id: &str,
        drain_deadline_ms: u64,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<()> {
        let record = self.take_record(workflow_id, expected)?;
        let record = Self::transition(
            record,
            ActivationState::Draining,
            now_ms,
            None,
            Some(drain_deadline_ms),
        )?;
        self.put_record(record)
    }

    /// `DRAINING → DEACTIVATING` — drain selesai atau deadline-nya lewat.
    pub fn finish_drain(
        &mut self,
        workflow_id: &str,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<()> {
        let record = self.take_record(workflow_id, expected)?;
        // drain deadline dibersihkan; last_error dari era Degraded selesai di boundary drain.
        let record = Self::transition(record, ActivationState::Deactivating, now_ms, None, None)?;
        self.put_record(record)
    }

    /// `ACTIVE/DEGRADED → DEACTIVATING` tanpa grace (shutdown/update keras).
    pub fn begin_deactivation_immediate(
        &mut self,
        workflow_id: &str,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<()> {
        let record = self.take_record(workflow_id, expected)?;
        let record = Self::transition(record, ActivationState::Deactivating, now_ms, None, None)?;
        self.put_record(record)
    }

    /// `DEACTIVATING → INACTIVE` — teardown selesai. Generation lawas selesai
    /// total; fence exact-match membuat request gen-lama tetap tertolak.
    pub fn finish_deactivation(
        &mut self,
        workflow_id: &str,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<()> {
        let record = self.take_record(workflow_id, expected)?;
        let record = Self::transition(record, ActivationState::Inactive, now_ms, None, None)?;
        self.put_record(record)
    }

    /// `DEACTIVATING → FAILED` — teardown gagal; rekonsiliasi P4.7 membersihkan.
    pub fn fail_deactivation(
        &mut self,
        workflow_id: &str,
        error: ActivationError,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<()> {
        let record = self.take_record(workflow_id, expected)?;
        let record = Self::transition(record, ActivationState::Failed, now_ms, Some(error), None)?;
        self.put_record(record)
    }

    // ------------------------------------------------- permukaan idempotent

    /// Satu pintu activate yang idempotent (parity surface n8n).
    /// Hanya membuka aktivasi — commit/abort/fail terpisah dan eksplisit.
    pub fn activate(
        &mut self,
        workflow: WorkflowIdentity,
        activation_mode: ActivationMode,
        owner_instance: Option<String>,
        now_ms: u64,
    ) -> CommandResult<ActivateOutcome> {
        let workflow_id = workflow.workflow_id.clone();
        match self.records.get(&workflow_id).map(|record| record.state) {
            Some(ActivationState::Active) => Ok(ActivateOutcome::AlreadyActive {
                generation: self.generation(&workflow_id).expect("record ada"),
            }),
            Some(ActivationState::Activating) => Ok(ActivateOutcome::AlreadyActivating {
                generation: self.generation(&workflow_id).expect("record ada"),
            }),
            // Retry pada Failed atau reaktivasi setelah Inactive = aktivasi
            // ulang dengan generation baru (≈ n8n: workflow yang tidak aktif
            // di registry in-memory menjalankan `add` penuh lagi).
            Some(ActivationState::Failed) | Some(ActivationState::Inactive) | None => {
                let generation =
                    self.begin_activation(workflow, activation_mode, owner_instance, None, now_ms)?;
                Ok(ActivateOutcome::Started { generation })
            }
            // Dilarang strict (no hidden semantics): Degraded/Draining/Deactivating
            // tidak boleh diam-diam di-activate. Caller memilih jalur recovery/update.
            Some(state) => Err(ActivationTransitionError::IllegalTransition {
                workflow_id,
                from: state,
                to: ActivationState::Activating,
            }),
        }
    }

    /// Satu pintu deactivate yang idempotent (parity surface n8n).
    pub fn deactivate(
        &mut self,
        workflow_id: &str,
        kind: DeactivationKind,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<DeactivateOutcome> {
        let record = match self.records.get(workflow_id) {
            Some(record) => record.clone(),
            None => return Ok(DeactivateOutcome::NotActive),
        };
        Self::expect_generation(&record, expected)?;
        match record.state {
            ActivationState::Inactive => Ok(DeactivateOutcome::NotActive),
            ActivationState::Draining => Ok(DeactivateOutcome::AlreadyDraining),
            ActivationState::Deactivating => Ok(DeactivateOutcome::AlreadyDeactivating),
            ActivationState::Activating => {
                self.abort_activation(workflow_id, expected, now_ms)?;
                Ok(DeactivateOutcome::CancelledActivation)
            }
            // Failed tidak melayani apa-apa; tidak ada yang perlu diturunkan.
            ActivationState::Failed => Ok(DeactivateOutcome::NotActive),
            ActivationState::Active | ActivationState::Degraded => match kind {
                DeactivationKind::Graceful { drain_deadline_ms } => {
                    self.begin_drain(workflow_id, drain_deadline_ms, expected, now_ms)?;
                    Ok(DeactivateOutcome::Draining)
                }
                DeactivationKind::Immediate => {
                    self.begin_deactivation_immediate(workflow_id, expected, now_ms)?;
                    Ok(DeactivateOutcome::Deactivating)
                }
            },
        }
    }

    // ------------------------------------------------------------- updates

    /// Minta update pada workflow `Active/Degraded`: masuk `Draining` dan
    /// antrikan target baru. Setelah teardown selesai (`Inactive`), caller
    /// mengambil target lewat [`ActivationRegistry::take_pending_update`] dan
    /// memanggil `begin_activation` — generation baru diterbitkan di sana,
    /// jadi fence otomatis memutus serving jalur lama.
    pub fn request_update(
        &mut self,
        workflow_id: &str,
        target: WorkflowIdentity,
        activation_mode: ActivationMode,
        drain_deadline_ms: u64,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> CommandResult<()> {
        if target.workflow_id != workflow_id {
            return Err(ActivationTransitionError::Invariant {
                workflow_id: workflow_id.to_string(),
                source: IngressContractError::InvalidCombination(
                    "target update harus workflow yang sama",
                ),
            });
        }
        self.pending_updates.insert(
            workflow_id.to_string(),
            PendingUpdate {
                target,
                activation_mode,
            },
        );
        self.begin_drain(workflow_id, drain_deadline_ms, expected, now_ms)
    }

    /// Ambil (sekaligus hapus) antrian update — dipanggil saat workflow sudah
    /// `Inactive` (teardown selesai), tepat sebelum `begin_activation` target.
    pub fn take_pending_update(&mut self, workflow_id: &str) -> Option<PendingUpdate> {
        self.pending_updates.remove(workflow_id)
    }

    // ------------------------------------------------------- housekeeping

    /// Hapus record `Inactive` yang bersih (housekeeping bounded — registry
    /// tidak tumbuh tanpa batas untuk workflow yang sudah turun). Records
    /// non-Inactive tidak disentuh. Fence tetap fail-closed: generation reset
    /// membuat observed-gen lama selalu mismatch.
    pub fn prune_inactive(&mut self) -> usize {
        let before = self.records.len();
        self.records
            .retain(|_, record| record.state != ActivationState::Inactive);
        before - self.records.len()
    }

    // -------------------------------------------------------- rekonsiliasi

    /// Rekonsiliasi startup: bandingkan desired (persisted active workflows)
    /// dengan records yang ada, hasilkan [`ReconcilePlan`] deterministik.
    /// Execution plan-nya milik host; plan ini murni dan dapat diuji.
    pub fn reconcile(&self, desired: &[WorkflowIdentity]) -> ReconcilePlan {
        let mut plan = ReconcilePlan::default();
        // 1) records yang tidak diinginkan → turunkan / lanjutkan teardown.
        for (workflow_id, record) in &self.records {
            let wanted = desired
                .iter()
                .any(|identity| &identity.workflow_id == workflow_id);
            match record.state {
                ActivationState::Draining | ActivationState::Deactivating => {
                    // Transaksi terputus — selesaikan dulu apapun desired-nya.
                    plan.to_resume_drain.push(workflow_id.clone());
                }
                ActivationState::Failed if wanted => {
                    plan.to_retry_failed.push(workflow_id.clone());
                }
                _ if !wanted && record.state != ActivationState::Inactive => {
                    plan.to_deactivate.push(workflow_id.clone());
                }
                _ => {}
            }
        }
        // 2) desired yang belum serving → aktifkan.
        for identity in desired {
            let serving = self
                .records
                .get(&identity.workflow_id)
                .map(|record| {
                    matches!(
                        record.state,
                        ActivationState::Active
                            | ActivationState::Degraded
                            | ActivationState::Activating
                            | ActivationState::Draining
                            | ActivationState::Deactivating
                            | ActivationState::Failed
                    )
                })
                .unwrap_or(false);
            if !serving {
                plan.to_activate.push(identity.clone());
            }
        }
        plan
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 10_000;

    fn wf(id: &str, version: u64) -> WorkflowIdentity {
        WorkflowIdentity::new(id, Some(format!("ver-{version}"))).unwrap()
    }

    fn activated(registry: &mut ActivationRegistry, id: &str, now: u64) -> Generation {
        let generation = registry
            .begin_activation(wf(id, 1), ActivationMode::Activate, None, None, now)
            .unwrap();
        registry.commit_activation(id, None, now).unwrap();
        generation
    }

    fn err(msg: &str) -> ActivationError {
        ActivationError {
            message: msg.to_string(),
            node: None,
            at_ms: T0,
        }
    }

    // ---------------------------------------------------------------- lifecycle

    #[test]
    fn begin_commit_publishes_monotonic_generations() {
        let mut registry = ActivationRegistry::new();
        let g1 = registry
            .begin_activation(wf("wf-1", 1), ActivationMode::Init, None, None, T0)
            .unwrap();
        assert_eq!(g1, Generation::new(1));
        registry.commit_activation("wf-1", None, T0).unwrap();
        let record = registry.record("wf-1").unwrap();
        assert_eq!(record.state, ActivationState::Active);
        assert_eq!(record.generation, g1);
        assert_eq!(record.activation_mode, ActivationMode::Init);
        record.validate().unwrap();

        // turunkan lalu aktifkan lagi → generation naik, tidak pernah reset.
        registry
            .begin_deactivation_immediate("wf-1", None, T0 + 1)
            .unwrap();
        registry.finish_deactivation("wf-1", None, T0 + 2).unwrap();
        let g2 = registry
            .begin_activation(wf("wf-1", 2), ActivationMode::Update, None, None, T0 + 3)
            .unwrap();
        assert_eq!(g2, Generation::new(2));
    }

    #[test]
    fn activate_surface_is_idempotent_like_n8n() {
        let mut registry = ActivationRegistry::new();
        // workflow baru → Started
        let outcome = registry
            .activate(wf("wf-1", 1), ActivationMode::Activate, None, T0)
            .unwrap();
        assert!(matches!(outcome, ActivateOutcome::Started { .. }));
        registry.commit_activation("wf-1", None, T0).unwrap();
        // activate kedua pada Active → AlreadyActive, generation tidak berubah (≈ HTTP 200)
        let generation = registry.generation("wf-1").unwrap();
        let outcome = registry
            .activate(wf("wf-1", 1), ActivationMode::Activate, None, T0 + 1)
            .unwrap();
        assert_eq!(outcome, ActivateOutcome::AlreadyActive { generation });
    }

    #[test]
    fn activate_on_activating_is_serialized() {
        let mut registry = ActivationRegistry::new();
        registry
            .activate(wf("wf-1", 1), ActivationMode::Activate, None, T0)
            .unwrap();
        let generation = registry.generation("wf-1").unwrap();
        let outcome = registry
            .activate(wf("wf-1", 1), ActivationMode::Activate, None, T0 + 1)
            .unwrap();
        assert_eq!(outcome, ActivateOutcome::AlreadyActivating { generation });
    }

    #[test]
    fn activate_is_strict_for_non_idle_states() {
        let mut registry = ActivationRegistry::new();
        activated(&mut registry, "wf-1", T0);
        registry.begin_drain("wf-1", T0 + 100, None, T0).unwrap();
        let error = registry
            .activate(wf("wf-1", 2), ActivationMode::Update, None, T0 + 1)
            .unwrap_err();
        assert!(matches!(
            error,
            ActivationTransitionError::IllegalTransition {
                from: ActivationState::Draining,
                ..
            }
        ));
    }

    #[test]
    fn failed_activation_retries_with_new_generation() {
        let mut registry = ActivationRegistry::new();
        let g1 = registry
            .begin_activation(wf("wf-1", 1), ActivationMode::Activate, None, None, T0)
            .unwrap();
        registry
            .fail_activation("wf-1", err("poll exploded"), None, T0 + 1)
            .unwrap();
        let record = registry.record("wf-1").unwrap();
        assert_eq!(record.state, ActivationState::Failed);
        // activation-error visibility (≈ GET /rest/active-workflows/error/:id)
        assert_eq!(record.last_error.as_ref().unwrap().message, "poll exploded");
        record.validate().unwrap();

        let g2 = registry
            .begin_activation(
                wf("wf-1", 1),
                ActivationMode::Activate,
                None,
                Some(g1),
                T0 + 2,
            )
            .unwrap();
        assert!(g2 > g1, "retry menerbitkan generation baru");
        registry.commit_activation("wf-1", None, T0 + 3).unwrap();
        // sukses membersihkan error (≈ n8n deregister pada aktivasi sukses)
        assert!(registry.record("wf-1").unwrap().last_error.is_none());
    }

    #[test]
    fn degraded_escalates_and_recovers_deterministically() {
        let mut registry = ActivationRegistry::new();
        let generation = activated(&mut registry, "wf-1", T0);
        registry
            .mark_degraded("wf-1", err("one route failed"), None, T0 + 1)
            .unwrap();
        let record = registry.record("wf-1").unwrap();
        assert_eq!(record.state, ActivationState::Degraded);
        record.validate().unwrap();
        // Degraded masih serving dengan generation yang sama:
        registry.may_serve("wf-1", generation).unwrap();

        registry.mark_recovered("wf-1", None, T0 + 2).unwrap();
        assert_eq!(
            registry.record("wf-1").unwrap().state,
            ActivationState::Active
        );
        assert!(registry.record("wf-1").unwrap().last_error.is_none());

        registry
            .mark_degraded("wf-1", err("again"), None, T0 + 3)
            .unwrap();
        registry
            .escalate_failure("wf-1", err("full failure"), None, T0 + 4)
            .unwrap();
        assert_eq!(
            registry.record("wf-1").unwrap().state,
            ActivationState::Failed
        );
        // Failed tidak melayani apa pun:
        assert!(registry.may_serve("wf-1", generation).is_err());
    }

    // -------------------------------------------------- deactivation & drain

    #[test]
    fn graceful_deactivation_walks_drain_chain() {
        let mut registry = ActivationRegistry::new();
        let generation = activated(&mut registry, "wf-1", T0);
        let outcome = registry
            .deactivate(
                "wf-1",
                DeactivationKind::Graceful {
                    drain_deadline_ms: T0 + 500,
                },
                None,
                T0 + 1,
            )
            .unwrap();
        assert_eq!(outcome, DeactivateOutcome::Draining);
        let record = registry.record("wf-1").unwrap();
        assert_eq!(record.state, ActivationState::Draining);
        assert_eq!(record.drain_deadline_ms, Some(T0 + 500));
        record.validate().unwrap();
        // Draining tidak melayani request baru:
        assert!(registry.may_serve("wf-1", generation).is_err());
        // idempotent:
        let again = registry
            .deactivate(
                "wf-1",
                DeactivationKind::Graceful {
                    drain_deadline_ms: T0 + 900,
                },
                None,
                T0 + 2,
            )
            .unwrap();
        assert_eq!(again, DeactivateOutcome::AlreadyDraining);

        registry.finish_drain("wf-1", None, T0 + 3).unwrap();
        let record = registry.record("wf-1").unwrap();
        assert_eq!(record.state, ActivationState::Deactivating);
        assert_eq!(record.drain_deadline_ms, None, "deadline dibersihkan");
        registry.finish_deactivation("wf-1", None, T0 + 4).unwrap();
        assert_eq!(
            registry.record("wf-1").unwrap().state,
            ActivationState::Inactive
        );
    }

    #[test]
    fn immediate_deactivation_skips_drain() {
        let mut registry = ActivationRegistry::new();
        activated(&mut registry, "wf-1", T0);
        let outcome = registry
            .deactivate("wf-1", DeactivationKind::Immediate, None, T0 + 1)
            .unwrap();
        assert_eq!(outcome, DeactivateOutcome::Deactivating);
        let again = registry
            .deactivate("wf-1", DeactivationKind::Immediate, None, T0 + 2)
            .unwrap();
        assert_eq!(again, DeactivateOutcome::AlreadyDeactivating);
    }

    #[test]
    fn deactivate_unknown_is_not_active_like_n8n() {
        let mut registry = ActivationRegistry::new();
        let outcome = registry
            .deactivate("ghost", DeactivationKind::Immediate, None, T0)
            .unwrap();
        assert_eq!(outcome, DeactivateOutcome::NotActive);
    }

    #[test]
    fn deactivate_is_cas_guarded() {
        let mut registry = ActivationRegistry::new();
        activated(&mut registry, "wf-1", T0);
        // command yang menyatakan generation basi ditolak sebelum menyentuh state:
        let error = registry
            .deactivate(
                "wf-1",
                DeactivationKind::Immediate,
                Some(Generation::new(99)),
                T0 + 1,
            )
            .unwrap_err();
        assert!(matches!(
            error,
            ActivationTransitionError::StaleCommand {
                expected: 99,
                found: 1,
                ..
            }
        ));
        // state tidak berubah sama sekali:
        assert_eq!(
            registry.record("wf-1").unwrap().state,
            ActivationState::Active
        );
    }

    #[test]
    fn deactivating_during_activation_cancels_cleanly() {
        let mut registry = ActivationRegistry::new();
        registry
            .activate(wf("wf-1", 1), ActivationMode::Activate, None, T0)
            .unwrap();
        let outcome = registry
            .deactivate("wf-1", DeactivationKind::Immediate, None, T0 + 1)
            .unwrap();
        assert_eq!(outcome, DeactivateOutcome::CancelledActivation);
        assert_eq!(
            registry.record("wf-1").unwrap().state,
            ActivationState::Inactive
        );
    }

    #[test]
    fn failed_teardown_lands_in_failed_for_reconciliation() {
        let mut registry = ActivationRegistry::new();
        activated(&mut registry, "wf-1", T0);
        registry
            .begin_deactivation_immediate("wf-1", None, T0 + 1)
            .unwrap();
        registry
            .fail_deactivation("wf-1", err("close exploded"), None, T0 + 2)
            .unwrap();
        let record = registry.record("wf-1").unwrap();
        assert_eq!(record.state, ActivationState::Failed);
        assert_eq!(
            record.last_error.as_ref().unwrap().message,
            "close exploded"
        );
        record.validate().unwrap();
    }

    // ------------------------------------------------------- race & fencing

    #[test]
    fn cas_expected_generation_blocks_racing_commands() {
        let mut registry = ActivationRegistry::new();
        let generation = activated(&mut registry, "wf-1", T0);
        // command dengan generation basi → StaleCommand
        let error = registry
            .mark_degraded("wf-1", err("leg"), Some(Generation::new(77)), T0 + 1)
            .unwrap_err();
        assert!(matches!(
            error,
            ActivationTransitionError::StaleCommand { .. }
        ));
        // generation tepat → lolos
        registry
            .mark_degraded("wf-1", err("leg"), Some(generation), T0 + 1)
            .unwrap();
    }

    #[test]
    fn may_serve_is_the_fail_closed_serving_gate() {
        let mut registry = ActivationRegistry::new();
        let generation = activated(&mut registry, "wf-1", T0);
        registry.may_serve("wf-1", generation).unwrap();
        // generation salah (lebih tua / lebih baru) → ditolak
        assert!(registry
            .may_serve("wf-1", Generation::new(generation.get() + 1))
            .is_err());
        // workflow tak dikenal → UnknownWorkflow
        assert!(matches!(
            registry.may_serve("ghost", generation),
            Err(ActivationTransitionError::UnknownWorkflow { .. })
        ));
    }

    #[test]
    fn old_activation_cannot_serve_after_new_generation_commits() {
        // Inilah jaminan inti P4.2 di ujung-ke-ujung logis:
        let mut registry = ActivationRegistry::new();
        let g_old = activated(&mut registry, "wf-1", T0);
        registry.may_serve("wf-1", g_old).unwrap();

        // update graceful: drain → teardown → aktivasi baru
        registry
            .request_update(
                "wf-1",
                wf("wf-1", 2),
                ActivationMode::Update,
                T0 + 500,
                None,
                T0 + 1,
            )
            .unwrap();
        assert!(
            registry.may_serve("wf-1", g_old).is_err(),
            "drain menutup serving lama"
        );
        registry.finish_drain("wf-1", None, T0 + 2).unwrap();
        registry.finish_deactivation("wf-1", None, T0 + 3).unwrap();

        let pending = registry
            .take_pending_update("wf-1")
            .expect("update ter-antri");
        assert_eq!(pending.target.workflow_version_id.as_deref(), Some("ver-2"));
        let g_new = registry
            .begin_activation(pending.target, pending.activation_mode, None, None, T0 + 4)
            .unwrap();
        assert!(g_new > g_old);
        registry.commit_activation("wf-1", None, T0 + 5).unwrap();

        // permintaan yang tertangkap pada generation LAMA: ditolak walau workflow Active.
        assert!(registry.may_serve("wf-1", g_old).is_err());
        registry.may_serve("wf-1", g_new).unwrap();
    }

    #[test]
    fn legal_commands_never_store_invalid_records() {
        // baterai: setiap command legal wajib menghasilkan record yang lolos validate().
        let mut registry = ActivationRegistry::new();
        registry
            .begin_activation(wf("wf-1", 1), ActivationMode::Activate, None, None, T0)
            .unwrap();
        registry.record("wf-1").unwrap().validate().unwrap();
        registry.commit_activation("wf-1", None, T0 + 1).unwrap();
        registry.record("wf-1").unwrap().validate().unwrap();
        registry
            .mark_degraded("wf-1", err("d"), None, T0 + 2)
            .unwrap();
        registry.record("wf-1").unwrap().validate().unwrap();
        registry
            .begin_drain("wf-1", T0 + 900, None, T0 + 3)
            .unwrap();
        registry.record("wf-1").unwrap().validate().unwrap();
        registry.finish_drain("wf-1", None, T0 + 4).unwrap();
        registry.record("wf-1").unwrap().validate().unwrap();
        registry
            .fail_deactivation("wf-1", err("f"), None, T0 + 5)
            .unwrap();
        registry.record("wf-1").unwrap().validate().unwrap();
    }

    #[test]
    fn begin_activation_rejects_non_idle_states() {
        let mut registry = ActivationRegistry::new();
        activated(&mut registry, "wf-1", T0);
        let error = registry
            .begin_activation(wf("wf-1", 2), ActivationMode::Update, None, None, T0 + 1)
            .unwrap_err();
        assert!(matches!(
            error,
            ActivationTransitionError::IllegalTransition {
                from: ActivationState::Active,
                to: ActivationState::Activating,
                ..
            }
        ));
    }

    // ------------------------------------------------------------ reconcile

    #[test]
    fn reconcile_produces_a_deterministic_plan() {
        let mut registry = ActivationRegistry::new();
        activated(&mut registry, "wf-active-kept", T0);
        activated(&mut registry, "wf-stale", T0);
        registry
            .begin_activation(wf("wf-failed", 1), ActivationMode::Activate, None, None, T0)
            .unwrap();
        registry
            .fail_activation("wf-failed", err("x"), None, T0)
            .unwrap();
        registry
            .begin_activation(
                wf("wf-draining", 1),
                ActivationMode::Activate,
                None,
                None,
                T0,
            )
            .unwrap();
        registry.commit_activation("wf-draining", None, T0).unwrap();
        registry
            .begin_drain("wf-draining", T0 + 9000, None, T0)
            .unwrap();

        let desired = vec![wf("wf-active-kept", 1), wf("wf-failed", 1), wf("wf-new", 1)];
        let plan = registry.reconcile(&desired);

        assert_eq!(plan.to_resume_drain, vec!["wf-draining"]);
        assert_eq!(plan.to_deactivate, vec!["wf-stale"]);
        assert_eq!(plan.to_retry_failed, vec!["wf-failed"]);
        assert_eq!(plan.to_activate.len(), 1);
        assert_eq!(plan.to_activate[0].workflow_id, "wf-new");
        // deterministik: urutan leksikografik pada setiap bucket
        let plan2 = registry.reconcile(&desired);
        assert_eq!(plan, plan2);
    }

    #[test]
    fn reconcile_leaves_serving_workflows_alone() {
        let mut registry = ActivationRegistry::new();
        activated(&mut registry, "wf-1", T0);
        let plan = registry.reconcile(&[wf("wf-1", 1)]);
        assert_eq!(plan, ReconcilePlan::default());
    }

    #[test]
    fn prune_inactive_only_drops_inactive_records() {
        let mut registry = ActivationRegistry::new();
        activated(&mut registry, "wf-1", T0);
        activated(&mut registry, "wf-2", T0);
        registry
            .begin_deactivation_immediate("wf-2", None, T0 + 1)
            .unwrap();
        registry.finish_deactivation("wf-2", None, T0 + 2).unwrap();
        assert_eq!(registry.prune_inactive(), 1);
        assert!(registry.record("wf-2").is_none());
        assert!(registry.record("wf-1").is_some());
        assert_eq!(registry.prune_inactive(), 0);
    }

    #[test]
    fn pending_update_is_consumed_exactly_once() {
        let mut registry = ActivationRegistry::new();
        activated(&mut registry, "wf-1", T0);
        registry
            .request_update(
                "wf-1",
                wf("wf-1", 2),
                ActivationMode::Update,
                T0 + 500,
                None,
                T0 + 1,
            )
            .unwrap();
        assert!(registry.pending_update("wf-1").is_some());
        registry.finish_drain("wf-1", None, T0 + 2).unwrap();
        registry.finish_deactivation("wf-1", None, T0 + 3).unwrap();
        assert!(registry.take_pending_update("wf-1").is_some());
        assert!(
            registry.take_pending_update("wf-1").is_none(),
            "tidak ada duplikasi"
        );
    }

    #[test]
    fn request_update_rejects_mismatched_target_and_unknown_workflow() {
        let mut registry = ActivationRegistry::new();
        activated(&mut registry, "wf-1", T0);
        assert!(registry
            .request_update(
                "wf-1",
                wf("wf-222", 2),
                ActivationMode::Update,
                T0 + 500,
                None,
                T0
            )
            .is_err());
        assert!(matches!(
            registry.request_update(
                "ghost",
                wf("ghost", 2),
                ActivationMode::Update,
                T0 + 500,
                None,
                T0
            ),
            Err(ActivationTransitionError::UnknownWorkflow { .. })
        ));
    }
}
