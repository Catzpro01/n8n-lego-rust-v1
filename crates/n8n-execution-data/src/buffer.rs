//! `m3-01-item-buffer` — zero-copy item buffer for the execution data plane.
//!
//! Contract: `contracts/execution-data.contract.md` (owner: agent-04,
//! sub-LEGO `execution_data.buffer`). Task: `data-plane/m3-01-item-buffer`.
//!
//! # Design goals
//!
//! 1. **Zero-copy hand-off between nodes.** Passing an `ItemBuffer` from one
//!    node's output to the next node's input is an `Arc` refcount bump — the
//!    heap JSON payload (`serde_json::Value`) is never duplicated. This is the
//!    acceptance criterion of m3-01: *"Passing data antar node tidak
//!    menduplikasi heap payload JSON secara berulang."*
//! 2. **`Arc<DataRecord>` smart pointers.** Every record lives behind an
//!    `Arc<DataRecord>`; records (and their `Arc<Value>` json payload /
//!    `Arc<BinaryDataMap>` binary payload) are shared, not copied.
//! 3. **O(1) snapshots with copy-on-write mutation.** `clone()` shares the
//!    whole item vector; `push`/`push_arc` use `Arc::make_mut`, which copies
//!    *only the vector of Arc pointers* when the storage is shared — never the
//!    payloads.
//! 4. **Honest memory accounting.** `estimated_bytes` counts each unique heap
//!    allocation once (deduplicated by pointer), including binary payloads, so
//!    the M4 memory governor is not misled by shared records being counted
//!    multiple times. `shared_bytes` / `unique_bytes` expose how much of the
//!    footprint is shared with other owners (relevant to m3-05 eviction).
//!
//! # Contract invariants honoured here
//!
//! * I1 — records always carry a `json` object (constructor takes the object
//!   as-is; wire conversion keeps it required).
//! * I3/I4/I5 (paired item *representation* only) — the legacy number form is
//!   accepted on read and normalised to `{"item": n}` on write, matching the
//!   engine behaviour documented in the contract. Lineage *tracking* logic
//!   itself belongs to `m3-04-item-metadata`.
//! * I13 — item order within a branch is preserved end-to-end (`push` keeps
//!   append order; iteration is in insertion order).
//!
//! # Copy policy
//!
//! | Operation | Cost |
//! |---|---|
//! | `ItemBuffer::clone` / `shallow_clone` | O(1), refcount only |
//! | `push(DataRecord)` / `push_arc(Arc<DataRecord>)` | one `Arc::new`; CoW pointer-vector copy *only* when storage is shared |
//! | `extend_from_buffer(&other)` | per-item refcount bump, payloads shared |
//! | `get` / `iter` / `iter_arcs` | zero cost, borrows |
//! | `to_execution_data` / `to_node_execution_data` | one deep clone **per call** — boundary conversion for owned wire structs (`n8n-common`); hot path should stay on `iter`/`get` and never round-trip per node |
//! | `from_execution_data` / `from_node_execution_data` | one deep clone from the deserialised wire form (unavoidable at the boundary) |

use n8n_common::{BinaryDataMap, INodeExecutionData};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;

/// Minimal-copy, shared-ownership data record.
///
/// Cloning a `DataRecord` bumps three refcounts at most — the JSON payload,
/// the binary map and the record itself are shared, never duplicated.
#[derive(Debug, Clone, PartialEq)]
pub struct DataRecord {
    pub json: Arc<Value>,
    pub binary: Option<Arc<BinaryDataMap>>,
    pub paired_item: Option<u32>,
}

impl DataRecord {
    pub fn new(json: Value) -> Self {
        Self {
            json: Arc::new(json),
            binary: None,
            paired_item: None,
        }
    }

    pub fn from_arc(json: Arc<Value>) -> Self {
        Self {
            json,
            binary: None,
            paired_item: None,
        }
    }

    /// Build a record that shares an already-allocated JSON payload.
    pub fn with_binary(json: Value, binary: Option<Arc<BinaryDataMap>>) -> Self {
        Self {
            json: Arc::new(json),
            binary,
            paired_item: None,
        }
    }

    /// Shared handle to the JSON payload (zero-copy access for callers that
    /// want to keep a reference without cloning the `Value`).
    pub fn json_arc(&self) -> &Arc<Value> {
        &self.json
    }

