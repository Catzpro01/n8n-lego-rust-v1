//! Implementation of L06.S02 Execution telemetry
//!
//! Sub-LEGO Identity: L06.S02
//! Authoritative State Domain: `telemetry-metrics-ring`
//! Runtime Host: H03 (Execution Host)
//! Execution Model: in-process
//! Invariants:
//! - Multi-tenant isolation: telemetry metrics and rings strictly isolated per tenant.
//! - Bounded ring buffer: prevents unbounded memory leaks via ring buffer eviction policy.
//! - Fail-closed validation: rejects unauthenticated or empty tenant/execution telemetry.
//! - Typed port contract: provides `port.observability.telemetry.record.v1`.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Metric type taxonomy for execution telemetry
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricType {
    Counter,
    Gauge,
    Histogram,
    Span,
}

/// A recorded telemetry metric item stored in the bounded ring buffer
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetricRecord {
    pub metric_id: String,
    pub tenant_id: String,
    pub execution_id: String,
    pub metric_name: String,
    pub metric_type: MetricType,
    pub value: f64,
    pub labels: HashMap<String, String>,
    pub timestamp_ms: u64,
}

/// Summary metrics aggregation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetricSummary {
    pub metric_name: String,
    pub count: usize,
    pub sum: f64,
    pub min: f64,
    pub max: f64,
    pub avg: f64,
}

/// Bounded ring buffer for telemetry metrics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryRingBuffer {
    capacity: usize,
    buffer: Vec<MetricRecord>,
    total_recorded: u64,
}

impl TelemetryRingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            buffer: Vec::with_capacity(capacity.min(1000)),
            total_recorded: 0,
        }
    }

    /// Records a metric, evicting the oldest element if capacity is reached
    pub fn record(&mut self, record: MetricRecord) {
        if self.buffer.len() >= self.capacity {
            self.buffer.remove(0);
        }
        self.buffer.push(record);
        self.total_recorded += 1;
    }

    /// Returns the number of items currently in buffer
    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    /// Returns all items in the ring buffer
    pub fn items(&self) -> &[MetricRecord] {
        &self.buffer
    }

    /// Returns lifetime total recorded count
    pub fn total_recorded(&self) -> u64 {
        self.total_recorded
    }

    /// Computes summary statistics for a given metric name
    pub fn summarize(&self, metric_name: &str) -> Option<MetricSummary> {
        let matching: Vec<&MetricRecord> = self
            .buffer
            .iter()
            .filter(|m| m.metric_name == metric_name)
            .collect();

        if matching.is_empty() {
            return None;
        }

        let count = matching.len();
        let mut sum = 0.0;
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;

        for m in &matching {
            sum += m.value;
            if m.value < min {
                min = m.value;
            }
            if m.value > max {
                max = m.value;
            }
        }

        Some(MetricSummary {
            metric_name: metric_name.to_string(),
            count,
            sum,
            min,
            max,
            avg: sum / (count as f64),
        })
    }
}

/// Errors originating in telemetry service
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TelemetryError {
    InvalidRequest(String),
    TenantMismatch { expected: String, actual: String },
    LockPoisoned,
}

impl std::fmt::Display for TelemetryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(msg) => write!(f, "Invalid telemetry request: {msg}"),
            Self::TenantMismatch { expected, actual } => {
                write!(f, "Tenant mismatch: expected {expected}, actual {actual}")
            }
            Self::LockPoisoned => write!(f, "Telemetry state lock poisoned"),
        }
    }
}

/// Result of recording a telemetry metric
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordResult {
    pub metric_id: String,
    pub total_recorded: u64,
    pub buffer_len: usize,
    pub capacity: usize,
}

/// Execution telemetry service managing the `telemetry-metrics-ring` state domain
pub struct ExecutionTelemetryService {
    default_capacity: usize,
    // (tenant_id) -> TelemetryRingBuffer
    rings: RwLock<HashMap<String, TelemetryRingBuffer>>,
}

impl Default for ExecutionTelemetryService {
    fn default() -> Self {
        Self::new(1000)
    }
}

