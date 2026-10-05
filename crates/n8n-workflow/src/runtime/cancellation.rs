use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Thread-safe cooperative cancellation token for workflow execution (M1 Kernel).
///
/// Enables graceful cancellation cascading across asynchronous execution tasks
/// and thread boundaries without abrupt thread termination.
#[derive(Debug, Clone)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
    parent: Option<Box<CancellationToken>>,
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

impl CancellationToken {
    /// Creates a new root cancellation token in the active (non-cancelled) state.
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            parent: None,
        }
    }

    /// Creates a child cancellation token linked to this parent token.
    ///
    /// The child token evaluates to cancelled if either:
    /// 1. Its own cancel() method was invoked, OR
    /// 2. Its parent token is cancelled.
    pub fn child_token(&self) -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            parent: Some(Box::new(self.clone())),
        }
    }

    /// Signals cancellation cooperatively to this token and all observers.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// Checks if this token or any ancestor token has received a cancellation signal.
    pub fn is_cancelled(&self) -> bool {
        if self.cancelled.load(Ordering::Relaxed) {
            return true;
        }
        if let Some(ref parent) = self.parent {
            return parent.is_cancelled();
        }
        false
    }

    /// Returns the underlying raw `Arc<AtomicBool>` representation for compatibility
    /// with legacy ExecutionContext fields.
    pub fn as_raw_atomic(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    /// Constructs a `CancellationToken` wrapping an existing `Arc<AtomicBool>`.
    pub fn from_raw_atomic(raw: Arc<AtomicBool>) -> Self {
        Self {
            cancelled: raw,
            parent: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn test_cancellation_token_basic() {
        let token = CancellationToken::new();
        assert!(!token.is_cancelled());

        token.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn test_cancellation_token_hierarchy() {
        let root = CancellationToken::new();
        let child = root.child_token();
        let grandchild = child.child_token();

        assert!(!root.is_cancelled());
        assert!(!child.is_cancelled());
        assert!(!grandchild.is_cancelled());

        // Cancelling child does not cancel root, but cancels grandchild
        child.cancel();
        assert!(!root.is_cancelled());
        assert!(child.is_cancelled());
        assert!(grandchild.is_cancelled());

        // Cancelling root cascades to child and grandchild
        let root2 = CancellationToken::new();
        let child2 = root2.child_token();
        root2.cancel();
        assert!(root2.is_cancelled());
        assert!(child2.is_cancelled());
    }

    #[test]
    fn test_cancellation_token_cross_thread_cooperative() {
        let token = CancellationToken::new();
        let token_clone = token.clone();
        let barrier = Arc::new(Barrier::new(2));
        let barrier_clone = barrier.clone();

        let handle = thread::spawn(move || {
            barrier_clone.wait();
            let mut iterations = 0;
            while !token_clone.is_cancelled() {
                thread::sleep(Duration::from_millis(5));
                iterations += 1;
                if iterations > 200 {
                    break;
                }
            }
            iterations
        });

        barrier.wait();
        thread::sleep(Duration::from_millis(30));
        assert!(!token.is_cancelled());

        token.cancel();
        assert!(token.is_cancelled());

        let finished_iterations = handle.join().expect("Thread should join cleanly");
        assert!(finished_iterations < 100, "Thread should terminate promptly upon cancellation");
    }

    #[test]
    fn test_cancellation_token_atomic_interop() {
        let raw = Arc::new(AtomicBool::new(false));
        let token = CancellationToken::from_raw_atomic(raw.clone());

        assert!(!token.is_cancelled());
        raw.store(true, Ordering::SeqCst);
        assert!(token.is_cancelled());

        let raw_extracted = token.as_raw_atomic();
        assert!(raw_extracted.load(Ordering::SeqCst));
    }
}