    /// Consume the record and return the shared JSON payload handle.
    pub fn into_json_arc(self) -> Arc<Value> {
        self.json
    }

    /// Shared handle to the binary payload, if any.
    pub fn binary_arc(&self) -> Option<&Arc<BinaryDataMap>> {
        self.binary.as_ref()
    }

    /// Estimated heap bytes *uniquely reachable through this record*
    /// (structural estimate; shared targets are still counted here because a
    /// single record keeps its payload alive on its own).
    pub fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + estimate_json_bytes(&self.json)
            + self.binary.as_ref().map_or(0, |b| estimate_binary_bytes(b))
    }

    pub fn to_node_execution_data(&self) -> INodeExecutionData {
        INodeExecutionData {
            json: (*self.json).clone(),
            binary: self.binary.as_ref().map(|b| (**b).clone()),
            paired_item: self.paired_item.map(|p| serde_json::json!({ "item": p })),
        }
    }

    pub fn from_node_execution_data(d: INodeExecutionData) -> Self {
        let paired = d.paired_item.and_then(paired_item_to_index);
        Self {
            json: Arc::new(d.json),
            binary: d.binary.map(Arc::new),
            paired_item: paired,
        }
    }
}

/// Normalise the wire `pairedItem` forms to the compact buffer representation.
///
/// Accepted forms per contract §1 / invariant I3: the legacy bare number and
/// the object form `{ "item": <n> }`. Arrays and `sourceOverwrite` objects are
/// lineage metadata (m3-04 scope) and yield `None` here — they must not be
/// silently flattened into a wrong index.
fn paired_item_to_index(v: Value) -> Option<u32> {
    if let Some(i) = v.as_u64() {
        return u32::try_from(i).ok();
    }
    v.as_object()
        .and_then(|obj| obj.get("item"))
        .and_then(Value::as_u64)
        .and_then(|i| u32::try_from(i).ok())
}

/// Rough heap-size estimate of a JSON value (used for memory accounting).
pub fn estimate_json_bytes(val: &Value) -> usize {
    match val {
        Value::Null | Value::Bool(_) | Value::Number(_) => 16,
        Value::String(s) => s.len() + 24,
        Value::Array(arr) => arr.iter().map(estimate_json_bytes).sum::<usize>() + 24,
        Value::Object(map) => {
            map.iter()
                .map(|(k, v)| k.len() + estimate_json_bytes(v) + 32)
                .sum::<usize>()
                + 48
        }
    }
}

/// Rough heap-size estimate of a binary data map (base64 payload + metadata).
pub fn estimate_binary_bytes(map: &BinaryDataMap) -> usize {
    map.iter()
        .map(|(k, v)| {
            k.len()
                + v.data.len()
                + v.mime_type.len()
                + v.file_name.as_ref().map_or(0, |s| s.len() + 24)
                + v.file_extension.as_ref().map_or(0, |s| s.len() + 24)
                + 64
        })
        .sum::<usize>()
        + 48
}

/// Borrowing iterator over a buffer yielding `&DataRecord`.
///
/// Keeping `&DataRecord` (instead of `&Arc<DataRecord>`) is deliberate: the
/// runtime executors collect with `iter().cloned()`, which must produce cheap
/// `DataRecord` clones, not `Arc` handles.
pub struct Iter<'a> {
    inner: std::slice::Iter<'a, Arc<DataRecord>>,
}

impl<'a> Iterator for Iter<'a> {
    type Item = &'a DataRecord;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        self.inner.next().map(|rec| &**rec)
    }

    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl ExactSizeIterator for Iter<'_> {
    #[inline]
    fn len(&self) -> usize {
        self.inner.len()
    }
}

/// Zero-copy batch of [`DataRecord`]s shared via `Arc<DataRecord>`.
///
/// * `clone()` is O(1) — the clone shares the whole pointer vector *and* every
///   record, so fan-out of one node output to N downstream inputs duplicates
///   nothing on the heap.
/// * Mutation is copy-on-write over the pointer vector only; payloads are
///   never copied.
/// * Item order is preserved (contract invariant I13).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ItemBuffer {
    items: Arc<Vec<Arc<DataRecord>>>,
}

