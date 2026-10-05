//! Loop iteration manager — task `execution-engine/m2-03-loop-iteration-manager`.
//!
//! Manajemen iterasi per item pada node `SplitInBatches` / `LoopOverItems`:
//! setiap iterasi batch bekerja pada **frame yang terisolasi** (hanya item batch
//! itu yang terlihat; tulisan dari frame iterasi lama ditolak), dan seluruh
//! output iterasi **digabung menjadi satu array** saat loop selesai.
//!
//! Acceptance criteria (dekomposisi M2 item 3):
//! 1. *Menjaga isolasi frame antar iterasi batch* — [LoopManager::next_batch]
//!    mengembalikan item yang saling leluasa antar iterasi, dan
//!    [LoopManager::record_iteration_output] menolak tulisan dari frame iterasi
//!    yang sudah lewat (atau belum dimulai) — guard isolasi.
//! 2. *Menggabungkan output array pada akhir loop* — [LoopManager::finish]
//!    menyusun ulang output seluruh iterasi secara berurutan menjadi satu
//!    array datar, hanya setelah seluruh batch dikonsumsi.
//!
//! Desain: komponen berdiri sendiri (decoupled) seperti `m8-04` — tidak
//! bergantung pada eksekusi node; `WorkflowRunner`/node executor memanggilnya
//! sebagai buku besar iterasi. Tanpa dependensi siklus: hanya `n8n-execution-data`
//! (DataRecord/ItemBuffer) dan serde_json.

use crate::runtime::ir::NodeIndex;
use n8n_execution_data::DataRecord;
use std::collections::HashMap;
use thiserror::Error;

/// Kesalahan pengelolaan loop. Deterministik, tanpa pesan ambigu.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum LoopError {
    #[error("loop for node {0} was not started")]
    NodeNotStarted(NodeIndex),
    #[error("loop for node {0} is already active; finish it before beginning another")]
    LoopAlreadyActive(NodeIndex),
    #[error("batch size must be >= 1 (got {0})")]
    InvalidBatchSize(usize),
    #[error("stale or unknown iteration frame for node {node}: expected iteration {expected}, got {got}")]
    StaleIterationFrame {
        node: NodeIndex,
        expected: u32,
        got: u32,
    },
    #[error("loop for node {node} is incomplete: {remaining} of {total} batches not consumed")]
    BatchesPending {
        node: NodeIndex,
        remaining: usize,
        total: usize,
    },
    #[error("loop for node {0} already finished")]
    LoopAlreadyFinished(NodeIndex),
}

#[derive(Debug)]
struct NodeLoopState {
    batch_size: usize,
    /// Item yang belum terbagi ke batch mana pun.
    pending: Vec<DataRecord>,
    total_batches: usize,
    batches_served: usize,
    /// Iterasi yang sedang berjalan (None = antara batch / belum mulai).
    current_iteration: Option<u32>,
    next_iteration: u32,
    /// Output tiap iterasi, disimpan berurutan untuk penggabungan akhir.
    iteration_outputs: Vec<(u32, Vec<DataRecord>)>,
    finished: bool,
}

/// Buku besar iterasi loop, multi-node: satu manager untuk seluruh runtime.
#[derive(Debug, Default)]
pub struct LoopManager {
    states: HashMap<NodeIndex, NodeLoopState>,
}

/// Penyerahan satu batch ke frame iterasi: berisi id iterasi + item miliknya saja.
#[derive(Debug)]
pub struct LoopBatch {
    pub iteration: u32,
    pub items: Vec<DataRecord>,
}

