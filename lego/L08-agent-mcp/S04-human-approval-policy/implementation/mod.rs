//! L08.S04 — Human approval and policy boundary
//!
//! Enforces policy gating, risk-tier evaluation, and human-in-the-loop approval workflows
//! for potentially destructive or sensitive autonomous agent actions.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RiskTier {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRule {
    pub tool_pattern: String,
    pub risk_tier: RiskTier,
    pub requires_human_approval: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub request_id: String,
    pub session_id: String,
    pub tool_name: String,
    pub parameters: serde_json::Value,
    pub risk_tier: RiskTier,
    pub status: ApprovalStatus,
    pub requested_at_ms: u64,
    pub timeout_seconds: u64,
    pub decided_at_ms: Option<u64>,
    pub decided_by: Option<String>,
    pub decision_reason: Option<String>,
}

#[derive(Debug)]
pub enum ApprovalError {
    RequestNotFound(String),
    AlreadyDecided(String),
    RequestExpired(String),
    UnauthorizedApprover(String),
    InvalidPayload(String),
    LockError(String),
}

impl std::fmt::Display for ApprovalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RequestNotFound(id) => write!(f, "Approval request not found: {id}"),
            Self::AlreadyDecided(id) => write!(f, "Approval request has already been decided: {id}"),
            Self::RequestExpired(id) => write!(f, "Approval request has expired: {id}"),
            Self::UnauthorizedApprover(msg) => write!(f, "Unauthorized approver: {msg}"),
            Self::InvalidPayload(msg) => write!(f, "Invalid payload: {msg}"),
            Self::LockError(msg) => write!(f, "Lock acquisition error: {msg}"),
        }
    }
}

impl std::error::Error for ApprovalError {}

#[derive(Debug, Clone)]
pub struct HumanApprovalService {
    // State domain: human-approval-inbox
    inbox: Arc<RwLock<HashMap<String, ApprovalRequest>>>,
    policy_rules: Arc<RwLock<Vec<PolicyRule>>>,
}

impl Default for HumanApprovalService {
    fn default() -> Self {
        Self::new()
    }
}

impl HumanApprovalService {
    pub fn new() -> Self {
        let service = Self {
            inbox: Arc::new(RwLock::new(HashMap::new())),
            policy_rules: Arc::new(RwLock::new(Vec::new())),
        };

        // Standard default policies
        let _ = service.add_policy_rule(PolicyRule {
            tool_pattern: "delete_*".to_string(),
            risk_tier: RiskTier::Critical,
            requires_human_approval: true,
        });
        let _ = service.add_policy_rule(PolicyRule {
            tool_pattern: "shell_exec*".to_string(),
            risk_tier: RiskTier::Critical,
            requires_human_approval: true,
        });
        let _ = service.add_policy_rule(PolicyRule {
            tool_pattern: "send_email*".to_string(),
            risk_tier: RiskTier::High,
            requires_human_approval: true,
        });
        let _ = service.add_policy_rule(PolicyRule {
            tool_pattern: "database_write*".to_string(),
            risk_tier: RiskTier::High,
            requires_human_approval: true,
        });
        let _ = service.add_policy_rule(PolicyRule {
            tool_pattern: "*".to_string(),
            risk_tier: RiskTier::Low,
            requires_human_approval: false,
        });

        service
    }

    pub fn add_policy_rule(&self, rule: PolicyRule) -> Result<(), ApprovalError> {
        let mut rules = self.policy_rules.write().map_err(|_| {
            ApprovalError::LockError("Failed to acquire write lock".to_string())
        })?;
        rules.push(rule);
        Ok(())
    }