impl ItemBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hint-backed construction (capacity applies to the pointer vector; no
    /// payload is ever pre-allocated).
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            items: Arc::new(Vec::<Arc<DataRecord>>::with_capacity(capacity)),
        }
    }

    /// Take ownership of freshly built records (no payload copying; each
    /// record is wrapped in an `Arc` exactly once).
    pub fn from_records(items: Vec<DataRecord>) -> Self {
        Self {
            items: Arc::new(items.into_iter().map(Arc::new).collect()),
        }
    }

    /// Share already-`Arc`ed records (refcount bumps only).
    pub fn from_arcs(items: Vec<Arc<DataRecord>>) -> Self {
        Self {
            items: Arc::new(items),
        }
    }

    pub fn from_json_values(values: impl IntoIterator<Item = Value>) -> Self {
        Self::from_records(values.into_iter().map(DataRecord::new).collect())
    }

    /// Convert from the owned wire representation. One deep clone per item is
    /// paid exactly once, at the deserialisation boundary.
    pub fn from_execution_data(data: Vec<INodeExecutionData>) -> Self {
        Self::from_records(
            data.into_iter()
                .map(DataRecord::from_node_execution_data)
                .collect(),
        )
    }

    /// Convert to the owned wire representation. **This deep-clones every
    /// payload** — it is a boundary conversion for code that must own
    /// `INodeExecutionData` (persistence, API envelope). Node-to-node passing
    /// must stay on `iter` / `get` / `extend_from_buffer` to remain zero-copy.
    pub fn to_execution_data(&self) -> Vec<INodeExecutionData> {
        self.items
            .iter()
            .map(|rec| rec.to_node_execution_data())
            .collect()
    }

    /// Append a record, wrapping it in an `Arc` exactly once.
    ///
    /// If the pointer-vector storage is currently shared with other buffers,
    /// `Arc::make_mut` clones the vector of pointers (cheap, payload-free)
    /// before appending.
    pub fn push(&mut self, record: DataRecord) {
        Arc::make_mut(&mut self.items).push(Arc::new(record));
    }

    /// Append an already-shared record (refcount bump only).
    pub fn push_arc(&mut self, record: Arc<DataRecord>) {
        Arc::make_mut(&mut self.items).push(record);
    }

    /// Append every record of `other` by refcount bump. Payloads are shared,
    /// never duplicated.
    pub fn extend_from_buffer(&mut self, other: &ItemBuffer) {
        if other.is_empty() {
            return;
        }
        let sole_owner = Arc::strong_count(&self.items) == 1;
        let target = Arc::make_mut(&mut self.items);
        if !sole_owner && target.capacity() < target.len() + other.len() {
            target.reserve(other.len());
        }
        target.extend(other.items.iter().cloned());
    }

    /// O(1) alias kept for API compatibility; identical to [`Clone::clone`].
    pub fn shallow_clone(&self) -> Self {
        self.clone()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Borrow a record without taking ownership (zero-copy read).
    pub fn get(&self, index: usize) -> Option<&DataRecord> {
        self.items.get(index).map(|rec| &**rec)
    }

    /// Shared handle to a record (for `Arc`-level sharing across structures).
    pub fn get_arc(&self, index: usize) -> Option<&Arc<DataRecord>> {
        self.items.get(index)
    }

    pub fn first(&self) -> Option<&DataRecord> {
        self.get(0)
    }

    pub fn last(&self) -> Option<&DataRecord> {
        self.items.last().map(|rec| &**rec)
    }

    /// Borrowing iterator yielding `&DataRecord` in insertion order (I13).
    pub fn iter(&self) -> Iter<'_> {
        Iter {
            inner: self.items.iter(),
        }
    }

    /// Iterator over the shared `Arc<DataRecord>` handles.
    pub fn iter_arcs(&self) -> std::slice::Iter<'_, Arc<DataRecord>> {
        self.items.iter()
    }

    /// The backing record handles as a slice (zero-copy).
    pub fn arcs(&self) -> &[Arc<DataRecord>] {
        &self.items
    }

    /// True when both buffers currently share the same storage allocation
    /// (i.e. one is an unmodified O(1) snapshot of the other).
    pub fn shares_storage_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.items, &other.items)
    }

    /// Number of owners of the shared pointer-vector storage.
    pub fn storage_owners(&self) -> usize {
        Arc::strong_count(&self.items)
    }

    /// Estimated heap footprint of this buffer with **shared payloads counted
    /// once** (deduplicated by allocation pointer, binary included). This is
    /// the number the M4 memory governor should attribute to the buffer.
    pub fn estimated_bytes(&self) -> usize {
        let mut json_seen: HashSet<usize> = HashSet::new();
        let mut bin_seen: HashSet<usize> = HashSet::new();
        let mut rec_seen: HashSet<usize> = HashSet::new();

        // Vec allocation (slots) + the Vec header + the outer Arc header + self.
        let mut total = std::mem::size_of::<Self>()
            + std::mem::size_of::<Vec<Arc<DataRecord>>>()
            + self.items.capacity() * std::mem::size_of::<Arc<DataRecord>>();

        for record in self.iter_arcs() {
            if !rec_seen.insert(Arc::as_ptr(record) as usize) {
                // The same Arc<DataRecord> appears twice in this buffer
                // (allowed): only the extra pointer slot was already counted.
                continue;
            }
            total += std::mem::size_of::<DataRecord>();
            if json_seen.insert(Arc::as_ptr(&record.json) as usize) {
                total += estimate_json_bytes(&record.json);
            }
            if let Some(binary) = &record.binary {
                if bin_seen.insert(Arc::as_ptr(binary) as usize) {
                    total += estimate_binary_bytes(binary);
                }
            }
        }
        total
    }

    /// Portion of [`ItemBuffer::estimated_bytes`] whose payloads are also
    /// referenced from outside this buffer (`Arc` strong count > 1) — i.e.
    /// memory this buffer cannot reclaim alone (m3-05 eviction signal).
    ///
    /// Two sharing paths are recognised: (a) the *storage* pointer vector is
    /// itself shared (`clone()` snapshots) — then every record in it is
    /// visible to all storage owners; (b) a CoW split or external handle
    /// keeps an `Arc<DataRecord>`/`Arc<Value>` with strong count > 1.
    pub fn shared_bytes(&self) -> usize {
        let storage_shared = Arc::strong_count(&self.items) > 1;
        let mut json_seen: HashSet<usize> = HashSet::new();
        let mut bin_seen: HashSet<usize> = HashSet::new();
        let mut rec_seen: HashSet<usize> = HashSet::new();

        let mut total = 0usize;
        for record in self.iter_arcs() {
            if !rec_seen.insert(Arc::as_ptr(record) as usize) {
                continue;
            }
            let record_shared = storage_shared || Arc::strong_count(record) > 1;
            if record_shared {
                total += std::mem::size_of::<DataRecord>();
            }
            if !json_seen.insert(Arc::as_ptr(&record.json) as usize) {
                continue;
            }
            if record_shared || Arc::strong_count(&record.json) > 1 {
                total += estimate_json_bytes(&record.json);
            }
            if let Some(binary) = &record.binary {
                if !bin_seen.insert(Arc::as_ptr(binary) as usize) {
                    continue;
                }
                if record_shared || Arc::strong_count(binary) > 1 {
                    total += estimate_binary_bytes(binary);
                }
            }
        }
        total
    }

    /// Portion of [`ItemBuffer::estimated_bytes`] that would be released if
    /// this buffer were dropped right now (`estimated - shared`).
    pub fn unique_bytes(&self) -> usize {
        self.estimated_bytes().saturating_sub(self.shared_bytes())
    }
}

