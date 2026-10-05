//! Recursion guard for sub-workflow execution.
//! Detects and prevents cyclic invocations and deep recursion beyond max depth.

use crate::types::SubworkflowError;

/// Guard protecting subworkflow invocations against infinite nesting and cyclic dependency loops.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecursionDepthGuard {
    max_depth: usize,
    depth: usize,
    call_chain: Vec<String>,
}

impl RecursionDepthGuard {
    /// Default maximum allowed nesting depth before recursion is aborted.
    pub const DEFAULT_MAX_DEPTH: usize = 10;

    /// Creates a new `RecursionDepthGuard` with a specified maximum depth limit.
    pub fn new(max_depth: usize) -> Self {
        Self {
            max_depth,
            depth: 0,
            call_chain: Vec::new(),
        }
    }

    /// Current invocation nesting depth (root level is 0).
    pub fn current_depth(&self) -> usize {
        self.depth
    }

    /// Maximum invocation nesting depth allowed.
    pub fn max_depth(&self) -> usize {
        self.max_depth
    }

    /// Active workflow call stack chain.
    pub fn call_chain(&self) -> &[String] {
        &self.call_chain
    }

    /// Verifies if invoking `workflow_id` would trigger a cyclic recursion loop.
    pub fn check_cycle(&self, workflow_id: &str) -> Result<(), SubworkflowError> {
        if self.call_chain.iter().any(|id| id == workflow_id) {
            let mut chain = self.call_chain.clone();
            chain.push(workflow_id.to_string());
            return Err(SubworkflowError::CyclicRecursion {
                workflow_id: workflow_id.to_string(),
                call_chain: chain,
            });
        }
        Ok(())
    }

    /// Verifies if the current depth has reached or exceeded max depth.
    pub fn check_depth(&self) -> Result<(), SubworkflowError> {
        if self.depth >= self.max_depth {
            return Err(SubworkflowError::DepthExceeded {
                depth: self.depth + 1,
                max: self.max_depth,
            });
        }
        Ok(())
    }

    /// Enters a child sub-workflow scope, returning a child guard with incremented depth
    /// and the new workflow ID recorded in the call chain.
    ///
    /// # Errors
    /// - Returns `SubworkflowError::DepthExceeded` if child depth exceeds `max_depth`.
    /// - Returns `SubworkflowError::CyclicRecursion` if `workflow_id` is already in `call_chain`.
    pub fn enter(&self, workflow_id: &str) -> Result<Self, SubworkflowError> {
        // Guard 1: Recursion depth limit
        self.check_depth()?;

        // Guard 2: Cyclic recursion check
        self.check_cycle(workflow_id)?;

        let mut next_chain = self.call_chain.clone();
        next_chain.push(workflow_id.to_string());

        Ok(Self {
            max_depth: self.max_depth,
            depth: self.depth + 1,
            call_chain: next_chain,
        })
    }
}

impl Default for RecursionDepthGuard {
    fn default() -> Self {
        Self::new(Self::DEFAULT_MAX_DEPTH)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_recursion_depth_limit() {
        let guard = RecursionDepthGuard::new(3);
        assert_eq!(guard.current_depth(), 0);

        let g1 = guard.enter("wf-1").expect("depth 1 ok");
        assert_eq!(g1.current_depth(), 1);

        let g2 = g1.enter("wf-2").expect("depth 2 ok");
        assert_eq!(g2.current_depth(), 2);

        let g3 = g2.enter("wf-3").expect("depth 3 ok");
        assert_eq!(g3.current_depth(), 3);

        // depth 4 exceeds max 3
        let err = g3.enter("wf-4").unwrap_err();
        assert_eq!(
            err,
            SubworkflowError::DepthExceeded {
                depth: 4,
                max: 3,
            }
        );
    }

    #[test]
    fn test_cyclic_recursion_detection() {
        let guard = RecursionDepthGuard::new(10);
        let g1 = guard.enter("wf-root").expect("root ok");
        let g2 = g1.enter("wf-child-a").expect("child a ok");

        // Attempting to invoke wf-root again from child a
        let err = g2.enter("wf-root").unwrap_err();
        match err {
            SubworkflowError::CyclicRecursion { workflow_id, call_chain } => {
                assert_eq!(workflow_id, "wf-root");
                assert_eq!(call_chain, vec!["wf-root", "wf-child-a", "wf-root"]);
            }
            other => panic!("expected CyclicRecursion error, got {:?}", other),
        }

        // Direct self-recursion
        let err_self = g2.enter("wf-child-a").unwrap_err();
        match err_self {
            SubworkflowError::CyclicRecursion { workflow_id, call_chain } => {
                assert_eq!(workflow_id, "wf-child-a");
                assert_eq!(call_chain, vec!["wf-root", "wf-child-a", "wf-child-a"]);
            }
            other => panic!("expected CyclicRecursion error, got {:?}", other),
        }
    }
}