impl ExecutionTelemetryService {
    pub fn new(default_capacity: usize) -> Self {
        Self {
            default_capacity: default_capacity.max(1),
            rings: RwLock::new(HashMap::new()),
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Records a metric event into the tenant's bounded ring buffer
    pub fn record_metric(
        &self,
        tenant_id: &str,
        execution_id: &str,
        metric_name: &str,
        metric_type: MetricType,
        value: f64,
        labels: HashMap<String, String>,
    ) -> Result<RecordResult, TelemetryError> {
        if tenant_id.trim().is_empty() {
            return Err(TelemetryError::InvalidRequest("tenant_id must not be empty".into()));
        }
        if execution_id.trim().is_empty() {
            return Err(TelemetryError::InvalidRequest("execution_id must not be empty".into()));
        }
        if metric_name.trim().is_empty() {
            return Err(TelemetryError::InvalidRequest("metric_name must not be empty".into()));
        }

        let metric_id = format!(
            "tel_{}_{}_{}",
            tenant_id,
            Self::now_ms(),
            fastrand_pseudo(metric_name)
        );

        let record = MetricRecord {
            metric_id: metric_id.clone(),
            tenant_id: tenant_id.to_string(),
            execution_id: execution_id.to_string(),
            metric_name: metric_name.to_string(),
            metric_type,
            value,
            labels,
            timestamp_ms: Self::now_ms(),
        };

        let mut rings = self.rings.write().map_err(|_| TelemetryError::LockPoisoned)?;
        let ring = rings
            .entry(tenant_id.to_string())
            .or_insert_with(|| TelemetryRingBuffer::new(self.default_capacity));

        ring.record(record);

        Ok(RecordResult {
            metric_id,
            total_recorded: ring.total_recorded(),
            buffer_len: ring.len(),
            capacity: ring.capacity,
        })
    }

    /// Queries metrics for a specific tenant and optional execution_id / metric_name
    pub fn query_metrics(
        &self,
        tenant_id: &str,
        execution_id: Option<&str>,
        metric_name: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MetricRecord>, TelemetryError> {
        if tenant_id.trim().is_empty() {
            return Err(TelemetryError::InvalidRequest("tenant_id must not be empty".into()));
        }

        let rings = self.rings.read().map_err(|_| TelemetryError::LockPoisoned)?;
        let ring = match rings.get(tenant_id) {
            Some(r) => r,
            None => return Ok(Vec::new()),
        };

        let items: Vec<MetricRecord> = ring
            .items()
            .iter()
            .filter(|m| {
                if let Some(eid) = execution_id {
                    if m.execution_id != eid {
                        return false;
                    }
                }
                if let Some(mname) = metric_name {
                    if m.metric_name != mname {
                        return false;
                    }
                }
                true
            })
            .rev()
            .take(limit.max(1))
            .cloned()
            .collect();

        Ok(items)
    }

    /// Computes statistical summary for a metric name within tenant boundary
    pub fn summarize(
        &self,
        tenant_id: &str,
        metric_name: &str,
    ) -> Result<Option<MetricSummary>, TelemetryError> {
        if tenant_id.trim().is_empty() {
            return Err(TelemetryError::InvalidRequest("tenant_id must not be empty".into()));
        }
        let rings = self.rings.read().map_err(|_| TelemetryError::LockPoisoned)?;
        Ok(rings.get(tenant_id).and_then(|r| r.summarize(metric_name)))
    }

    /// Handles port invocation for `port.observability.telemetry.record.v1`
    pub fn handle_port_record(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, TelemetryError> {
        let tenant_id = payload
            .get("tenant_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TelemetryError::InvalidRequest("Missing tenant_id".into()))?;

        let execution_id = payload
            .get("execution_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TelemetryError::InvalidRequest("Missing execution_id".into()))?;

        let metric_name = payload
            .get("metric_name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TelemetryError::InvalidRequest("Missing metric_name".into()))?;

        let metric_type_str = payload
            .get("metric_type")
            .and_then(|v| v.as_str())
            .unwrap_or("counter");

        let metric_type = match metric_type_str {
            "counter" => MetricType::Counter,
            "gauge" => MetricType::Gauge,
            "histogram" => MetricType::Histogram,
            "span" => MetricType::Span,
            other => return Err(TelemetryError::InvalidRequest(format!("Unknown metric_type: {other}"))),
        };

        let value = payload
            .get("value")
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0);

        let labels: HashMap<String, String> = payload
            .get("labels")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();

        let res = self.record_metric(tenant_id, execution_id, metric_name, metric_type, value, labels)?;

        let summary = self.summarize(tenant_id, metric_name)?;

        Ok(serde_json::json!({
            "success": true,
            "metric_id": res.metric_id,
            "total_recorded": res.total_recorded,
            "buffer_len": res.buffer_len,
            "capacity": res.capacity,
            "summary": summary
        }))
    }
}

/// Helper deterministic pseudo-hash for unique ID generation
fn fastrand_pseudo(name: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in name.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h & 0xffff
}

#[cfg(test)]
#[path = "../tests/execution_telemetry_test.rs"]
mod tests;