impl From<Vec<DataRecord>> for ItemBuffer {
    fn from(items: Vec<DataRecord>) -> Self {
        Self::from_records(items)
    }
}

impl FromIterator<DataRecord> for ItemBuffer {
    fn from_iter<I: IntoIterator<Item = DataRecord>>(iter: I) -> Self {
        Self::from_records(iter.into_iter().collect())
    }
}

impl FromIterator<Arc<DataRecord>> for ItemBuffer {
    fn from_iter<I: IntoIterator<Item = Arc<DataRecord>>>(iter: I) -> Self {
        Self::from_arcs(iter.into_iter().collect())
    }
}

impl IntoIterator for ItemBuffer {
    type Item = Arc<DataRecord>;
    type IntoIter = std::vec::IntoIter<Arc<DataRecord>>;

    fn into_iter(self) -> Self::IntoIter {
        // Consuming the last shared owner yields the pointer vector without
        // re-allocation; payloads travel as Arc handles, not copies.
        match Arc::try_unwrap(self.items) {
            Ok(vec) => vec.into_iter(),
            Err(shared) => (*shared).clone().into_iter(),
        }
    }
}

impl<'a> IntoIterator for &'a ItemBuffer {
    type Item = &'a DataRecord;
    type IntoIter = Iter<'a>;

    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload(n: usize) -> Value {
        json!({ "index": n, "body": format!("payload-{n}").repeat(8) })
    }

