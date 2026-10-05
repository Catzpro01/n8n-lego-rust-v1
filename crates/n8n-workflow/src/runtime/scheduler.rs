use std::collections::{BinaryHeap, HashSet};
use std::cmp::Ordering;

/// Priority queue item for execution tasks
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ScheduledTask {
    pub node_id: String,
    pub priority: i32,
}

impl Ord for ScheduledTask {
    fn cmp(&self, other: &Self) -> Ordering {
        self.priority.cmp(&other.priority)
    }
}

impl PartialOrd for ScheduledTask {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Priority Task Scheduler coordinating ready nodes with slot limits
#[derive(Debug)]
pub struct PriorityScheduler {
    queue: BinaryHeap<ScheduledTask>,
    completed_nodes: HashSet<String>,
    max_concurrency_slots: usize,
    active_slots: usize,
}

impl PriorityScheduler {
    pub fn new(max_concurrency_slots: usize) -> Self {
        Self {
            queue: BinaryHeap::new(),
            completed_nodes: HashSet::new(),
            max_concurrency_slots,
            active_slots: 0,
        }
    }

    pub fn push_task(&mut self, node_id: impl Into<String>, priority: i32) {
        self.queue.push(ScheduledTask {
            node_id: node_id.into(),
            priority,
        });
    }

    pub fn pop_next_ready(&mut self) -> Option<ScheduledTask> {
        if self.active_slots >= self.max_concurrency_slots {
            return None;
        }
        if let Some(task) = self.queue.pop() {
            self.active_slots += 1;
            Some(task)
        } else {
            None
        }
    }

    pub fn complete_task(&mut self, node_id: &str) {
        if self.active_slots > 0 {
            self.active_slots -= 1;
        }
        self.completed_nodes.insert(node_id.to_string());
    }

    pub fn has_completed(&self, node_id: &str) -> bool {
        self.completed_nodes.contains(node_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_priority_scheduling_and_slots() {
        let mut scheduler = PriorityScheduler::new(2);
        scheduler.push_task("node_low", 10);
        scheduler.push_task("node_high", 100);
        scheduler.push_task("node_mid", 50);

        let t1 = scheduler.pop_next_ready().unwrap();
        assert_eq!(t1.node_id, "node_high");

        let t2 = scheduler.pop_next_ready().unwrap();
        assert_eq!(t2.node_id, "node_mid");

        // Slots full
        assert!(scheduler.pop_next_ready().is_none());

        scheduler.complete_task(&t1.node_id);
        assert!(scheduler.has_completed("node_high"));

        let t3 = scheduler.pop_next_ready().unwrap();
        assert_eq!(t3.node_id, "node_low");
    }
}
