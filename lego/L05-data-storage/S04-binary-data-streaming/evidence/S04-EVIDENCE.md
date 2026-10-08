# Evidence: L05.S04 Binary Data and Streaming

- **Sub-LEGO ID**: `L05.S04`
- **Name**: Binary data and streaming
- **Owning LEGO**: `L05-data-storage`
- **Runtime Host**: `H05` (Data Host)
- **Authoritative State Domain**: `blob-filesystem-chunks`
- **Status Target**: `TESTED`
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L05-data-storage/S04-binary-data-streaming/`
- **Provided Ports**:
  - `port.storage.binary.stream.v1`
- **Required Ports**:
  - `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)
- **Execution & Simulation Correlation**:
  - **Correlation ID**: `corr-l05-s04-binary-stream-1791452653`
  - **Webhook Event ID**: `wh-l05-s04-1791452653`
  - **Runner ID**: `runner-l05-s04-1791452653`
  - **Job ID**: `job-l05-s04-1791452653`
  - **Provenance Base Commit**: `e343795903c6c9ab1bec8ecc89550bcfb436fb19`

## Invariants Verified
1. **Stream Lifecycle & State Machine**: Open, write/push, flush/finalize, read/consume, close, and abort (`StreamStatus::Open`, `StreamStatus::Finalized`, `StreamStatus::Aborted`, `StreamStatus::Closed`). Aborted/closed streams fail closed against subsequent mutations and reads (`test_stream_abort_lifecycle`, `test_stream_close_lifecycle`, `test_closed_stream_rejects_subsequent_reads_and_aborts`, `test_aborted_stream_cannot_be_closed`).
2. **Chunking & Boundary Partitioning**: Supports empty payloads (0-byte), small payloads, multi-chunk payloads, and large payloads partitioned at exact chunk boundaries (64KB default chunk size). Chunk order is strictly monotonic (`test_empty_stream_lifecycle_and_checksum`, `test_single_and_multi_chunk_roundtrip`, `test_large_payload_exact_boundary_split`).
3. **Duplicate & Out-of-Order Chunk Rejection**: Non-monotonic sequence gaps reject with `InvalidChunkSequence` and already-received chunk indices reject with `DuplicateChunk` (`test_chunk_order_validation_and_out_of_order_rejection`, `test_duplicate_chunk_rejection`).
4. **Stream Collision & Idempotency Boundary**: Rejects re-initialization or overwriting of existing stream IDs with `StreamAlreadyExists` (`test_stream_already_exists_rejection`, `test_binary_stream_port_duplicate_stream_id_conflict`).
5. **Data Integrity & Checksum Verification**: Computes deterministic FNV-1a and SHA-256 checksums upon finalization, verifies chunk checksums during storage and read, and rejects corrupted chunks or mismatched caller checksums with `IntegrityChecksumMismatch` (`test_corrupt_chunk_detection_and_checksum_verification`, `test_append_chunk_with_expected_checksum_verification`, `test_large_payload_exact_boundary_split`).
6. **Lossless Binary & Non-UTF8 Streaming**: Supports arbitrary raw byte streams (such as image, video, and archive payloads) without UTF-8 lossy conversion or truncation; provides base64 and raw byte array encoding (`test_arbitrary_binary_non_utf8_roundtrip`).
7. **Resource Boundary Limits**: Bounded chunk size (5MB max default) and bounded cumulative stream size (100MB max default) fail closed with `ChunkSizeExceeded` and `StreamSizeExceeded` (`test_resource_boundaries_max_chunk_size`, `test_resource_boundaries_max_stream_size`, `test_binary_stream_port_resource_limit_exceeded`).
8. **Multi-Tenant Stream Isolation**: Binary streams and chunk stores are strictly scoped per tenant. Cross-tenant appends, reads, aborts, finalizations, and metadata queries fail closed with `TenantMismatch` (`test_tenant_boundary_isolation_matrix`, `test_binary_stream_port_tenant_isolation_boundary`).
9. **Thread-Safe Concurrency**: Multiple concurrent threads process independent streams without data corruption or cross-stream contamination (`test_concurrent_independent_streams`).
10. **Envelope Context Validation**: Validates `port.runtime.contract.envelope.v1` envelope context matching tenant and containing non-empty correlation ID (`test_port_dispatcher_envelope_context_validation`).
11. **Transport-Neutral Port Contract**: In-process dispatcher executes `port.storage.binary.stream.v1` actions (`init`, `append`, `finalize`, `read`, `read_all`, `abort`, `close`, `status`) seamlessly (`test_port_dispatcher_full_action_matrix`, `crates/n8n-port-contract/tests/binary_stream_port_test.rs`).
12. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.

## Test Matrix Record
- `lego/L05-data-storage/S04-binary-data-streaming/tests/binary_streaming_test.rs` & `crates/n8n-binary-data/tests/binary_streaming_test.rs`:
  - `test_empty_stream_lifecycle_and_checksum`: PASSED
  - `test_single_and_multi_chunk_roundtrip`: PASSED
  - `test_large_payload_exact_boundary_split`: PASSED
  - `test_chunk_order_validation_and_out_of_order_rejection`: PASSED
  - `test_duplicate_chunk_rejection`: PASSED
  - `test_resource_boundaries_max_chunk_size`: PASSED
  - `test_resource_boundaries_max_stream_size`: PASSED
  - `test_stream_abort_lifecycle`: PASSED
  - `test_stream_close_lifecycle`: PASSED
  - `test_read_unfinalized_stream_fails_closed`: PASSED
  - `test_tenant_boundary_isolation_matrix`: PASSED
  - `test_concurrent_independent_streams`: PASSED
  - `test_port_dispatcher_full_action_matrix`: PASSED
  - `test_port_dispatcher_envelope_context_validation`: PASSED
  - `test_stream_already_exists_rejection`: PASSED
  - `test_corrupt_chunk_detection_and_checksum_verification`: PASSED
  - `test_append_chunk_with_expected_checksum_verification`: PASSED
  - `test_closed_stream_rejects_subsequent_reads_and_aborts`: PASSED
  - `test_aborted_stream_cannot_be_closed`: PASSED
  - `test_arbitrary_binary_non_utf8_roundtrip`: PASSED
- `crates/n8n-port-contract/tests/binary_stream_port_test.rs`:
  - `test_binary_stream_port_roundtrip_init_append_finalize`: PASSED
  - `test_binary_stream_port_security_denied_for_unauthorized_invoker`: PASSED
  - `test_binary_stream_port_tenant_isolation_boundary`: PASSED
  - `test_binary_stream_port_abort_lifecycle`: PASSED
  - `test_binary_stream_port_duplicate_and_out_of_order_chunk_rejection`: PASSED
  - `test_binary_stream_port_resource_limit_exceeded`: PASSED
  - `test_binary_stream_port_duplicate_stream_id_conflict`: PASSED
- `crates/n8n-binary-data`:
  - Unit tests in `src/lib.rs`: 7/7 PASSED
  - Integration tests in `tests/binary_streaming_test.rs`: 19/19 PASSED
  - Total crate test suite: 26/26 PASSED