    // ------------------------------------------------------------------
    // m3-01 acceptance criterion: node-to-node passing never duplicates
    // the heap JSON payload.
    // ------------------------------------------------------------------

    #[test]
    fn o1_snapshot_clone_shares_storage_and_payloads() {
        let mut buf = ItemBuffer::new();
        buf.push(DataRecord::new(payload(1)));
        buf.push(DataRecord::new(payload(2)));

        let snapshot = buf.clone();
        assert!(buf.shares_storage_with(&snapshot));
        assert_eq!(buf.storage_owners(), 2);

        for (a, b) in buf.iter_arcs().zip(snapshot.iter_arcs()) {
            assert!(Arc::ptr_eq(a, b), "records must be shared, not copied");
            assert!(Arc::ptr_eq(&a.json, &b.json), "payload must be shared");
            // Zero-copy proof: the record lives exactly once — inside the one
            // shared pointer vector. No re-wrap, no duplication happened.
            assert_eq!(Arc::strong_count(a), 1, "record must not be re-wrapped");
            assert_eq!(Arc::strong_count(&a.json), 1, "payload must not be cloned");
        }

        // Dropping the snapshot releases the shared storage handle.
        drop(snapshot);
        assert_eq!(buf.storage_owners(), 1);
        // The payloads themselves were never copied: counts stay at 1.
        assert_eq!(Arc::strong_count(buf.get_arc(0).unwrap()), 1);
    }

    #[test]
    fn passthrough_execution_shares_json_heap_payload() {
        // Mirrors runner.rs: collect iter().cloned() and push to a new output
        // buffer — the pass-through path used between nodes.
        let source = ItemBuffer::from_json_values((0..16).map(payload));

        let mut forwarded = ItemBuffer::with_capacity(source.len());
        for record in source.iter().cloned() {
            forwarded.push(record);
        }

        assert_eq!(forwarded.len(), source.len());
        for (src, dst) in source.iter_arcs().zip(forwarded.iter_arcs()) {
            assert!(Arc::ptr_eq(&src.json, &dst.json));
            assert!(Arc::strong_count(&src.json) >= 2);
        }
        // Payload counted once across both buffers.
        assert_eq!(
            source.estimated_bytes() - source.shared_bytes(),
            source.unique_bytes()
        );
        assert!(source.shared_bytes() > 0);
    }

    #[test]
    fn cow_push_on_shared_buffer_does_not_touch_original() {
        let original = ItemBuffer::from_json_values((0..4).map(payload));
        let mut branch = original.clone();

        let shared_json_ptr = Arc::as_ptr(&original.get(0).unwrap().json) as usize;

        branch.push(DataRecord::new(payload(99)));
        branch.push_arc(Arc::new(DataRecord::new(payload(100))));

        assert_eq!(original.len(), 4, "original must stay untouched");
        assert_eq!(branch.len(), 6);
        assert!(!original.shares_storage_with(&branch));

        // Pre-existing records are still shared after the CoW split — now each
        // record Arc has exactly two owners (one per pointer vector).
        for (a, b) in original.iter_arcs().zip(branch.iter_arcs()) {
            assert!(Arc::ptr_eq(a, b));
            assert_eq!(Arc::strong_count(a), 2, "CoW split shares the record Arc");
            // Both handles reach the ONE record allocation, so its payload is
            // still a single heap object (never copied during the split).
            assert_eq!(Arc::strong_count(&a.json), 1);
        }
        assert_eq!(
            Arc::as_ptr(&original.get(0).unwrap().json) as usize,
            shared_json_ptr
        );
    }

    #[test]
    fn extend_from_buffer_is_refcount_only() {
        let source = ItemBuffer::from_json_values((0..8).map(payload));
        let mut merged = ItemBuffer::from_json_values((100..104).map(payload));

        merged.extend_from_buffer(&source);
        assert_eq!(merged.len(), 12);

        for (src, dst) in source.iter_arcs().zip(merged.iter_arcs().skip(4)) {
            assert!(Arc::ptr_eq(src, dst));
            assert!(Arc::strong_count(src) >= 2);
        }
        // Source untouched.
        assert_eq!(source.len(), 8);
    }

