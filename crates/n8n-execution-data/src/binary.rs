use std::io::{Read, Result as IoResult};

pub const CHUNK_SIZE_BYTES: usize = 64 * 1024; // 64 KB fixed chunks

/// Chunked binary stream processor ensuring minimal heap overhead
#[derive(Debug)]
pub struct ChunkedBinaryStream<R> {
    reader: R,
    buffer: [u8; CHUNK_SIZE_BYTES],
    total_bytes_streamed: u64,
}

impl<R: Read> ChunkedBinaryStream<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            buffer: [0u8; CHUNK_SIZE_BYTES],
            total_bytes_streamed: 0,
        }
    }

    pub fn next_chunk(&mut self) -> IoResult<Option<&[u8]>> {
        let bytes_read = self.reader.read(&mut self.buffer)?;
        if bytes_read == 0 {
            Ok(None)
        } else {
            self.total_bytes_streamed += bytes_read as u64;
            Ok(Some(&self.buffer[..bytes_read]))
        }
    }

    pub fn total_streamed(&self) -> u64 {
        self.total_bytes_streamed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_chunked_streaming_boundaries() {
        let raw_data = vec![0xAA; 150 * 1024]; // 150 KB
        let cursor = Cursor::new(raw_data);
        let mut streamer = ChunkedBinaryStream::new(cursor);

        let c1 = streamer.next_chunk().unwrap().unwrap();
        assert_eq!(c1.len(), 64 * 1024);

        let c2 = streamer.next_chunk().unwrap().unwrap();
        assert_eq!(c2.len(), 64 * 1024);

        let c3 = streamer.next_chunk().unwrap().unwrap();
        assert_eq!(c3.len(), 22 * 1024);

        assert!(streamer.next_chunk().unwrap().is_none());
        assert_eq!(streamer.total_streamed(), 150 * 1024);
    }
}
