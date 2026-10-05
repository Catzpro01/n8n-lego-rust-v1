use std::sync::atomic::{AtomicUsize, Ordering};

/// Runtime Memory Governor tracking budget and thresholds (M1 Kernel)
#[derive(Debug)]
pub struct MemoryGovernor {
    budget_bytes: usize,
    used_bytes: AtomicUsize,
}

impl MemoryGovernor {
    pub fn new(budget_bytes: usize) -> Self {
        Self {
            budget_bytes,
            used_bytes: AtomicUsize::new(0),
        }
    }

    pub fn is_backpressure_triggered(&self) -> bool {
        let current = self.used_bytes.load(Ordering::Relaxed);
        (current * 100) / self.budget_bytes >= 85
    }

    pub fn record_allocation(&self, bytes: usize) -> bool {
        let prev = self.used_bytes.fetch_add(bytes, Ordering::SeqCst);
        prev + bytes <= self.budget_bytes
    }

    pub fn current_usage(&self) -> usize {
        self.used_bytes.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_governor_backpressure() {
        let gov = MemoryGovernor::new(100);
        assert!(!gov.is_backpressure_triggered());
        gov.record_allocation(85);
        assert!(gov.is_backpressure_triggered());
        assert!(gov.record_allocation(10));
        assert!(!gov.record_allocation(10)); // Exceeds 100
    }
}