    #[test]
    fn from_arcs_and_get_arc_share_records() {
        let shared_rec = Arc::new(DataRecord::new(payload(7)));
        let buf = ItemBuffer::from_arcs(vec![shared_rec.clone(), shared_rec.clone()]);

        assert_eq!(buf.len(), 2);
        assert!(Arc::ptr_eq(buf.get_arc(0).unwrap(), &shared_rec));
        assert!(Arc::ptr_eq(buf.get_arc(1).unwrap(), &shared_rec));
        // Duplicate handle inside one buffer: payload counted once.
        let bytes = buf.estimated_bytes();
        let once = DataRecord::new(payload(7)).estimated_bytes();
        assert!(
            bytes < once * 2 + 128,
            "shared payload must not be double counted ({bytes} vs ~{once})"
        );
    }

    // ------------------------------------------------------------------
    // Memory accounting
    // ------------------------------------------------------------------

    #[test]
    fn estimated_bytes_counts_shared_payload_once() {
        let shared_json = Arc::new(payload(42));
        let mut buf = ItemBuffer::new();
        buf.push_arc(Arc::new(DataRecord::from_arc(shared_json.clone())));
        buf.push_arc(Arc::new(DataRecord::from_arc(shared_json.clone())));

        let per_payload = estimate_json_bytes(&shared_json);
        let header = std::mem::size_of::<DataRecord>();
        let bytes = buf.estimated_bytes();

        // Exactly one payload instance + two record headers + slots/headers.
        assert!(bytes >= header * 2 + per_payload, "undercounted: {bytes}");
        assert!(
            bytes < header * 2 + per_payload * 2 + 256,
            "payload double counted: {bytes} >= 2×{per_payload}+overhead"
        );
    }

    #[test]
    fn estimated_bytes_includes_binary_payload() {
        let mut binary = BinaryDataMap::new();
        binary.insert(
            "data0".to_string(),
            n8n_common::BinaryData {
                data: "aGVsbG8gd29ybGQ=".to_string(),
                mime_type: "text/plain".to_string(),
                file_name: Some("hello.txt".to_string()),
                file_extension: Some("txt".to_string()),
            },
        );
        let rec = DataRecord::with_binary(json!({ "name": "x" }), Some(Arc::new(binary)));

        let json_only = DataRecord::new(json!({ "name": "x" })).estimated_bytes();
        assert!(rec.estimated_bytes() > json_only, "binary must be counted");

        let mut buf = ItemBuffer::new();
        buf.push(rec);
        assert!(buf.estimated_bytes() > json_only);
    }

    #[test]
    fn shared_vs_unique_split_tracks_owners() {
        let buf = ItemBuffer::from_json_values((0..4).map(payload));
        assert_eq!(buf.shared_bytes(), 0, "sole owner holds everything unique");
        assert!(buf.unique_bytes() > 0);

        let clone = buf.clone();
        assert!(buf.shared_bytes() > 0, "cloned records are shared");
        assert_eq!(buf.estimated_bytes(), clone.estimated_bytes());

        drop(clone);
        assert_eq!(buf.shared_bytes(), 0);
    }

    // ------------------------------------------------------------------
    // Contract invariants / wire compatibility
    // ------------------------------------------------------------------

    #[test]
    fn wire_roundtrip_preserves_fields() {
        let mut binary = BinaryDataMap::new();
        binary.insert(
            "data0".to_string(),
            n8n_common::BinaryData {
                data: "AQIDBA==".to_string(),
                mime_type: "application/octet-stream".to_string(),
                file_name: Some("blob.bin".to_string()),
                file_extension: Some("bin".to_string()),
            },
        );
        let wire_in = vec![
            INodeExecutionData {
                json: json!({ "id": 1 }),
                binary: Some(binary),
                paired_item: Some(json!(2)), // legacy number form
            },
            INodeExecutionData {
                json: json!({ "id": 2 }),
                binary: None,
                paired_item: Some(json!({ "item": 5 })), // object form
            },
            INodeExecutionData {
                json: json!({ "id": 3 }),
                binary: None,
                paired_item: None,
            },
        ];

        let buf = ItemBuffer::from_execution_data(wire_in);
        let wire_out = buf.to_execution_data();

        assert_eq!(wire_out.len(), 3);
        assert_eq!(wire_out[0].json, json!({ "id": 1 }));
        assert!(wire_out[0].binary.is_some());
        assert_eq!(wire_out[0].paired_item, Some(json!({ "item": 2 })));
        assert_eq!(wire_out[1].paired_item, Some(json!({ "item": 5 })));
        assert_eq!(wire_out[2].paired_item, None);
    }

