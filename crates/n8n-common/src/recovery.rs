//! P4.7 (Agent 2) — **Recovery, reconciliation & race safety**.
//!
//! Melengkapi lifecycle P4.2 dengan instrumen daya-tahan yang selama ini
//! sengaja ditunda: (1) **journal** append-only terbatas dari kejadian
//! lifecycle (replayable), (2) **leadership lease** untuk menolak command dari
//! leader lama (leader change / failover), (3) **recovery plan** murni yang
//! memetakan state terputus (interrupted activation, stalled drain, orphan,
//! desired-missing) menjadi aksi konkret. Ini adalah lapisan *edit* ke
//! registry yang tetap sinkron-single-writer: host memegang lock eksternalnya,
//! modul ini menyediakan **bukti** bahwa setiap transisi dapat di-replay dan
//! setiap command dari instance basi dapat ditolak secara fail-closed.
//!
//! Batas: bukan scheduler kedua, bukan sistem terdistribusi; lease adalah
//! guard deterministik (`instance_id`, `epoch`, `expires_at`) — pemilihan
//! pemimpin tetap milik host/Manager.

use crate::activation::{ActivationRegistry, ReconcilePlan};
use crate::ingress_contract::{ActivationState, Generation};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

// ---------------------------------------------------------------------------
// Journal bounded
// ---------------------------------------------------------------------------

/// Kapasitas journal (bounded; drop-oldest saat penuh).
pub const MAX_JOURNAL_ENTRIES: usize = 1024;

/// Kategori kejadian lifecycle yang di-journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LifecycleEvent {
    ActivationStarted,
    ActivationCommitted,
    ActivationAborted,
    ActivationFailed,
    Degraded,
    Recovered,
    DrainBegan,
    DrainFinished,
    DeactivationFinished,
    DeactivationFailed,
    /// Route/schedule di-unmount oleh cleanup/reconcile (stale).
    StaleRouteRemoved,
}

/// Satu entri journal (immutable, replayable).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub seq: u64,
    pub workflow_id: String,
    pub event: LifecycleEvent,
    pub generation: Generation,
    pub at_ms: u64,
}

/// Append-only log berbatas. Digerakkan host (transaksi replayable) —
/// registry sendiri tidak berubah; journal adalah proyeksi audit.
#[derive(Debug, Default, Clone)]
pub struct Journal {
    entries: VecDeque<JournalEntry>,
    next_seq: u64,
    dropped: u64,
}

impl Journal {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn append(
        &mut self,
        workflow_id: impl Into<String>,
        event: LifecycleEvent,
        generation: Generation,
        at_ms: u64,
    ) -> JournalEntry {
        let seq = self.next_seq;
        self.next_seq += 1;
        let entry = JournalEntry {
            seq,
            workflow_id: workflow_id.into(),
            event,
            generation,
            at_ms,
        };
        self.entries.push_back(entry.clone());
        if self.entries.len() > MAX_JOURNAL_ENTRIES {
            self.entries.pop_front();
            self.dropped = self.dropped.saturating_add(1);
        }
        entry
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn dropped_entries(&self) -> u64 {
        self.dropped
    }

    /// Entri sejak `after_seq` (eksklusif) — untuk replay partial.
    pub fn replay_from(&self, after_seq: u64) -> Vec<JournalEntry> {
        self.entries
            .iter()
            .filter(|e| e.seq > after_seq)
            .cloned()
            .collect()
    }

    pub fn latest_seq(&self) -> Option<u64> {
        self.entries.back().map(|e| e.seq)
    }
}

// ---------------------------------------------------------------------------
// Leadership lease — race safety saat failover
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LeaseError {
    #[error("lease kosong — tidak ada pemimpin aktif")]
    Vacant,
    #[error("lease kadaluwarsa pada {expires_at_ms} (sekarang {now_ms})")]
    Expired { expires_at_ms: u64, now_ms: u64 },
    #[error("lease dipegang '{holder}', bukan '{caller}'")]
    HeldByOther { holder: String, caller: String },
}

/// Guard deterministik leadership: satu `instance_id` per `epoch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderLease {
    ttl_ms: u64,
    holder: Option<String>,
    epoch: u64,
    expires_at_ms: u64,
}

