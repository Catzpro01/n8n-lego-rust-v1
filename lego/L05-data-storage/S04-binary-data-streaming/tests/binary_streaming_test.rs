#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn test_empty_stream_lifecycle_and_checksum() {
        let service = BinaryDataStreamingService::new();
        let session = service
            .init_stream("stream-empty", "tenant-alpha", "empty.dat", "application/octet-stream")
            .expect("Init empty stream succeeds");

        assert_eq!(session.status, StreamStatus::Open);
        assert_eq!(session.total_bytes, 0);

        let finalized = service
            .finalize_stream("tenant-alpha", "stream-empty")
            .expect("Finalize empty stream succeeds");

        assert_eq!(finalized.status, StreamStatus::Finalized);
        assert!(finalized.is_finalized);
        assert_eq!(finalized.total_bytes, 0);
        assert_eq!(finalized.chunks.len(), 0);

        // SHA-256 of empty byte sequence is well-known standard constant
        assert_eq!(
            finalized.sha256_checksum.as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );

        let read_back = service
            .read_all_bytes("tenant-alpha", "stream-empty")
            .expect("Read empty stream succeeds");
        assert!(read_back.is_empty());
    }

    #[test]
    fn test_single_and_multi_chunk_roundtrip() {
        let service = BinaryDataStreamingService::new();

        service
            .init_stream("stream-multi", "tenant-alpha", "message.txt", "text/plain")
            .expect("Init stream succeeds");

        let size1 = service
            .append_chunk("tenant-alpha", "stream-multi", 0, b"Part 1: Hello ".to_vec())
            .expect("Chunk 0 appends");
        assert_eq!(size1, 14);

        let size2 = service
            .append_chunk("tenant-alpha", "stream-multi", 1, b"Part 2: World ".to_vec())
            .expect("Chunk 1 appends");
        assert_eq!(size2, 28);

        let size3 = service
            .append_chunk("tenant-alpha", "stream-multi", 2, b"Part 3: Streaming!".to_vec())
            .expect("Chunk 2 appends");
        assert_eq!(size3, 46);

        let finalized = service
            .finalize_stream("tenant-alpha", "stream-multi")
            .expect("Finalize succeeds");
        assert_eq!(finalized.total_bytes, 46);
        assert!(finalized.checksum.is_some());
        assert!(finalized.sha256_checksum.is_some());

        // Verify individual chunks
        let c0 = service.read_chunk("tenant-alpha", "stream-multi", 0).unwrap();
        assert_eq!(c0, b"Part 1: Hello ");
        let c1 = service.read_chunk("tenant-alpha", "stream-multi", 1).unwrap();
        assert_eq!(c1, b"Part 2: World ");
        let c2 = service.read_chunk("tenant-alpha", "stream-multi", 2).unwrap();
        assert_eq!(c2, b"Part 3: Streaming!");

        // Read all and verify round-trip byte equality
        let all = service.read_all_bytes("tenant-alpha", "stream-multi").unwrap();
        assert_eq!(all, b"Part 1: Hello Part 2: World Part 3: Streaming!");
    }

    #[test]
    fn test_large_payload_exact_boundary_split() {
        let service = BinaryDataStreamingService::new();

        // Generate 192 KB payload (exactly 3 chunks of 64KB)
        let chunk_size = 64 * 1024;
        let total_size = chunk_size * 3;
        let mut sample_data = Vec::with_capacity(total_size);
        for i in 0..total_size {
            sample_data.push((i % 251) as u8);
        }

        let chunks = BinaryDataStreamingService::split_into_chunks(&sample_data, chunk_size);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].len(), chunk_size);
        assert_eq!(chunks[1].len(), chunk_size);
        assert_eq!(chunks[2].len(), chunk_size);

        service
            .init_stream("stream-large", "tenant-alpha", "large.bin", "application/octet-stream")
            .expect("Init stream succeeds");

        for (idx, chk) in chunks.into_iter().enumerate() {
            service
                .append_chunk("tenant-alpha", "stream-large", idx, chk)
                .expect("Chunk append succeeds");
        }

        let finalized = service
            .finalize_stream("tenant-alpha", "stream-large")
            .expect("Finalize succeeds");

        assert_eq!(finalized.total_bytes, total_size);

        let reconstructed = service
            .read_all_bytes("tenant-alpha", "stream-large")
            .expect("Read all bytes succeeds");

        assert_eq!(reconstructed.len(), sample_data.len());
        assert_eq!(reconstructed, sample_data);
    }

    #[test]
    fn test_chunk_order_validation_and_out_of_order_rejection() {
        let service = BinaryDataStreamingService::new();

        service
            .init_stream("stream-order", "tenant-alpha", "order.bin", "application/octet-stream")
            .expect("Init succeeds");

        // Try appending chunk index 1 before chunk 0
        let err = service
            .append_chunk("tenant-alpha", "stream-order", 1, b"chunk1".to_vec())
            .unwrap_err();

        assert_eq!(
            err,
            BinaryStreamError::InvalidChunkSequence { expected: 0, actual: 1 }
        );

        // Append chunk 0 properly
        service
            .append_chunk("tenant-alpha", "stream-order", 0, b"chunk0".to_vec())
            .expect("Chunk 0 appends");

        // Try skipping chunk 1 and sending chunk 2
        let err2 = service
            .append_chunk("tenant-alpha", "stream-order", 2, b"chunk2".to_vec())
            .unwrap_err();

        assert_eq!(
            err2,
            BinaryStreamError::InvalidChunkSequence { expected: 1, actual: 2 }
        );
    }

    #[test]
    fn test_duplicate_chunk_rejection() {
        let service = BinaryDataStreamingService::new();

        service
            .init_stream("stream-dupe", "tenant-alpha", "dupe.bin", "application/octet-stream")
            .expect("Init succeeds");

        service
            .append_chunk("tenant-alpha", "stream-dupe", 0, b"first".to_vec())
            .expect("Chunk 0 appends");

        // Send chunk 0 again -> must be rejected as duplicate
        let err = service
            .append_chunk("tenant-alpha", "stream-dupe", 0, b"duplicate".to_vec())
            .unwrap_err();

        assert_eq!(
            err,
            BinaryStreamError::DuplicateChunk { chunk_index: 0 }
        );
    }

    #[test]
    fn test_resource_boundaries_max_chunk_size() {
        let max_chunk = 1024; // 1 KB max chunk
        let max_stream = 10 * 1024;
        let service = BinaryDataStreamingService::with_limits(max_chunk, max_stream);

        service
            .init_stream("stream-chunk-limit", "tenant-alpha", "file.bin", "application/octet-stream")
            .expect("Init succeeds");

        let oversize_chunk = vec![0u8; 1025];
        let err = service
            .append_chunk("tenant-alpha", "stream-chunk-limit", 0, oversize_chunk)
            .unwrap_err();

        assert_eq!(
            err,
            BinaryStreamError::ChunkSizeExceeded { size: 1025, max_size: 1024 }
        );
    }

    #[test]
    fn test_resource_boundaries_max_stream_size() {
        let max_chunk = 512;
        let max_stream = 1000;
        let service = BinaryDataStreamingService::with_limits(max_chunk, max_stream);

        service
            .init_stream("stream-total-limit", "tenant-alpha", "file.bin", "application/octet-stream")
            .expect("Init succeeds");

        // Chunk 0: 500 bytes (total 500)
        service
            .append_chunk("tenant-alpha", "stream-total-limit", 0, vec![0u8; 500])
            .expect("Chunk 0 appends");

        // Chunk 1: 501 bytes (total 1001 > 1000) -> Exceeds max stream size
        let err = service
            .append_chunk("tenant-alpha", "stream-total-limit", 1, vec![0u8; 501])
            .unwrap_err();

        assert_eq!(
            err,
            BinaryStreamError::StreamSizeExceeded { total_size: 1001, max_size: 1000 }
        );
    }

    #[test]
    fn test_stream_abort_lifecycle() {
        let service = BinaryDataStreamingService::new();

        service
            .init_stream("stream-abort", "tenant-alpha", "abort.bin", "application/octet-stream")
            .expect("Init succeeds");

        service
            .append_chunk("tenant-alpha", "stream-abort", 0, b"data".to_vec())
            .expect("Chunk 0 appends");

        let aborted = service
            .abort_stream("tenant-alpha", "stream-abort", "Network timeout from upstream source")
            .expect("Abort succeeds");

        assert_eq!(aborted.status, StreamStatus::Aborted);
        assert_eq!(
            aborted.abort_reason.as_deref(),
            Some("Network timeout from upstream source")
        );

        // Appending to aborted stream fails closed
        let append_err = service
            .append_chunk("tenant-alpha", "stream-abort", 1, b"more".to_vec())
            .unwrap_err();
        assert_eq!(append_err, BinaryStreamError::StreamAborted("stream-abort".to_string()));

        // Reading from aborted stream fails closed
        let read_err = service
            .read_chunk("tenant-alpha", "stream-abort", 0)
            .unwrap_err();
        assert_eq!(read_err, BinaryStreamError::StreamAborted("stream-abort".to_string()));

        // Finalizing aborted stream fails closed
        let fin_err = service
            .finalize_stream("tenant-alpha", "stream-abort")
            .unwrap_err();
        assert_eq!(fin_err, BinaryStreamError::StreamAborted("stream-abort".to_string()));
    }

    #[test]
    fn test_stream_close_lifecycle() {
        let service = BinaryDataStreamingService::new();

        service
            .init_stream("stream-close", "tenant-alpha", "file.bin", "application/octet-stream")
            .expect("Init succeeds");

        let closed = service
            .close_stream("tenant-alpha", "stream-close")
            .expect("Close succeeds");

        assert_eq!(closed.status, StreamStatus::Closed);

        let err = service
            .append_chunk("tenant-alpha", "stream-close", 0, b"data".to_vec())
            .unwrap_err();
        assert_eq!(err, BinaryStreamError::StreamClosed("stream-close".to_string()));
    }

    #[test]
    fn test_read_unfinalized_stream_fails_closed() {
        let service = BinaryDataStreamingService::new();

        service
            .init_stream("stream-unfin", "tenant-alpha", "file.bin", "application/octet-stream")
            .expect("Init succeeds");

        let err = service
            .read_all_bytes("tenant-alpha", "stream-unfin")
            .unwrap_err();

        assert_eq!(
            err,
            BinaryStreamError::StreamNotFinalized("stream-unfin".to_string())
        );
    }

    #[test]
    fn test_tenant_boundary_isolation_matrix() {
        let service = BinaryDataStreamingService::new();

        service
            .init_stream("stream-secure", "tenant-owner", "secret.pdf", "application/pdf")
            .expect("Init succeeds");

        // Attacker attempts append
        let err_append = service
            .append_chunk("tenant-attacker", "stream-secure", 0, b"payload".to_vec())
            .unwrap_err();
        assert!(matches!(err_append, BinaryStreamError::TenantMismatch { .. }));

        // Legitimate tenant appends
        service
            .append_chunk("tenant-owner", "stream-secure", 0, b"classified data".to_vec())
            .expect("Append succeeds");

        // Attacker attempts read chunk
        let err_read = service
            .read_chunk("tenant-attacker", "stream-secure", 0)
            .unwrap_err();
        assert!(matches!(err_read, BinaryStreamError::TenantMismatch { .. }));

        // Attacker attempts abort
        let err_abort = service
            .abort_stream("tenant-attacker", "stream-secure", "Sabotage")
            .unwrap_err();
        assert!(matches!(err_abort, BinaryStreamError::TenantMismatch { .. }));

        // Attacker attempts finalize
        let err_fin = service
            .finalize_stream("tenant-attacker", "stream-secure")
            .unwrap_err();
        assert!(matches!(err_fin, BinaryStreamError::TenantMismatch { .. }));

        // Attacker attempts metadata inspection
        let err_meta = service
            .get_stream_metadata("tenant-attacker", "stream-secure")
            .unwrap_err();
        assert!(matches!(err_meta, BinaryStreamError::TenantMismatch { .. }));
    }

    #[test]
    fn test_concurrent_independent_streams() {
        let service = Arc::new(BinaryDataStreamingService::new());
        let mut handles = Vec::new();

        for i in 0..10 {
            let svc = Arc::clone(&service);
            handles.push(thread::spawn(move || {
                let stream_id = format!("concurrent-stream-{i}");
                let tenant_id = format!("tenant-{i}");

                svc.init_stream(&stream_id, &tenant_id, "data.bin", "application/octet-stream")
                    .expect("Init succeeds");

                for chunk_idx in 0..5 {
                    let chunk_payload = format!("thread-{i}-chunk-{chunk_idx}").into_bytes();
                    svc.append_chunk(&tenant_id, &stream_id, chunk_idx, chunk_payload)
                        .expect("Append chunk succeeds");
                }

                let fin = svc.finalize_stream(&tenant_id, &stream_id).expect("Finalize succeeds");
                assert_eq!(fin.chunks.len(), 5);

                let all_bytes = svc.read_all_bytes(&tenant_id, &stream_id).expect("Read all succeeds");
                assert!(!all_bytes.is_empty());
            }));
        }

        for h in handles {
            h.join().expect("Thread should not panic");
        }
    }

    #[test]
    fn test_port_dispatcher_full_action_matrix() {
        let service = BinaryDataStreamingService::new();

        // 1. Port Init
        let init_res = service
            .handle_port_stream(&json!({
                "action": "init",
                "stream_id": "stream-port-lifecycle",
                "tenant_id": "tenant-crm",
                "file_name": "export.csv",
                "mime_type": "text/csv"
            }))
            .expect("Port init succeeds");
        assert_eq!(init_res["file_name"], "export.csv");
        assert_eq!(init_res["status"], "open");

        // 2. Port Append via text string
        let append_res1 = service
            .handle_port_stream(&json!({
                "action": "append",
                "stream_id": "stream-port-lifecycle",
                "tenant_id": "tenant-crm",
                "chunk_index": 0,
                "data": "id,name\n"
            }))
            .expect("Port append 0 succeeds");
        assert_eq!(append_res1["success"], true);
        assert_eq!(append_res1["total_bytes"], 8);

        // 3. Port Append via byte array
        let append_res2 = service
            .handle_port_stream(&json!({
                "action": "append",
                "stream_id": "stream-port-lifecycle",
                "tenant_id": "tenant-crm",
                "chunk_index": 1,
                "bytes": [49, 44, 65, 108, 105, 99, 101, 10] // "1,Alice\n"
            }))
            .expect("Port append 1 succeeds");
        assert_eq!(append_res2["total_bytes"], 16);

        // 4. Port Status inspection
        let status_res = service
            .handle_port_stream(&json!({
                "action": "status",
                "stream_id": "stream-port-lifecycle",
                "tenant_id": "tenant-crm"
            }))
            .expect("Port status succeeds");
        assert_eq!(status_res["status"], "open");
        assert_eq!(status_res["total_bytes"], 16);

        // 5. Port Finalize
        let fin_res = service
            .handle_port_stream(&json!({
                "action": "finalize",
                "stream_id": "stream-port-lifecycle",
                "tenant_id": "tenant-crm"
            }))
            .expect("Port finalize succeeds");
        assert_eq!(fin_res["status"], "finalized");
        assert!(fin_res["sha256_checksum"].is_string());

        // 6. Port Read individual chunk
        let read_chk = service
            .handle_port_stream(&json!({
                "action": "read",
                "stream_id": "stream-port-lifecycle",
                "tenant_id": "tenant-crm",
                "chunk_index": 0
            }))
            .expect("Port read chunk succeeds");
        assert_eq!(read_chk["data"], "id,name\n");

        // 7. Port Read all
        let read_all = service
            .handle_port_stream(&json!({
                "action": "read_all",
                "stream_id": "stream-port-lifecycle",
                "tenant_id": "tenant-crm"
            }))
            .expect("Port read all succeeds");
        assert_eq!(read_all["data"], "id,name\n1,Alice\n");
        assert_eq!(read_all["total_bytes"], 16);
    }

    #[test]
    fn test_port_dispatcher_envelope_context_validation() {
        let service = BinaryDataStreamingService::new();

        // 1. Valid envelope matching tenant
        let valid_env = json!({
            "action": "init",
            "stream_id": "stream-env-1",
            "tenant_id": "tenant-secure",
            "envelope": {
                "tenant_id": "tenant-secure",
                "correlation_id": "corr-12345",
                "trace_id": "trace-67890"
            }
        });
        let res = service.handle_port_stream(&valid_env);
        assert!(res.is_ok());

        // 2. Mismatched tenant in envelope
        let invalid_tenant_env = json!({
            "action": "init",
            "stream_id": "stream-env-2",
            "tenant_id": "tenant-legit",
            "envelope": {
                "tenant_id": "tenant-spoofed",
                "correlation_id": "corr-12345"
            }
        });
        let err = service.handle_port_stream(&invalid_tenant_env).unwrap_err();
        assert!(err.contains("Envelope tenant 'tenant-spoofed' does not match request tenant 'tenant-legit'"));

        // 3. Missing correlation_id in envelope
        let missing_corr_env = json!({
            "action": "init",
            "stream_id": "stream-env-3",
            "tenant_id": "tenant-legit",
            "envelope": {
                "tenant_id": "tenant-legit",
                "correlation_id": "   "
            }
        });
        let err2 = service.handle_port_stream(&missing_corr_env).unwrap_err();
        assert!(err2.contains("Missing or empty 'correlation_id' in envelope"));
    }

    #[test]
    fn test_stream_already_exists_rejection() {
        let service = BinaryDataStreamingService::new();
        service
            .init_stream("stream-unique-1", "tenant-alpha", "file.dat", "application/octet-stream")
            .expect("First init succeeds");

        let err = service
            .init_stream("stream-unique-1", "tenant-beta", "evil.dat", "application/octet-stream")
            .unwrap_err();

        assert_eq!(
            err,
            BinaryStreamError::StreamAlreadyExists("stream-unique-1".to_string())
        );
    }

    #[test]
    fn test_corrupt_chunk_detection_and_checksum_verification() {
        let service = BinaryDataStreamingService::new();
        service
            .init_stream("stream-corrupt", "tenant-alpha", "file.dat", "application/octet-stream")
            .expect("Init succeeds");

        service
            .append_chunk("tenant-alpha", "stream-corrupt", 0, b"original-bytes".to_vec())
            .expect("Append chunk 0 succeeds");

        // Manually corrupt chunk bytes in storage to simulate bit flip
        {
            let mut streams = service.streams.write().unwrap();
            let session = streams.get_mut("stream-corrupt").unwrap();
            session.chunks[0].chunk_bytes = b"tampered-bytes".to_vec();
        }

        // read_chunk must detect and reject corrupt chunk
        let read_err = service
            .read_chunk("tenant-alpha", "stream-corrupt", 0)
            .unwrap_err();
        assert!(matches!(read_err, BinaryStreamError::IntegrityChecksumMismatch { .. }));

        // finalize_stream must detect and reject corrupt chunk
        let fin_err = service
            .finalize_stream("tenant-alpha", "stream-corrupt")
            .unwrap_err();
        assert!(matches!(fin_err, BinaryStreamError::IntegrityChecksumMismatch { .. }));
    }

    #[test]
    fn test_append_chunk_with_expected_checksum_verification() {
        let service = BinaryDataStreamingService::new();
        service
            .init_stream("stream-chk-verify", "tenant-alpha", "file.dat", "application/octet-stream")
            .expect("Init succeeds");

        let data = b"verified chunk data".to_vec();
        let expected_fnv = BinaryDataStreamingService::compute_fnv1a(&data);

        // Append with matching checksum succeeds
        service
            .append_chunk_with_checksum(
                "tenant-alpha",
                "stream-chk-verify",
                0,
                data.clone(),
                Some(&expected_fnv),
            )
            .expect("Append with matching checksum succeeds");

        // Append with mismatched checksum fails
        let err = service
            .append_chunk_with_checksum(
                "tenant-alpha",
                "stream-chk-verify",
                1,
                b"next chunk".to_vec(),
                Some("fnv1a:badchecksum1234"),
            )
            .unwrap_err();
        assert!(matches!(err, BinaryStreamError::IntegrityChecksumMismatch { .. }));
    }

    #[test]
    fn test_closed_stream_rejects_subsequent_reads_and_aborts() {
        let service = BinaryDataStreamingService::new();
        service
            .init_stream("stream-close-guard", "tenant-alpha", "file.dat", "application/octet-stream")
            .expect("Init succeeds");

        service
            .append_chunk("tenant-alpha", "stream-close-guard", 0, b"some bytes".to_vec())
            .expect("Append succeeds");

        service
            .finalize_stream("tenant-alpha", "stream-close-guard")
            .expect("Finalize succeeds");

        service
            .close_stream("tenant-alpha", "stream-close-guard")
            .expect("Close succeeds");

        // Reading chunk from closed stream fails
        let read_chunk_err = service
            .read_chunk("tenant-alpha", "stream-close-guard", 0)
            .unwrap_err();
        assert_eq!(read_chunk_err, BinaryStreamError::StreamClosed("stream-close-guard".to_string()));

        // Reading all bytes from closed stream fails
        let read_all_err = service
            .read_all_bytes("tenant-alpha", "stream-close-guard")
            .unwrap_err();
        assert_eq!(read_all_err, BinaryStreamError::StreamClosed("stream-close-guard".to_string()));

        // Aborting closed stream fails
        let abort_err = service
            .abort_stream("tenant-alpha", "stream-close-guard", "Late abort")
            .unwrap_err();
        assert_eq!(abort_err, BinaryStreamError::StreamClosed("stream-close-guard".to_string()));
    }

    #[test]
    fn test_aborted_stream_cannot_be_closed() {
        let service = BinaryDataStreamingService::new();
        service
            .init_stream("stream-abort-close", "tenant-alpha", "file.dat", "application/octet-stream")
            .expect("Init succeeds");

        service
            .abort_stream("tenant-alpha", "stream-abort-close", "Network error")
            .expect("Abort succeeds");

        let close_err = service
            .close_stream("tenant-alpha", "stream-abort-close")
            .unwrap_err();
        assert_eq!(close_err, BinaryStreamError::StreamAborted("stream-abort-close".to_string()));
    }

    #[test]
    fn test_arbitrary_binary_non_utf8_roundtrip() {
        let service = BinaryDataStreamingService::new();
        // Arbitrary binary bytes that are NOT valid UTF-8 (e.g. magic bytes of JPEG, PNG, gzip, random)
        let non_utf8_bytes: Vec<u8> = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x80, 0x90, 0xA0];

        // 1. Port Init
        service
            .handle_port_stream(&json!({
                "action": "init",
                "stream_id": "stream-binary-raw",
                "tenant_id": "tenant-media",
                "file_name": "image.jpg",
                "mime_type": "image/jpeg"
            }))
            .expect("Init succeeds");

        // 2. Port Append via raw byte array
        service
            .handle_port_stream(&json!({
                "action": "append",
                "stream_id": "stream-binary-raw",
                "tenant_id": "tenant-media",
                "chunk_index": 0,
                "bytes": non_utf8_bytes
            }))
            .expect("Append succeeds");

        // 3. Port Finalize
        service
            .handle_port_stream(&json!({
                "action": "finalize",
                "stream_id": "stream-binary-raw",
                "tenant_id": "tenant-media"
            }))
            .expect("Finalize succeeds");

        // 4. Port Read All - must preserve exact byte array without UTF-8 corruption
        let read_res = service
            .handle_port_stream(&json!({
                "action": "read_all",
                "stream_id": "stream-binary-raw",
                "tenant_id": "tenant-media"
            }))
            .expect("Read all succeeds");

        let returned_bytes: Vec<u8> = read_res["bytes"]
            .as_array()
            .expect("Must return bytes array")
            .iter()
            .map(|b| b.as_u64().unwrap() as u8)
            .collect();

        assert_eq!(returned_bytes, vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x80, 0x90, 0xA0]);
        assert!(read_res["base64"].is_string());
    }
}