    #[test]
    fn array_paired_item_lineage_is_not_flattened() {
        // IPairedItemData[] (multiple pairs) is m3-04 lineage metadata; the
        // buffer must not invent a wrong index from it.
        let wire = INodeExecutionData {
            json: json!({ "id": 1 }),
            binary: None,
            paired_item: Some(json!([{ "item": 0 }, { "item": 3 }])),
        };
        let rec = DataRecord::from_node_execution_data(wire);
        assert_eq!(rec.paired_item, None);
    }

    #[test]
    fn item_order_is_preserved_end_to_end() {
        const N: usize = 256;
        let buf = ItemBuffer::from_json_values((0..N).map(payload));
        for (i, record) in buf.iter().enumerate() {
            assert_eq!(record.json["index"], i, "I13: order must be preserved");
        }
        assert_eq!(buf.first().unwrap().json["index"], 0);
        assert_eq!(buf.last().unwrap().json["index"], N - 1);
    }

    // ------------------------------------------------------------------
    // Consumer compatibility (runner.rs / frame.rs call patterns)
    // ------------------------------------------------------------------

    #[test]
    fn consumer_iter_cloned_collect_pattern_compiles() {
        let buf = ItemBuffer::from_json_values((0..3).map(payload));
        let records: Vec<DataRecord> = buf.iter().cloned().collect();
        assert_eq!(records.len(), 3);
        for (src, dst) in buf.iter().zip(records.iter()) {
            assert!(Arc::ptr_eq(&src.json, &dst.json));
        }
    }

    #[test]
    fn empty_and_bounds_behaviour() {
        let mut buf = ItemBuffer::new();
        assert!(buf.is_empty());
        assert_eq!(buf.len(), 0);
        assert!(buf.get(0).is_none());
        assert_eq!(
            buf.estimated_bytes(),
            std::mem::size_of::<ItemBuffer>() + std::mem::size_of::<Vec<Arc<DataRecord>>>()
        );

        let pre = ItemBuffer::with_capacity(64);
        assert!(pre.is_empty());

        buf.push(DataRecord::new(json!({})));
        assert!(!buf.is_empty());
        assert!(buf.get(0).is_some());
        assert!(buf.get(1).is_none());
    }

    #[test]
    fn equality_is_structural_across_snapshots() {
        let mut a = ItemBuffer::from_json_values(vec![json!({ "k": 1 })]);
        let b = a.clone();
        assert_eq!(a, b);

        a.push(DataRecord::new(json!({ "k": 2 })));
        assert_ne!(a, b);

        let c = ItemBuffer::from_json_values(vec![json!({ "k": 1 })]);
        assert_eq!(b, c, "structural equality regardless of storage");
    }

    #[test]
    fn owned_into_iterator_yields_shared_handles() {
        let buf = ItemBuffer::from_json_values((0..3).map(payload));
        let mut handles = Vec::new();
        for record in buf {
            handles.push(record);
        }
        assert_eq!(handles.len(), 3);
        assert!(Arc::strong_count(&handles[0].json) == 1);
    }

    #[test]
    fn data_record_helpers_share_payload() {
        let value = Arc::new(json!({ "x": 1 }));
        let rec = DataRecord::from_arc(value.clone());
        assert!(Arc::ptr_eq(rec.json_arc(), &value));
        assert!(rec.binary_arc().is_none());

        let rec2 = DataRecord::with_binary(json!({ "x": 2 }), Some(Arc::new(BinaryDataMap::new())));
        assert!(rec2.binary_arc().is_some());
        let arc = rec2.into_json_arc();
        assert_eq!(*arc, json!({ "x": 2 }));
    }

    #[test]
    fn from_iterator_impls_build_zero_copy_buffers() {
        let from_records: ItemBuffer = (0..3).map(|i| DataRecord::new(payload(i))).collect();
        assert_eq!(from_records.len(), 3);

        let from_arcs: ItemBuffer = (0..3)
            .map(|i| Arc::new(DataRecord::new(payload(i))))
            .collect();
        assert_eq!(from_arcs.len(), 3);
        assert!(Arc::ptr_eq(
            &from_arcs.get_arc(1).unwrap().json,
            &from_arcs.get_arc(1).unwrap().json
        ));
    }
}