    /// Evaluates tool name against registered policy rules with specificity ordering:
    /// 1. Exact match (highest precedence)
    /// 2. Prefix pattern match (e.g. "delete_*")
    /// 3. Wildcard catch-all match ("*")
    /// 4. Default fail-closed fallback: High risk requiring approval
    pub fn evaluate_policy(&self, tool_name: &str) -> Result<(RiskTier, bool), ApprovalError> {
        let rules = self.policy_rules.read().map_err(|_| {
            ApprovalError::LockError("Failed to acquire read lock".to_string())
        })?;

        // 1. Exact match
        for rule in rules.iter() {
            if rule.tool_pattern == tool_name {
                return Ok((rule.risk_tier, rule.requires_human_approval));
            }
        }

        // 2. Prefix wildcard match
        for rule in rules.iter() {
            if rule.tool_pattern.ends_with('*') && rule.tool_pattern != "*" {
                let prefix = &rule.tool_pattern[..rule.tool_pattern.len() - 1];
                if tool_name.starts_with(prefix) {
                    return Ok((rule.risk_tier, rule.requires_human_approval));
                }
            }
        }

        // 3. Catch-all wildcard match
        for rule in rules.iter() {
            if rule.tool_pattern == "*" {
                return Ok((rule.risk_tier, rule.requires_human_approval));
            }
        }

        // Default fail-closed: High risk requiring approval
        Ok((RiskTier::High, true))
    }

    pub fn create_request(
        &self,
        request_id: &str,
        session_id: &str,
        tool_name: &str,
        parameters: serde_json::Value,
        timeout_seconds: u64,
        current_time_ms: u64,
    ) -> Result<ApprovalRequest, ApprovalError> {
        let (tier, requires_approval) = self.evaluate_policy(tool_name)?;

        let initial_status = if !requires_approval {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Pending
        };

        let request = ApprovalRequest {
            request_id: request_id.to_string(),
            session_id: session_id.to_string(),
            tool_name: tool_name.to_string(),
            parameters,
            risk_tier: tier,
            status: initial_status,
            requested_at_ms: current_time_ms,
            timeout_seconds: if timeout_seconds == 0 { 300 } else { timeout_seconds },
            decided_at_ms: if !requires_approval { Some(current_time_ms) } else { None },
            decided_by: if !requires_approval { Some("policy_auto".to_string()) } else { None },
            decision_reason: if !requires_approval { Some("Auto-approved by low risk policy".to_string()) } else { None },
        };

        let mut map = self.inbox.write().map_err(|_| {
            ApprovalError::LockError("Failed to acquire write lock".to_string())
        })?;
        map.insert(request_id.to_string(), request.clone());

        Ok(request)
    }

    pub fn submit_decision(
        &self,
        request_id: &str,
        approver_id: &str,
        approved: bool,
        reason: &str,
        current_time_ms: u64,
    ) -> Result<ApprovalRequest, ApprovalError> {
        let mut map = self.inbox.write().map_err(|_| {
            ApprovalError::LockError("Failed to acquire write lock".to_string())
        })?;

        let req = map
            .get_mut(request_id)
            .ok_or_else(|| ApprovalError::RequestNotFound(request_id.to_string()))?;

        if req.status != ApprovalStatus::Pending {
            return Err(ApprovalError::AlreadyDecided(format!(
                "Request is already {:?}",
                req.status
            )));
        }

        // Check timeout
        let elapsed_secs = (current_time_ms.saturating_sub(req.requested_at_ms)) / 1000;
        if elapsed_secs > req.timeout_seconds {
            req.status = ApprovalStatus::Expired;
            return Err(ApprovalError::RequestExpired(request_id.to_string()));
        }

        req.status = if approved {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Rejected
        };
        req.decided_at_ms = Some(current_time_ms);
        req.decided_by = Some(approver_id.to_string());
        req.decision_reason = Some(reason.to_string());

        Ok(req.clone())
    }

    pub fn get_request(&self, request_id: &str, current_time_ms: u64) -> Result<ApprovalRequest, ApprovalError> {
        let mut map = self.inbox.write().map_err(|_| {
            ApprovalError::LockError("Failed to acquire write lock".to_string())
        })?;

        let req = map
            .get_mut(request_id)
            .ok_or_else(|| ApprovalError::RequestNotFound(request_id.to_string()))?;

        // Lazily expire if time passed
        if req.status == ApprovalStatus::Pending {
            let elapsed_secs = (current_time_ms.saturating_sub(req.requested_at_ms)) / 1000;
            if elapsed_secs > req.timeout_seconds {
                req.status = ApprovalStatus::Expired;
            }
        }

        Ok(req.clone())
    }