impl LeaderLease {
    pub fn new(ttl_ms: u64) -> Self {
        Self {
            ttl_ms,
            holder: None,
            epoch: 0,
            expires_at_ms: 0,
        }
    }

    /// Coba ambil lease (sukses bila kosong/kadaluwarsa). Epoch naik tiap
    /// kepemilikan baru — command dari holder lama (epoch lebih rendah) gagal.
    pub fn acquire(&mut self, instance_id: &str, now_ms: u64) -> bool {
        let can_take = self
            .holder
            .as_deref()
            .is_none_or(|h| h != instance_id && self.expires_at_ms <= now_ms);
        if !can_take {
            return false;
        }
        self.holder = Some(instance_id.to_string());
        self.epoch += 1;
        self.expires_at_ms = now_ms + self.ttl_ms;
        true
    }

    /// Perpanjang masa berlaku — hanya pemilik sah.
    pub fn renew(&mut self, instance_id: &str, now_ms: u64) -> bool {
        match (&self.holder, self.expires_at_ms <= now_ms) {
            (Some(holder), false) if holder == instance_id => {
                self.expires_at_ms = now_ms + self.ttl_ms;
                true
            }
            _ => false,
        }
    }

    /// Lepas — hanya pemilik sah.
    pub fn release(&mut self, instance_id: &str) -> bool {
        if self.holder.as_deref() == Some(instance_id) {
            self.holder = None;
            self.expires_at_ms = 0;
            self.epoch += 1;
            true
        } else {
            false
        }
    }

    pub fn holder(&self) -> Option<&str> {
        self.holder.as_deref()
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }

