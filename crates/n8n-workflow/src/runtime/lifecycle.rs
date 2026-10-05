use std::time::Instant;

/// Execution lifecycle tracker (M1 Kernel)
#[derive(Debug, Clone)]
pub struct ExecutionLifecycleTracker {
    start_time: Instant,
}

impl Default for ExecutionLifecycleTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl ExecutionLifecycleTracker {
    pub fn new() -> Self {
        Self { start_time: Instant::now() }
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.start_time.elapsed().as_millis() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    fn test_lifecycle_tracker() {
        let tracker = ExecutionLifecycleTracker::new();
        sleep(Duration::from_millis(5));
        assert!(tracker.elapsed_ms() >= 4);
    }
}
