//! Implementation of L05.S02 Durable WAL and Transactions

use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalRecord {
    pub lsn: u64,
    pub execution_id: String,
    pub record_type: String,
    pub payload: serde_json::Value,
}

pub struct DurableWalStorage {
    file_path: PathBuf,
}

impl DurableWalStorage {
    /// Opens or creates durable WAL file. Strictly fails closed if path cannot be created!
    pub fn open_fail_closed<P: AsRef<Path>>(path: P) -> std::io::Result<Self> {
        let path_buf = path.as_ref().to_path_buf();
        if let Some(parent) = path_buf.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Attempt open or create with append mode
        let _f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path_buf)?;

        Ok(Self { file_path: path_buf })
    }

    /// Appends a record and performs fsync for strict durability
    pub fn append(&self, record: &WalRecord) -> std::io::Result<u64> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_path)?;

        let line = serde_json::to_string(record)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(record.lsn)
    }

    /// Reads all records from the WAL
    pub fn read_all(&self) -> std::io::Result<Vec<WalRecord>> {
        let file = File::open(&self.file_path)?;
        let reader = BufReader::new(file);
        let mut records = Vec::new();
        for line in reader.lines() {
            let line = line?;
            if !line.trim().is_empty() {
                if let Ok(rec) = serde_json::from_str::<WalRecord>(&line) {
                    records.push(rec);
                }
            }
        }
        Ok(records)
    }
}