    pub fn list_pending(&self, session_id: Option<&str>) -> Result<Vec<ApprovalRequest>, ApprovalError> {
        let map = self.inbox.read().map_err(|_| {
            ApprovalError::LockError("Failed to acquire read lock".to_string())
        })?;
        let mut result = Vec::new();
        for req in map.values() {
            if req.status == ApprovalStatus::Pending {
                if let Some(sid) = session_id {
                    if req.session_id != sid {
                        continue;
                    }
                }
                result.push(req.clone());
            }
        }
        result.sort_by(|a, b| a.requested_at_ms.cmp(&b.requested_at_ms));
        Ok(result)
    }

    /// Handles port invocation payloads for port.agent.policy.approve.v1,
    /// port.agent.approval.request.v1, and port.agent.approval.submit.v1
    pub fn handle_port_invocation(&self, payload: &serde_json::Value) -> Result<serde_json::Value, ApprovalError> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("evaluate");

        match action {
            "evaluate" => {
                let tool_name = payload.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
                let (tier, requires_approval) = self.evaluate_policy(tool_name)?;
                Ok(serde_json::json!({
                    "tool_name": tool_name,
                    "risk_tier": format!("{:?}", tier),
                    "requires_human_approval": requires_approval
                }))
            }
            "request" => {
                let req_id = payload.get("request_id").and_then(|v| v.as_str()).unwrap_or("req-1");
                let sess_id = payload.get("session_id").and_then(|v| v.as_str()).unwrap_or("sess-1");
                let tool_name = payload.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
                let params = payload.get("parameters").cloned().unwrap_or(serde_json::json!({}));
                let timeout = payload.get("timeout_seconds").and_then(|v| v.as_u64()).unwrap_or(300);
                let now = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(1000);

                let req = self.create_request(req_id, sess_id, tool_name, params, timeout, now)?;
                Ok(serde_json::to_value(&req).map_err(|e| ApprovalError::InvalidPayload(e.to_string()))?)
            }
            "submit" => {
                let req_id = payload.get("request_id").and_then(|v| v.as_str()).unwrap_or("");
                let approver = payload.get("approver_id").and_then(|v| v.as_str()).unwrap_or("admin");
                let approved = payload.get("approved").and_then(|v| v.as_bool()).unwrap_or(false);
                let reason = payload.get("reason").and_then(|v| v.as_str()).unwrap_or("Decision applied");
                let now = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(1500);

                let req = self.submit_decision(req_id, approver, approved, reason, now)?;
                Ok(serde_json::to_value(&req).map_err(|e| ApprovalError::InvalidPayload(e.to_string()))?)
            }
            "get" => {
                let req_id = payload.get("request_id").and_then(|v| v.as_str()).unwrap_or("");
                let now = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(1000);
                let req = self.get_request(req_id, now)?;
                Ok(serde_json::to_value(&req).map_err(|e| ApprovalError::InvalidPayload(e.to_string()))?)
            }
            "add_rule" => {
                let rule_val = payload.get("rule").cloned().unwrap_or(serde_json::Value::Null);
                let rule: PolicyRule = serde_json::from_value(rule_val)
                    .map_err(|e| ApprovalError::InvalidPayload(e.to_string()))?;
                let pat = rule.tool_pattern.clone();
                self.add_policy_rule(rule)?;
                Ok(serde_json::json!({ "added_rule": pat, "success": true }))
            }
            "list_pending" => {
                let sess_id = payload.get("session_id").and_then(|v| v.as_str());
                let pending = self.list_pending(sess_id)?;
                Ok(serde_json::to_value(&pending).map_err(|e| ApprovalError::InvalidPayload(e.to_string()))?)
            }
            other => Err(ApprovalError::InvalidPayload(format!("Unsupported action: {other}"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/human_approval_test.rs"]
mod tests;