    /// Validasi command: pemanggil wajib pemegang aktif. Fail-closed.
    pub fn assert_held_by(&self, instance_id: &str, now_ms: u64) -> Result<(), LeaseError> {
        let holder = self.holder.as_deref().ok_or(LeaseError::Vacant)?;
        if holder != instance_id {
            return Err(LeaseError::HeldByOther {
                holder: holder.to_string(),
                caller: instance_id.to_string(),
            });
        }
        if self.expires_at_ms <= now_ms {
            return Err(LeaseError::Expired {
                expires_at_ms: self.expires_at_ms,
                now_ms,
            });
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Recovery plan — interfering-state → action murni
// ---------------------------------------------------------------------------

/// Aksi recovery host (diterapkan dengan command lifecycle P4.2 yang idempotent).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryAction {
    /// `Draining`/`Deactivating` terputus → `finish_drain`/`finish_deactivation`.
    ResumeDrain { workflow_id: String },
    /// `Activating` macet (melebihi grace) → host pilih abort/retry.
    ActivatingStalled { workflow_id: String, since_ms: u64 },
    /// `Failed` yang masih desired → `begin_activation` baru.
    RetryActivation { workflow_id: String },
    /// Serving tapi tidak desired → `deactivate`.
    DeactivateOrphan { workflow_id: String },
    /// Desired tapi belum ada record → `begin_activation`.
    ReactivateDesired { workflow_id: String },
}

/// Rencana recovery penuh: aksi order-first (drain → deactivate → retry →
/// activate) + [`ReconcilePlan`] kompatibel (dari P4.2).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecoveryPlan {
    pub actions: Vec<RecoveryAction>,
    pub reconcile: Option<ReconcilePlan>,
}

/// Hitung rencana recovery deterministik dari registry + daftar desired.
///
/// `activating_grace_ms`: batas toleransi `Activating` (interrupted) sebelum
/// dianggap stalled. Urutan aksi canonical (aman di-replay):
/// 1) selesaikan teardown yang terputus;
/// 2) tangani stalled/orphan;
/// 3) retry failed;
/// 4) aktifkan desired yang hilang.
pub fn recovery_plan(
    registry: &ActivationRegistry,
    desired: &[crate::ingress_contract::WorkflowIdentity],
    now_ms: u64,
    activating_grace_ms: u64,
) -> RecoveryPlan {
    let mut actions = Vec::new();
    for record in registry.records() {
        let workflow_id = record.workflow.workflow_id.clone();
        let wanted = desired.iter().any(|w| w.workflow_id == workflow_id);
        match record.state {
            ActivationState::Draining | ActivationState::Deactivating => {
                actions.push(RecoveryAction::ResumeDrain { workflow_id });
            }
            ActivationState::Activating => {
                if now_ms.saturating_sub(record.entered_state_at_ms) > activating_grace_ms {
                    actions.push(RecoveryAction::ActivatingStalled {
                        since_ms: record.entered_state_at_ms,
                        workflow_id,
                    });
                }
            }
            ActivationState::Failed if wanted => {
                actions.push(RecoveryAction::RetryActivation { workflow_id });
            }
            ActivationState::Active | ActivationState::Degraded if !wanted => {
                actions.push(RecoveryAction::DeactivateOrphan { workflow_id });
            }
            _ => {}
        }
    }
    let missing: Vec<_> = desired
        .iter()
        .filter(|w| registry.record(&w.workflow_id).is_none())
        .map(|w| RecoveryAction::ReactivateDesired {
            workflow_id: w.workflow_id.clone(),
        })
        .collect();
    actions.extend(missing);
    // urutan prioritas: drain dulu, lalu deactivate, retry, reactivate
    actions.sort_by_key(|a| match a {
        RecoveryAction::ResumeDrain { .. } => 0,
        RecoveryAction::DeactivateOrphan { .. } => 1,
        RecoveryAction::ActivatingStalled { .. } => 2,
        RecoveryAction::RetryActivation { .. } => 3,
        RecoveryAction::ReactivateDesired { .. } => 4,
    });
    let reconcile = Some(registry.reconcile(desired));
    RecoveryPlan { actions, reconcile }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activation::DeactivationKind;
    use crate::ingress_contract::{ActivationMode, WorkflowIdentity};

    const T0: u64 = 100_000;

    fn wf(id: &str) -> WorkflowIdentity {
        WorkflowIdentity {
            workflow_id: id.to_string(),
            workflow_version_id: None,
        }
    }

    fn active(registry: &mut ActivationRegistry, id: &str, now: u64) {
        registry
            .begin_activation(wf(id), ActivationMode::Activate, None, None, now)
            .unwrap();
        registry.commit_activation(id, None, now + 1).unwrap();
    }

    // ------------------------------------------------------------- journal

    #[test]
    fn journal_is_replayable_and_bounded() {
        let mut journal = Journal::new();
        let mut last = 0;
        for i in 0..(MAX_JOURNAL_ENTRIES as u64 + 50) {
            last = journal
                .append(
                    "wf-1",
                    LifecycleEvent::ActivationCommitted,
                    Generation::new(i),
                    T0,
                )
                .seq;
        }
        assert_eq!(journal.len(), MAX_JOURNAL_ENTRIES);
        assert_eq!(journal.dropped_entries(), 50);
        // replay partial sejak seq terakhir yang tersisa +1 → kosong
        let leftover = journal.replay_from(last);
        assert!(leftover.is_empty());
        // replay dari dropped boundary → semua yang tersisa
        assert_eq!(journal.replay_from(49).len(), MAX_JOURNAL_ENTRIES);
    }

    #[test]
    fn journal_replay_from_returns_entry_after_seq() {
        let mut journal = Journal::new();
        journal.append(
            "wf-1",
            LifecycleEvent::ActivationStarted,
            Generation::new(1),
            T0,
        );
        journal.append(
            "wf-1",
            LifecycleEvent::ActivationCommitted,
            Generation::new(1),
            T0 + 1,
        );
        let entries = journal.replay_from(0);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].event, LifecycleEvent::ActivationCommitted);
    }

    // ---------------------------------------------------------------- lease

    #[test]
    fn lease_acquire_renew_expire_release() {
        let mut lease = LeaderLease::new(30_000);
        assert!(lease.acquire("node-a", T0));
        assert_eq!(lease.holder(), Some("node-a"));
        assert_eq!(lease.epoch(), 1);
        assert!(lease.renew("node-a", T0 + 10_000));
        // pemegang lain tidak bisa perpanjang
        assert!(!lease.renew("node-b", T0 + 20_000));
        // kadaluwarsa → ambil alih oleh node-b
        assert!(lease.acquire("node-b", T0 + 40_000));
        assert_eq!(lease.holder(), Some("node-b"));
        assert_eq!(lease.epoch(), 2);
        // release hanya pemilik
        assert!(!lease.release("node-a"));
        assert!(lease.release("node-b"));
        assert!(lease.holder().is_none());
    }

    #[test]
    fn lease_asserts_reject_wrong_and_expired() {
        let mut lease = LeaderLease::new(10_000);
        lease.acquire("node-a", T0);
        assert!(lease.assert_held_by("node-a", T0 + 5_000).is_ok());
        assert!(matches!(
            lease.assert_held_by("node-b", T0 + 5_000),
            Err(LeaseError::HeldByOther { .. })
        ));
        assert!(matches!(
            lease.assert_held_by("node-a", T0 + 15_000),
            Err(LeaseError::Expired { .. })
        ));
        lease.release("node-a");
        assert!(matches!(
            lease.assert_held_by("node-a", T0),
            Err(LeaseError::Vacant)
        ));
    }

    // ------------------------------------------------------------- recovery

    #[test]
    fn recovery_plan_orders_and_classifies_states() {
        let mut registry = ActivationRegistry::new();
        // serving & desired → no action
        active(&mut registry, "wf-keep", T0);
        // serving & not desired → DeactivateOrphan
        active(&mut registry, "wf-orphan", T0);
        // failed & desired → RetryActivation
        registry
            .begin_activation(wf("wf-failed"), ActivationMode::Activate, None, None, T0)
            .unwrap();
        registry
            .fail_activation(
                "wf-failed",
                crate::ingress_contract::ActivationError {
                    message: "boom".to_string(),
                    node: None,
                    at_ms: T0,
                },
                None,
                T0,
            )
            .unwrap();
        // draining (interrupted) → ResumeDrain
        active(&mut registry, "wf-drain", T0);
        registry
            .deactivate(
                "wf-drain",
                DeactivationKind::Graceful {
                    drain_deadline_ms: T0 + 9000,
                },
                None,
                T0 + 1,
            )
            .unwrap();

        let desired = vec![wf("wf-keep"), wf("wf-failed"), wf("wf-missing")];
        let plan = recovery_plan(&registry, &desired, T0 + 10, 1000);

        let mut seen = plan.actions.iter().map(|a| std::mem::discriminant(a));
        // 1 resume-drain + 1 deactivate-orphan + 1 retry + 1 reactivate
        assert_eq!(plan.actions.len(), 4);
        assert!(
            matches!(&plan.actions[0], RecoveryAction::ResumeDrain { workflow_id } if workflow_id == "wf-drain")
        );
        assert!(
            matches!(&plan.actions[1], RecoveryAction::DeactivateOrphan { workflow_id } if workflow_id == "wf-orphan")
        );
        assert!(
            matches!(&plan.actions[2], RecoveryAction::RetryActivation { workflow_id } if workflow_id == "wf-failed")
        );
        assert!(
            matches!(&plan.actions[3], RecoveryAction::ReactivateDesired { workflow_id } if workflow_id == "wf-missing")
        );
        let _ = seen.next();
        assert!(plan.reconcile.is_some());
    }

    #[test]
    fn recovery_detects_stalled_activation() {
        let mut registry = ActivationRegistry::new();
        registry
            .begin_activation(wf("wf-slow"), ActivationMode::Activate, None, None, T0)
            .unwrap();
        let plan = recovery_plan(&registry, &[wf("wf-slow")], T0 + 10_000, 1000);
        assert!(plan.actions.iter().any(|a| matches!(
            a,
            RecoveryAction::ActivatingStalled { workflow_id, .. } if workflow_id == "wf-slow"
        )));
        // dalam grace → tidak stalled
        let plan2 = recovery_plan(&registry, &[wf("wf-slow")], T0 + 500, 1000);
        assert!(!plan2
            .actions
            .iter()
            .any(|a| matches!(a, RecoveryAction::ActivatingStalled { .. })));
    }

    #[test]
    fn recovery_plan_is_deterministic() {
        let mut registry = ActivationRegistry::new();
        active(&mut registry, "wf-a", T0);
        active(&mut registry, "wf-b", T0);
        let desired = vec![wf("wf-a"), wf("wf-c")];
        let p1 = recovery_plan(&registry, &desired, T0 + 10, 1000);
        let p2 = recovery_plan(&registry, &desired, T0 + 10, 1000);
        assert_eq!(p1, p2);
    }
}