impl LoopManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mulai loop untuk `node` dengan seluruh item kerja dan ukuran batch.
    /// `batch_size >= 1`. Jumlah batch = ceil(items.len() / batch_size);
    /// 0 item = loop langsung selesai saat [Self::finish] dipanggil.
    pub fn begin(
        &mut self,
        node: NodeIndex,
        items: Vec<DataRecord>,
        batch_size: usize,
    ) -> Result<(), LoopError> {
        if batch_size == 0 {
            return Err(LoopError::InvalidBatchSize(0));
        }
        if let Some(state) = self.states.get(&node) {
            if state.finished {
                // Loop selesai boleh dimulai ulang (run berikutnya).
            } else if state.current_iteration.is_some()
                || state.batches_served < state.total_batches
                || !state.pending.is_empty()
            {
                return Err(LoopError::LoopAlreadyActive(node));
            }
        }
        let total_batches = items.len().div_ceil(batch_size);
        self.states.insert(
            node,
            NodeLoopState {
                batch_size,
                pending: items,
                total_batches,
                batches_served: 0,
                current_iteration: None,
                next_iteration: 0,
                iteration_outputs: Vec::new(),
                finished: false,
            },
        );
        Ok(())
    }

    /// Ambil batch berikutnya untuk frame iterasi baru.
    /// Mengembalikan `None` bila seluruh batch sudah diserahkan.
    /// Item tiap batch saling leluasa (isolasi antar iterasi).
    pub fn next_batch(&mut self, node: NodeIndex) -> Result<Option<LoopBatch>, LoopError> {
        let state = self
            .states
            .get_mut(&node)
            .ok_or(LoopError::NodeNotStarted(node))?;
        if state.finished {
            return Err(LoopError::LoopAlreadyFinished(node));
        }
        // Iterasi sebelumnya wajib sudah ditutup sebelum batch berikutnya keluar:
        // frame lama tidak boleh masih aktif saat frame baru dibuat.
        if let Some(open) = state.current_iteration {
            return Err(LoopError::StaleIterationFrame {
                node,
                expected: open,
                got: open,
            });
        }
        if state.pending.is_empty() || state.batches_served >= state.total_batches {
            return Ok(None);
        }
        let take = state.batch_size.min(state.pending.len());
        let items: Vec<DataRecord> = state.pending.drain(..take).collect();
        let iteration = state.next_iteration;
        state.next_iteration += 1;
        state.current_iteration = Some(iteration);
        state.batches_served += 1;
        Ok(Some(LoopBatch { iteration, items }))
    }

    /// Tutup frame iterasi `iteration` dengan outputnya.
    /// Menolak tulisan frame iterasi yang sudah lewat / belum dimulai
    /// (guard isolasi frame antar iterasi).
    pub fn record_iteration_output(
        &mut self,
        node: NodeIndex,
        iteration: u32,
        outputs: Vec<DataRecord>,
    ) -> Result<(), LoopError> {
        let state = self
            .states
            .get_mut(&node)
            .ok_or(LoopError::NodeNotStarted(node))?;
        match state.current_iteration {
            Some(current) if current == iteration => {
                state.current_iteration = None;
                state.iteration_outputs.push((iteration, outputs));
                Ok(())
            }
            Some(current) => Err(LoopError::StaleIterationFrame {
                node,
                expected: current,
                got: iteration,
            }),
            None => {
                // Tidak ada frame aktif: id apa pun dianggap basi/tak dikenal.
                let expected = state.next_iteration.saturating_sub(1);
                Err(LoopError::StaleIterationFrame {
                    node,
                    expected,
                    got: iteration,
                })
            }
        }
    }

    /// Gabungkan output seluruh iterasi menjadi satu array berurutan.
    /// Hanya sah setelah semua batch dikonsumsi dan semua frame ditutup —
    /// loop yang belum tuntas tidak pernah menghasilkan output parsial.
    pub fn finish(&mut self, node: NodeIndex) -> Result<Vec<DataRecord>, LoopError> {
        let state = self
            .states
            .get_mut(&node)
            .ok_or(LoopError::NodeNotStarted(node))?;
        if state.finished {
            return Err(LoopError::LoopAlreadyFinished(node));
        }
        let remaining = state.total_batches - state.batches_served;
        if remaining > 0 || state.current_iteration.is_some() {
            return Err(LoopError::BatchesPending {
                node,
                remaining: remaining + usize::from(state.current_iteration.is_some()),
                total: state.total_batches,
            });
        }
        let mut merged = Vec::new();
        for (_, mut outs) in std::mem::take(&mut state.iteration_outputs) {
            merged.append(&mut outs);
        }
        state.finished = true;
        Ok(merged)
    }

    /// Introspection: (iterasi yang sudah diserahkan, batch tersisa).
    pub fn progress(&self, node: NodeIndex) -> Option<(u32, usize)> {
        let state = self.states.get(&node)?;
        Some((
            state.next_iteration,
            state.total_batches - state.batches_served,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn records(vals: &[u64]) -> Vec<DataRecord> {
        vals.iter()
            .map(|v| DataRecord::new(json!({"v": v})))
            .collect()
    }

    fn vals(rs: &[DataRecord]) -> Vec<u64> {
        rs.iter().map(|r| r.json["v"].as_u64().unwrap()).collect()
    }

    #[test]
    fn test_batches_are_disjoint_across_iterations() {
        // Isolasi item antar iterasi: tiap batch hanya melihat miliknya.
        let mut m = LoopManager::new();
        m.begin(1, records(&[1, 2, 3, 4, 5]), 2).unwrap();
        let b0 = m.next_batch(1).unwrap().unwrap();
        assert_eq!(b0.iteration, 0);
        assert_eq!(vals(&b0.items), vec![1, 2]);
        m.record_iteration_output(1, b0.iteration, vec![]).unwrap();
        let b1 = m.next_batch(1).unwrap().unwrap();
        assert_eq!(b1.iteration, 1);
        assert_eq!(vals(&b1.items), vec![3, 4]);
        m.record_iteration_output(1, b1.iteration, vec![]).unwrap();
        let b2 = m.next_batch(1).unwrap().unwrap();
        assert_eq!(b2.iteration, 2);
        assert_eq!(vals(&b2.items), vec![5]);
        m.record_iteration_output(1, b2.iteration, vec![]).unwrap();
        assert!(m.next_batch(1).unwrap().is_none());
    }

    #[test]
    fn test_second_batch_requires_closing_first_frame() {
        // Guard isolasi: frame iterasi 0 harus ditutup sebelum frame 1 dibuat.
        let mut m = LoopManager::new();
        m.begin(1, records(&[1, 2, 3, 4]), 2).unwrap();
        let b0 = m.next_batch(1).unwrap().unwrap();
        assert!(matches!(
            m.next_batch(1),
            Err(LoopError::StaleIterationFrame { .. })
        ));
        m.record_iteration_output(1, b0.iteration, records(&[10, 11]))
            .unwrap();
        let b1 = m.next_batch(1).unwrap().unwrap();
        assert_eq!(b1.iteration, 1);
    }

    #[test]
    fn test_stale_iteration_frame_write_rejected() {
        // Isolasi frame: tulisan dari frame iterasi lama (atau tak dikenal) ditolak.
        let mut m = LoopManager::new();
        m.begin(7, records(&[1, 2, 3]), 1).unwrap();
        let b0 = m.next_batch(7).unwrap().unwrap();
        m.record_iteration_output(7, 0, records(&[100])).unwrap();

        // Frame basi (iterasi 0) mencoba menulis lagi setelah iterasi maju.
        let err = m
            .record_iteration_output(7, 0, records(&[999]))
            .unwrap_err();
        assert!(matches!(err, LoopError::StaleIterationFrame { got: 0, .. }));

        // Frame yang belum pernah ada juga ditolak.
        let err = m.record_iteration_output(7, 42, vec![]).unwrap_err();
        assert!(matches!(
            err,
            LoopError::StaleIterationFrame { got: 42, .. }
        ));
        drop(b0);
    }

    #[test]
    fn test_outputs_merged_as_single_array_at_finish() {
        // Acceptance: menggabungkan output array pada akhir loop.
        let mut m = LoopManager::new();
        m.begin(3, records(&[1, 2, 3, 4, 5, 6]), 2).unwrap();
        while let Some(b) = m.next_batch(3).unwrap() {
            let doubled: Vec<DataRecord> = b
                .items
                .iter()
                .map(|r| DataRecord::new(json!({"v": r.json["v"].as_u64().unwrap() * 2})))
                .collect();
            m.record_iteration_output(3, b.iteration, doubled).unwrap();
        }
        let merged = m.finish(3).unwrap();
        assert_eq!(vals(&merged), vec![2, 4, 6, 8, 10, 12]);
    }

    #[test]
    fn test_finish_rejects_incomplete_loop() {
        let mut m = LoopManager::new();
        m.begin(1, records(&[1, 2, 3]), 1).unwrap();
        let b0 = m.next_batch(1).unwrap().unwrap();
        m.record_iteration_output(1, b0.iteration, vec![]).unwrap();
        // Dua batch tersisa — finish dilarang (tidak ada output parsial).
        let err = m.finish(1).unwrap_err();
        assert!(matches!(
            err,
            LoopError::BatchesPending {
                remaining: 2,
                total: 3,
                ..
            }
        ));
    }

    #[test]
    fn test_empty_items_finish_with_empty_merged_array() {
        let mut m = LoopManager::new();
        m.begin(9, vec![], 4).unwrap();
        assert!(m.next_batch(9).unwrap().is_none());
        assert!(m.finish(9).unwrap().is_empty());
    }

    #[test]
    fn test_invalid_batch_size_rejected() {
        let mut m = LoopManager::new();
        assert_eq!(m.begin(1, vec![], 0), Err(LoopError::InvalidBatchSize(0)));
    }

    #[test]
    fn test_parallel_loops_are_isolated_per_node() {
        // Dua node ber-loop serentak tidak saling memengaruhi frame/state.
        let mut m = LoopManager::new();
        m.begin(1, records(&[1, 2]), 1).unwrap();
        m.begin(2, records(&[10, 20, 30]), 2).unwrap();
        let a = m.next_batch(1).unwrap().unwrap();
        let b = m.next_batch(2).unwrap().unwrap();
        assert_eq!(vals(&a.items), vec![1]);
        assert_eq!(vals(&b.items), vec![10, 20]);
        // Menutup frame node 2 tidak membuka frame node 1.
        m.record_iteration_output(2, b.iteration, vec![]).unwrap();
        m.record_iteration_output(1, a.iteration, vec![]).unwrap();
        let a2 = m.next_batch(1).unwrap().unwrap();
        assert_eq!(vals(&a2.items), vec![2]);
    }

    #[test]
    fn test_rebegin_after_finish_allowed() {
        let mut m = LoopManager::new();
        m.begin(1, records(&[1]), 1).unwrap();
        let b = m.next_batch(1).unwrap().unwrap();
        m.record_iteration_output(1, b.iteration, vec![]).unwrap();
        m.finish(1).unwrap();
        // Run berikutnya: begin lagi harus sah.
        m.begin(1, records(&[2, 3]), 1).unwrap();
        assert!(m.next_batch(1).unwrap().is_some());
    }
}
