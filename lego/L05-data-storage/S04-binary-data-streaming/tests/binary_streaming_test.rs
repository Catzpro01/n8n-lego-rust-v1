#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_binary_stream_init_append_and_finalize() {
        let service = BinaryDataStreamingService::new();

        let session = service
            .init_stream("stream-1", "tenant-alpha", "report.pdf", "application/pdf")
            .expect("Init stream should succeed");

        assert_eq!(session.stream_id, "stream-1");
        assert_eq!(session.mime_type, "application/pdf");
        assert!(!session.is_finalized);

        // Append 2 chunks
        let size1 = service
            .append_chunk("tenant-alpha", "stream-1", 0, b"Hello ".to_vec())
            .expect("Chunk 0 append succeeds");
        assert_eq!(size1, 6);

        let size2 = service
            .append_chunk("tenant-alpha", "stream-1", 1, b"World!".to_vec())
            .expect("Chunk 1 append succeeds");
        assert_eq!(size2, 12);

        // Finalize
        let finalized = service
            .finalize_stream("tenant-alpha", "stream-1")
            .expect("Finalize stream succeeds");

        assert!(finalized.is_finalized);
        assert_eq!(finalized.total_bytes, 12);
        assert!(finalized.checksum.is_some());

        // Read chunk 0
        let chunk0 = service
            .read_chunk("tenant-alpha", "stream-1", 0)
            .expect("Read chunk 0 succeeds");
        assert_eq!(chunk0, b"Hello ");
    }

    #[test]
    fn test_chunk_sequence_validation() {
        let service = BinaryDataStreamingService::new();

        service
            .init_stream("stream-seq", "tenant-alpha", "file.bin", "application/octet-stream")
            .expect("Init succeeds");

        // Appending chunk 1 without chunk 0 fails closed
        let err = service
            .append_chunk("tenant-alpha", "stream-seq", 1, b"chunk1".to_vec())
            .unwrap_err();

        assert!(matches!(err, BinaryStreamError::InvalidChunkSequence { expected: 0, actual: 1 }));
    }

    #[test]
    fn test_append_to_finalized_stream_fails_closed() {
        let service = BinaryDataStreamingService::new();

        service
            .init_stream("stream-fin", "tenant-alpha", "file.bin", "application/octet-stream")
            .expect("Init succeeds");

        service
            .finalize_stream("tenant-alpha", "stream-fin")
            .expect("Finalize succeeds");

        let err = service
            .append_chunk("tenant-alpha", "stream-fin", 0, b"data".to_vec())
            .unwrap_err();

        assert!(matches!(err, BinaryStreamError::StreamAlreadyFinalized(_)));
    }

    #[test]
    fn test_tenant_boundary_isolation() {
        let service = BinaryDataStreamingService::new();

        service
            .init_stream("stream-tenant", "tenant-owner", "secret.png", "image/png")
            .expect("Init succeeds");

        // Attacker cannot append or read
        let err = service
            .append_chunk("tenant-attacker", "stream-tenant", 0, b"hack".to_vec())
            .unwrap_err();

        assert!(matches!(err, BinaryStreamError::TenantMismatch { .. }));
    }

    #[test]
    fn test_read_chunk_bounds_validation() {
        let service = BinaryDataStreamingService::new();

        service
            .init_stream("stream-bounds", "tenant-alpha", "doc.txt", "text/plain")
            .expect("Init succeeds");

        let err = service
            .read_chunk("tenant-alpha", "stream-bounds", 99)
            .unwrap_err();

        assert!(matches!(err, BinaryStreamError::InvalidRequest(_)));
    }

    #[test]
    fn test_port_binary_stream_dispatcher() {
        let service = BinaryDataStreamingService::new();

        // 1. Init via port
        let init_out = service
            .handle_port_stream(&json!({
                "action": "init",
                "stream_id": "stream-port-1",
                "tenant_id": "tenant-port",
                "file_name": "data.csv",
                "mime_type": "text/csv"
            }))
            .expect("Port init succeeds");
        assert_eq!(init_out["file_name"], "data.csv");

        // 2. Append via port
        let append_out = service
            .handle_port_stream(&json!({
                "action": "append",
                "stream_id": "stream-port-1",
                "tenant_id": "tenant-port",
                "chunk_index": 0,
                "data": "col1,col2\nval1,val2"
            }))
            .expect("Port append succeeds");
        assert_eq!(append_out["success"], true);

        // 3. Finalize via port
        let fin_out = service
            .handle_port_stream(&json!({
                "action": "finalize",
                "stream_id": "stream-port-1",
                "tenant_id": "tenant-port"
            }))
            .expect("Port finalize succeeds");
        assert_eq!(fin_out["is_finalized"], true);

        // 4. Read via port
        let read_out = service
            .handle_port_stream(&json!({
                "action": "read",
                "stream_id": "stream-port-1",
                "tenant_id": "tenant-port",
                "chunk_index": 0
            }))
            .expect("Port read succeeds");
        assert_eq!(read_out["data"], "col1,col2\nval1,val2");
    }
}
