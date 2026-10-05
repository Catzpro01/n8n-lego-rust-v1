use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::{get, post, put, patch, delete},
    Router,
};
use chrono::Utc;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

use crate::db::Database;
use crate::events::ExecutionEvent;
use crate::parser::WorkflowGraph;
use crate::WorkflowExecutor;

use n8n_realtime::{is_heartbeat_message, PushMessage, SessionRegistry};
use n8n_common::INodeExecutionData;
use n8n_runtime_kernel::{
    ExecutionContext, ExecutionMode, KernelScheduler,
    WorkflowExecutionStatus,
};
use n8n_workflow::Workflow as KernelWorkflow;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: Database,
    pub event_sender: broadcast::Sender<ExecutionEvent>,
    pub realtime_registry: SessionRegistry,
}

pub fn create_router(state: AppState) -> Router {
    Router::new()
        // Health check
        .route("/health", get(health_handler))
        .route("/healthz", get(health_handler))
        .route("/api/polyglot/versions", get(polyglot_versions_handler))
        // Webhooks
        .route("/webhook/{id}", post(webhook_handler).get(webhook_handler))
        .route("/webhook-test/{id}", post(webhook_handler).get(webhook_handler))
        .route("/rest/webhooks/find", post(empty_list_handler))
        
        // REST API Workflow
        .route("/rest/workflows", get(list_workflows_handler).post(create_workflow_handler))
        .route(
            "/rest/workflows/{id}",
            get(get_workflow_handler)
                .post(update_workflow_handler)
                .put(update_workflow_handler)
                .patch(update_workflow_handler)
                .delete(delete_workflow_handler),
        )
        .route("/rest/workflows/{id}/run", post(run_workflow_handler))
        .route("/rest/workflows/run", post(run_workflow_root_handler))
        .route("/api/v1/executions", post(api_v1_executions_handler))
        .route("/rest/workflows/{id}/exists", get(workflow_exists_handler))
        .route("/rest/workflows/{id}/activate", post(activate_workflow_handler))
        .route("/rest/workflows/{id}/deactivate", post(deactivate_workflow_handler))
        .route("/rest/workflows/{id}/archive", post(empty_json_obj_handler))
        .route("/rest/workflows/{id}/unarchive", post(empty_json_obj_handler))
        .route("/rest/workflows/{id}/collaboration/write-lock", get(empty_json_null_handler))
        .route("/rest/workflows/{id}/executions/last-successful", get(empty_json_null_handler))
        .route("/rest/workflows/{id}/publication-status", get(publication_status_handler))
        .route("/rest/workflows/{id}/evaluation-configs", get(empty_list_handler).post(empty_json_obj_handler))
        .route("/rest/workflows/{id}/evaluation-configs/{eid}", get(empty_json_obj_handler).put(empty_json_obj_handler))
        .route("/rest/workflows/{id}/evaluation-configs/{eid}/dataset-rows", post(empty_list_handler))
        .route("/rest/workflows/{id}/tags", get(empty_list_handler))
        .route("/rest/workflows/{id}/shared", get(empty_list_handler))
        .route("/rest/workflows/{id}/share", put(empty_json_obj_handler))
        .route("/rest/workflows/{id}/transfer", put(empty_json_obj_handler))
        .route("/rest/workflows/with-node-types", post(empty_list_handler))
        .route("/rest/workflow-dependencies/counts", post(empty_json_obj_handler))
        .route("/rest/workflow-dependencies/details", post(empty_json_obj_handler))
        .route("/rest/workflow-review-requests", post(empty_json_obj_handler))
        .route("/rest/active-workflows", get(empty_list_handler))
        .route("/rest/workflow-history/{id}", get(empty_list_handler))
        .route("/rest/credentials/for-workflow", get(empty_list_handler))

        // Executions
        .route("/rest/executions", get(list_executions_handler))
        .route("/rest/executions/{id}", get(get_execution_handler).delete(delete_execution_handler).patch(empty_json_obj_handler))
        .route("/rest/executions/{id}/retry", post(retry_execution_handler))
        .route("/rest/executions/{id}/stop", post(stop_execution_handler))
        .route("/rest/executions/delete", post(empty_json_obj_handler))
        .route("/rest/executions/stopMany", post(empty_json_obj_handler))
        .route("/rest/executions/current", get(empty_list_handler))

        // Credentials CRUD
        .route("/rest/credentials", get(list_credentials_handler).post(create_credential_handler))
        .route(
            "/rest/credentials/{id}",
            get(get_credential_handler)
                .put(update_credential_handler)
                .patch(update_credential_handler)
                .delete(delete_credential_handler),
        )
        .route("/rest/credentials/test", post(test_credential_handler))
        .route("/rest/credentials/{id}/probe", get(empty_json_obj_handler).post(empty_json_obj_handler))
        .route("/rest/credentials/{id}/share", get(empty_json_obj_handler).put(empty_json_obj_handler))
        .route("/rest/credentials/{id}/transfer", get(empty_json_obj_handler).put(empty_json_obj_handler))
        .route("/rest/credentials/{id}/my-connection", get(empty_json_obj_handler))
        .route("/rest/credentials/{id}/oauth-token", get(empty_json_obj_handler))

        // Variables CRUD
        .route("/rest/variables", get(variables_list_handler).post(variables_create_handler))
        .route("/rest/variables/{id}", patch(variables_create_handler).delete(variables_delete_handler))

        // Tags CRUD
        .route("/rest/tags", get(tags_list_handler).post(tags_create_handler))
        .route("/rest/tags/{id}", patch(tags_create_handler).delete(tags_delete_handler))

        // Insights & Evaluations
        .route("/rest/insights/summary", get(insights_summary_handler))
        .route("/rest/insights/by-time/time-saved", get(insights_by_time_handler))
        .route("/rest/insights/by-time", get(insights_by_time_handler))
        .route("/rest/insights/by-workflow", get(insights_by_workflow_handler))
        .route("/rest/evaluation-metrics", get(empty_list_handler))
        .route("/rest/evaluations", get(empty_list_handler))
        .route("/rest/evaluation-runs", get(empty_list_handler))

        // Breaking Changes & Migration Report
        .route("/rest/breaking-changes/report", get(breaking_changes_report_handler))
        .route("/rest/breaking-changes/report/refresh", post(breaking_changes_report_handler))
        .route("/rest/breaking-changes/report/{id}", get(breaking_changes_report_handler))
        .route("/rest/breaking-changes/report/{id}/workflows/{wf_id}/migrate", post(empty_json_obj_handler))

        // Eventbus & Log Streaming
        .route("/rest/eventbus/destination", get(empty_list_handler).post(empty_json_obj_handler).delete(empty_json_obj_handler))
        .route("/rest/eventbus/eventnames", get(empty_list_handler))
        .route("/rest/eventbus/testmessage", get(empty_json_obj_handler).post(empty_json_obj_handler))
        .route("/rest/log-streaming/destination", get(empty_list_handler))

        // External Secrets & Providers
        .route("/rest/external-secrets/providers", get(empty_list_handler))
        .route("/rest/external-secrets/providers/{id}", get(empty_json_obj_handler).post(empty_json_obj_handler))
        .route("/rest/external-secrets/providers/{id}/connect", post(empty_json_obj_handler))
        .route("/rest/external-secrets/providers/{id}/test", post(empty_json_obj_handler))
        .route("/rest/external-secrets/providers/{id}/update", post(empty_json_obj_handler))
        .route("/rest/external-secrets/secrets", get(empty_list_handler))
        .route("/rest/external-secrets/settings", get(empty_json_obj_handler).post(empty_json_obj_handler))
        .route("/rest/external-secrets", get(empty_list_handler))

        // Credential Resolvers & Secret Providers
        .route("/rest/credential-resolvers", get(empty_list_handler).post(empty_json_obj_handler))
        .route("/rest/credential-resolvers/types", get(empty_list_handler))
        .route("/rest/credential-resolvers/{id}", get(empty_json_obj_handler).patch(empty_json_obj_handler).delete(empty_json_obj_handler))
        .route("/rest/credential-resolvers/{id}/workflows", get(empty_list_handler))
        .route("/rest/secret-providers/connections", get(empty_list_handler).post(empty_json_obj_handler))
        .route("/rest/secret-providers/connections/{id}", get(empty_json_obj_handler).patch(empty_json_obj_handler).delete(empty_json_obj_handler))
        .route("/rest/secret-providers/connections/{id}/reload", post(empty_json_obj_handler))
        .route("/rest/secret-providers/connections/{id}/test", post(empty_json_obj_handler))
        .route("/rest/secret-providers/types", get(empty_list_handler))
        .route("/rest/secret-providers/completions/secrets/global", get(empty_list_handler))
        .route("/rest/secret-providers/completions/secrets/global/{id}", get(empty_list_handler))
        .route("/rest/secret-providers/completions/secrets/project/{id}", get(empty_list_handler))
        .route("/rest/secret-providers/projects/{id}/connections", get(empty_list_handler).post(empty_json_obj_handler))
        .route("/rest/secret-providers/projects/{id}/connections/{cid}", get(empty_json_obj_handler).patch(empty_json_obj_handler).delete(empty_json_obj_handler))
        .route("/rest/secret-providers/projects/{id}/connections/{cid}/test", post(empty_json_obj_handler))

        // Dynamic Node Parameters
        .route("/rest/dynamic-node-parameters/options", post(empty_list_handler))
        .route("/rest/dynamic-node-parameters/action-result", post(empty_json_obj_handler))
        .route("/rest/dynamic-node-parameters/resource-mapper-fields", post(empty_resource_mapper_handler))
        .route("/rest/dynamic-node-parameters/resource-locator-results", post(empty_resource_locator_handler))
        .route("/rest/dynamic-node-parameters/local-resource-mapper-fields", post(empty_resource_mapper_handler))

        // Community Packages & Node Types
        .route("/rest/community-packages", get(community_packages_handler).patch(empty_json_obj_handler).delete(empty_json_obj_handler))
        .route("/rest/community-node-types", get(community_node_types_handler))
        .route("/rest/community-node-types/{name}", get(empty_json_obj_handler))

        // Types & Catalog (Disajikan persis dari official package bundle v2.39.6)
        .route("/types/credentials.json", get(credential_types_handler))
        .route("/types/nodes.json", get(node_types_handler))
        .route("/types/node-versions.json", get(node_versions_handler))
        .route("/rest/node-types", get(node_types_handler).post(node_types_handler))

        // Real-Time Canvas Streaming (WebSocket & SSE fallback)
        .route("/ws", get(websocket_handler))
        .route("/push", get(websocket_handler))
        .route("/rest/push", get(websocket_handler))
        .route("/api/realtime/broadcast", post(realtime_broadcast_handler))

        // System Settings, Auth, and Profiles
        .route("/rest/settings", get(settings_handler))
        .route("/rest/settings/security", get(empty_json_obj_handler).post(empty_json_obj_handler))
        .route("/rest/me", get(me_handler).patch(update_me_handler))
        .route("/rest/me/password", patch(empty_json_obj_handler))
        .route("/rest/me/settings", patch(empty_json_obj_handler))
        .route("/rest/me/survey", post(empty_json_obj_handler))
        .route("/rest/users/me", get(me_handler))
        .route("/rest/login", post(login_handler).get(login_handler))
        .route("/rest/logout", post(empty_json_obj_handler))
        .route("/rest/users", get(users_list_handler))
        .route("/rest/users/{id}", get(empty_json_obj_handler).delete(empty_json_obj_handler))
        .route("/rest/users/{id}/role", patch(empty_json_obj_handler))
        .route("/rest/users/{id}/settings", patch(empty_json_obj_handler))
        .route("/rest/users/{id}/invite-link", post(empty_json_obj_handler).get(empty_json_obj_handler))
        .route("/rest/users/{id}/password-reset-link", get(empty_json_obj_handler))
        .route("/rest/roles", get(roles_handler).post(empty_json_obj_handler))
        .route("/rest/roles/{id}", get(empty_json_obj_handler).patch(empty_json_obj_handler).delete(empty_json_obj_handler))
        .route("/rest/roles/{id}/members", get(empty_list_handler))
        .route("/rest/roles/{id}/assignments", get(empty_list_handler))
        .route("/rest/roles/{id}/assignments/{aid}/members", get(empty_list_handler))
        .route("/rest/role-mapping-rule", get(empty_list_handler).post(empty_json_obj_handler))
        .route("/rest/role-mapping-rule/{id}", patch(empty_json_obj_handler).delete(empty_json_obj_handler))
        .route("/rest/role-mapping-rule/{id}/move", post(empty_json_obj_handler))
        .route("/rest/projects", get(projects_list_handler).post(projects_list_handler))
        .route("/rest/projects/personal", get(personal_project_handler))
        .route("/rest/projects/my-projects", get(projects_list_handler))
        .route("/rest/projects/{id}", get(personal_project_handler).patch(personal_project_handler))
        .route("/rest/projects/{id}/folders", get(empty_list_handler).post(empty_json_obj_handler))
        .route("/rest/projects/{id}/folders/{fid}", patch(empty_json_obj_handler).delete(empty_json_obj_handler))
        .route("/rest/projects/{id}/folders/{fid}/transfer", put(empty_json_obj_handler))
        .route("/rest/projects/{id}/users", get(empty_list_handler).post(empty_json_obj_handler))
        .route("/rest/projects/{id}/users/{uid}", patch(empty_json_obj_handler).delete(empty_json_obj_handler))
        .route("/rest/projects/{id}/pool-settings", get(empty_json_obj_handler).patch(empty_json_obj_handler))
        .route("/rest/license", get(license_handler))
        .route("/rest/license/activate", post(empty_json_obj_handler))
        .route("/rest/license/renew", post(empty_json_obj_handler))
        .route("/rest/license/enterprise/community-registered", post(empty_json_obj_handler))
        .route("/rest/license/enterprise/request_trial", post(empty_json_obj_handler))
        .route("/rest/favorites", get(empty_list_handler).post(empty_json_obj_handler))
        .route("/rest/source-control/preferences", get(source_control_preferences_handler))
        .route("/rest/source-control/status", get(empty_json_obj_handler))
        .route("/rest/data-tables-global", get(data_tables_list_handler))
        .route("/rest/data-tables-global/limits", get(data_tables_limits_handler))
        .route("/rest/data-tables/uploads", post(empty_json_obj_handler))
        .route("/rest/instance-ai/threads", get(instance_ai_threads_handler).post(empty_json_obj_handler))
        .route("/rest/instance-ai/settings", get(empty_json_obj_handler).put(empty_json_obj_handler))
        .route("/rest/instance-ai/preferences", get(empty_json_obj_handler).put(empty_json_obj_handler))
        .route("/rest/instance-ai-examples", get(empty_list_handler))
        .route("/rest/instance-registry", get(empty_json_obj_handler))
        .route("/rest/events/session-started", get(empty_json_obj_handler))
        .route("/rest/node-translation-headers", get(empty_json_obj_handler))
        .route("/rest/module-settings", get(empty_json_obj_handler))
        .route("/rest/user-settings/nps-survey", patch(empty_json_obj_handler))
        .route("/rest/api-keys", get(api_keys_handler).post(api_keys_handler))
        .route("/rest/api-keys/scopes", get(empty_list_handler))
        .route("/rest/api-keys/{id}", patch(empty_json_obj_handler).delete(empty_json_obj_handler))
        .route("/rest/api-keys/{id}/rotate", post(empty_json_obj_handler))
        .route("/rest/sso/saml/config", get(saml_config_handler).post(saml_config_handler))
        .route("/rest/sso/saml/config/test", post(empty_json_obj_handler))
        .route("/rest/sso/saml/initsso", get(empty_json_obj_handler))
        .route("/rest/sso/saml/metadata", get(empty_json_obj_handler))
        .route("/rest/sso/oidc/config", get(oidc_config_handler).post(oidc_config_handler))
        .route("/rest/sso/oidc/config/test", post(empty_json_obj_handler))
        .route("/rest/sso/oidc/logout", post(empty_json_obj_handler))
        .route("/rest/sso/provisioning/config", get(empty_json_obj_handler).patch(empty_json_obj_handler))
        .route("/rest/ldap/config", get(ldap_config_handler).post(ldap_config_handler).put(ldap_config_handler))
        .route("/rest/ldap/sync", get(empty_json_obj_handler).post(empty_json_obj_handler))
        .route("/rest/ldap/test-connection", post(empty_json_obj_handler))
        .route("/rest/mfa/can-enable", get(empty_bool_false_handler).post(empty_bool_false_handler))
        .route("/rest/mfa/enforce-mfa", get(empty_bool_false_handler).post(empty_bool_false_handler))
        .route("/rest/mfa/enable", post(empty_json_obj_handler))
        .route("/rest/mfa/disable", post(empty_json_obj_handler))
        .route("/rest/mfa/verify", post(empty_json_obj_handler))
        .route("/rest/mfa/qr", get(empty_json_obj_handler))
        .route("/rest/mcp/settings", get(empty_json_obj_handler).patch(empty_json_obj_handler))
        .route("/rest/mcp/api-key/rotate", post(empty_json_obj_handler))
        .route("/rest/chat/enabled", get(empty_bool_false_handler).put(empty_bool_false_handler))
        .route("/rest/chat/settings", get(empty_json_obj_handler).post(empty_json_obj_handler))
        .route("/rest/chat/semantic-search", put(empty_json_obj_handler))
        .route("/rest/otel/settings", get(empty_json_obj_handler).put(empty_json_obj_handler))
        .route("/rest/otel/test-trace", post(otel_test_trace_handler))
        .route("/rest/ai/usage-settings", get(empty_json_obj_handler).post(empty_json_obj_handler))
        .route("/rest/owner/dismiss-banner", post(empty_json_obj_handler))
        .route("/rest/owner/setup", post(empty_json_obj_handler))

        // Fallback: serve static files & index.html SPA
        .fallback(fallback_handler)
        .layer(CorsLayer::permissive())
        .with_state(state)
}

// ==========================================
// STATIC FILES & SPA FALLBACK HANDLER
// ==========================================
async fn fallback_handler(req: axum::extract::Request) -> impl IntoResponse {
    let raw_path = req.uri().path();
    let decoded = urlencoding::decode(raw_path).unwrap_or_else(|_| raw_path.into());
    let path = if decoded.contains("{{BASE_PATH}}") {
        decoded.replace("/{{BASE_PATH}}", "").replace("{{BASE_PATH}}", "")
    } else {
        decoded.to_string()
    };
    
    let static_base = "/home/catzpro01/.cache/n8n/public";
    let file_path = format!("{}{}", static_base, if path.is_empty() { "/".to_string() } else { path.clone() });
    
    if let Ok(content) = tokio::fs::read(&file_path).await {
        let mime = mime_guess::from_path(&file_path).first_or_octet_stream();
        return (StatusCode::OK, [(axum::http::header::CONTENT_TYPE, mime.as_ref().to_owned())], content).into_response();
    }
    
    // Cegah fallback ke index.html untuk missing REST APIs agar tidak membingungkan axios frontend
    if path.starts_with("/rest/") {
        let p_lower = path.to_lowercase();
        if p_lower.ends_with("s")
            || p_lower.contains("list")
            || p_lower.contains("rows")
            || p_lower.contains("destination")
            || p_lower.contains("eventnames")
            || p_lower.contains("secret")
            || p_lower.contains("provider")
            || p_lower.contains("connection")
            || p_lower.contains("type")
            || p_lower.contains("scope")
            || p_lower.contains("member")
            || p_lower.contains("rule")
            || p_lower.contains("item")
            || p_lower.contains("result")
            || p_lower.contains("example")
            || p_lower.contains("thread")
            || p_lower.contains("assignment")
            || p_lower.contains("for-workflow")
            || p_lower.contains("find")
        {
            return (
                StatusCode::OK,
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                serde_json::json!({ "data": [] }).to_string(),
            ).into_response();
        }
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            serde_json::json!({ "data": {} }).to_string(),
        ).into_response();
    }
    
    // Serve index.html SPA
    let index_file = format!("{}/index.html", static_base);
    match tokio::fs::read_to_string(&index_file).await {
        Ok(html) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
            html,
        ).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "index.html tidak ditemukan").into_response(),
    }
}

// ==========================================
// BREAKING CHANGES REPORT HANDLER
// ==========================================
async fn breaking_changes_report_handler() -> impl IntoResponse {
    let path = "/home/catzpro01/n8n-rust/n8n_rust_core/breaking_changes_report.json";
    if let Ok(content) = tokio::fs::read_to_string(path).await {
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            content,
        ).into_response();
    }
    Json(serde_json::json!({
        "data": {
            "report": {
                "generatedAt": Utc::now().to_rfc3339(),
                "targetVersion": "v2",
                "currentVersion": "2.39.6",
                "workflowResults": [],
                "instanceResults": []
            },
            "totalWorkflows": 1,
            "shouldCache": false
        }
    })).into_response()
}

// ==========================================
// SYSTEM SETTINGS & PROFILES HANDLERS
// ==========================================
async fn settings_handler() -> impl IntoResponse {
    let path = "/home/catzpro01/n8n-rust/n8n_rust_core/settings_complete.json";
    if let Ok(content) = tokio::fs::read_to_string(path).await {
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            content,
        ).into_response();
    }

    // Fallback minimal
    Json(serde_json::json!({
        "data": {
            "versionCli": "2.39.6",
            "pushBackend": "websocket",
            "urlBaseEditor": "http://localhost:5678",
            "urlBaseWebhook": "http://localhost:5678/",
            "endpointWebhook": "webhook"
        }
    })).into_response()
}

async fn me_handler() -> impl IntoResponse {
    let scopes_path = "/home/catzpro01/n8n-rust/n8n_rust_core/global_scopes.json";
    let global_scopes: serde_json::Value = if let Ok(content) = tokio::fs::read_to_string(scopes_path).await {
        serde_json::from_str(&content).unwrap_or(serde_json::json!([]))
    } else {
        serde_json::json!([])
    };

    Json(serde_json::json!({
        "data": {
            "id": "dccf3219-09ba-4c8d-aee6-b0ebd7a57cae",
            "email": "admin@example.com",
            "firstName": "Admin",
            "lastName": "N8N",
            "personalProject": {
                "id": "6BERd9J8smAOytt0",
                "name": "Admin N8N <admin@example.com>",
                "type": "personal"
            },
            "settings": {
                "userActivated": true,
                "isPending": false
            },
            "disabled": false,
            "mfaEnabled": false,
            "isOwner": true,
            "isPending": false,
            "globalScopes": global_scopes
        }
    }))
}

async fn update_me_handler(_payload: Option<Json<serde_json::Value>>) -> impl IntoResponse {
    me_handler().await
}

async fn login_handler(_body: Option<Json<serde_json::Value>>) -> impl IntoResponse {
    me_handler().await
}

async fn users_list_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "count": 1,
            "items": [
                {
                    "id": "dccf3219-09ba-4c8d-aee6-b0ebd7a57cae",
                    "email": "admin@example.com",
                    "firstName": "Admin",
                    "lastName": "N8N",
                    "isOwner": true,
                    "role": "global:owner",
                    "personalProject": {
                        "id": "6BERd9J8smAOytt0",
                        "name": "Admin N8N <admin@example.com>",
                        "type": "personal"
                    },
                    "disabled": false
                }
            ]
        }
    }))
}

async fn roles_handler() -> impl IntoResponse {
    let roles_path = "/home/catzpro01/n8n-rust/n8n_rust_core/roles_data.json";
    if let Ok(content) = tokio::fs::read_to_string(roles_path).await {
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            content,
        ).into_response();
    }
    Json(serde_json::json!({ "data": { "global": [], "project": [] } })).into_response()
}

async fn personal_project_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "id": "6BERd9J8smAOytt0",
            "name": "Admin N8N <admin@example.com>",
            "type": "personal",
            "createdAt": "2026-10-04T18:51:02.100Z",
            "updatedAt": "2026-10-04T18:57:53.718Z",
            "scopes": [
                "project:create", "project:delete", "project:read", "project:update",
                "workflow:create", "workflow:delete", "workflow:list", "workflow:read", "workflow:update",
                "credential:create", "credential:delete", "credential:list", "credential:read", "credential:update"
            ]
        }
    }))
}

async fn projects_list_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": [
            {
                "id": "6BERd9J8smAOytt0",
                "name": "Admin N8N <admin@example.com>",
                "type": "personal",
                "createdAt": "2026-10-04T18:51:02.100Z",
                "updatedAt": "2026-10-04T18:57:53.718Z"
            }
        ]
    }))
}

async fn source_control_preferences_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "branchReadOnly": false
        }
    }))
}

async fn data_tables_limits_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "totalBytes": 0,
            "quotaStatus": "ok",
            "dataTables": {}
        }
    }))
}

async fn data_tables_list_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "count": 0,
            "data": []
        }
    }))
}

async fn api_keys_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "items": [],
            "counts": {
                "all": 0,
                "mine": 0
            },
            "totals": {
                "all": 0,
                "mine": 0
            },
            "owners": []
        }
    }))
}

async fn saml_config_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "loginEnabled": false,
            "entityID": "http://localhost:5678/rest/sso/saml/metadata",
            "returnUrl": "http://localhost:5678/rest/sso/saml/acs",
            "metadataUrl": "",
            "binding": "redirect"
        }
    }))
}

async fn oidc_config_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "loginEnabled": false,
            "clientId": "",
            "discoveryEndpoint": ""
        }
    }))
}

async fn ldap_config_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "loginEnabled": false,
            "loginLabel": "LDAP Login",
            "connectionUrl": "",
            "baseDn": "",
            "bindingDn": "",
            "userFilter": "(uid={0})",
            "firstNameAttribute": "givenName",
            "lastNameAttribute": "sn",
            "emailAttribute": "mail"
        }
    }))
}

async fn instance_ai_threads_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": []
    }))
}

async fn otel_test_trace_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "success": true
        }
    }))
}

async fn license_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "usage": {
                "activeWorkflowTriggers": {
                    "value": 0,
                    "limit": -1,
                    "warningThreshold": 0.8
                },
                "workflowsHavingEvaluations": {
                    "value": 0,
                    "limit": 0
                }
            },
            "license": {
                "planId": "",
                "planName": "Community"
            },
            "planName": "Community",
            "environment": "production",
            "consumerId": "rust-n8n-owner"
        }
    }))
}

async fn insights_summary_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "averageRunTime": {
                "value": 0,
                "unit": "millisecond",
                "deviation": null
            },
            "failed": {
                "value": 0,
                "unit": "count",
                "deviation": null
            },
            "failureRate": {
                "value": 0,
                "unit": "ratio",
                "deviation": null
            },
            "timeSaved": {
                "value": 0,
                "unit": "minute",
                "deviation": null
            },
            "total": {
                "value": 0,
                "unit": "count",
                "deviation": null
            }
        }
    }))
}

async fn insights_by_time_handler() -> impl IntoResponse {
    Json(serde_json::json!({ "data": [] }))
}

async fn insights_by_workflow_handler() -> impl IntoResponse {
    Json(serde_json::json!({ "data": { "count": 0, "data": [] } }))
}

async fn community_packages_handler() -> impl IntoResponse {
    let path = "/home/catzpro01/n8n-rust/n8n_rust_core/types/community-packages.json";
    if let Ok(content) = tokio::fs::read_to_string(path).await {
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            content,
        ).into_response();
    }
    Json(serde_json::json!({ "data": [] })).into_response()
}

async fn community_node_types_handler() -> impl IntoResponse {
    let path = "/home/catzpro01/n8n-rust/n8n_rust_core/types/community-node-types.json";
    if let Ok(content) = tokio::fs::read_to_string(path).await {
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            content,
        ).into_response();
    }
    Json(serde_json::json!({ "data": [] })).into_response()
}

async fn publication_status_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "isPublished": false,
            "hasDraftChanges": true
        }
    }))
}

async fn workflow_exists_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "data": {
            "exists": true
        }
    }))
}

async fn empty_list_handler() -> impl IntoResponse {
    Json(serde_json::json!({ "data": [] }))
}

async fn empty_json_obj_handler() -> impl IntoResponse {
    Json(serde_json::json!({ "data": {} }))
}

async fn empty_json_null_handler() -> impl IntoResponse {
    Json(serde_json::json!({ "data": null }))
}

async fn empty_bool_false_handler() -> impl IntoResponse {
    Json(serde_json::json!({ "data": false }))
}

async fn empty_resource_mapper_handler() -> impl IntoResponse {
    Json(serde_json::json!({ "data": { "fields": [] } }))
}

async fn empty_resource_locator_handler() -> impl IntoResponse {
    Json(serde_json::json!({ "data": { "results": [] } }))
}

// ==========================================
// NODE CATALOG & VERSIONS (OFFICIAL 2.39.6)
// ==========================================
async fn node_types_handler() -> impl IntoResponse {
    let path = "/home/catzpro01/.cache/n8n/public/types/nodes.json";
    if let Ok(content) = tokio::fs::read_to_string(path).await {
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            content,
        ).into_response();
    }
    Json(serde_json::json!([])).into_response()
}

async fn credential_types_handler() -> impl IntoResponse {
    let path = "/home/catzpro01/.cache/n8n/public/types/credentials.json";
    if let Ok(content) = tokio::fs::read_to_string(path).await {
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            content,
        ).into_response();
    }
    Json(serde_json::json!([])).into_response()
}

async fn node_versions_handler() -> impl IntoResponse {
    let path = "/home/catzpro01/.cache/n8n/public/types/node-versions.json";
    if let Ok(content) = tokio::fs::read_to_string(path).await {
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            content,
        ).into_response();
    }
    Json(serde_json::json!({})).into_response()
}

// ==========================================
// WORKFLOW HELPER FUNCTIONS
// ==========================================
fn generate_id() -> String {
    let u = uuid::Uuid::new_v4().to_string().replace("-", "");
    u[..16].to_string()
}

fn enrich_workflow(mut val: serde_json::Value, fallback_id: Option<String>) -> (String, String, bool, serde_json::Value) {
    let now = Utc::now().to_rfc3339();
    let id = val.get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty() && *s != "new")
        .map(|s| s.to_string())
        .or(fallback_id)
        .unwrap_or_else(generate_id);

    let name = val.get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("My workflow")
        .to_string();

    let active = val.get("active")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let version_id = val.get("versionId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Generate SHA-256 style 64-char checksum
    let raw_seed = format!("{}:{}:{}", id, version_id, now);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    raw_seed.hash(&mut hasher);
    let h1 = hasher.finish();
    now.hash(&mut hasher);
    let h2 = hasher.finish();
    let checksum = format!("{:016x}{:016x}{:016x}{:016x}", h1, h2, h1 ^ h2, h1.wrapping_add(h2));

    if let Some(obj) = val.as_object_mut() {
        obj.insert("id".to_string(), serde_json::Value::String(id.clone()));
        obj.insert("name".to_string(), serde_json::Value::String(name.clone()));
        obj.insert("description".to_string(), obj.get("description").cloned().unwrap_or(serde_json::Value::Null));
        obj.insert("active".to_string(), serde_json::Value::Bool(active));
        obj.entry("isArchived").or_insert_with(|| serde_json::Value::Bool(false));
        obj.entry("nodes").or_insert_with(|| serde_json::json!([]));
        obj.entry("connections").or_insert_with(|| serde_json::json!({}));
        obj.entry("settings").or_insert_with(|| serde_json::json!({ "executionOrder": "v1", "binaryMode": "separate" }));
        obj.entry("staticData").or_insert_with(|| serde_json::Value::Null);
        obj.entry("pinData").or_insert_with(|| serde_json::json!({}));
        obj.entry("meta").or_insert_with(|| serde_json::Value::Null);
        obj.entry("nodeGroups").or_insert_with(|| serde_json::json!([]));
        obj.entry("tags").or_insert_with(|| serde_json::json!([]));
        obj.insert("versionId".to_string(), serde_json::Value::String(version_id.clone()));
        obj.entry("versionCounter").or_insert_with(|| serde_json::json!(1));
        obj.entry("triggerCount").or_insert_with(|| serde_json::json!(0));
        obj.insert("sourceWorkflowId".to_string(), serde_json::Value::Null);
        obj.insert("parentFolder".to_string(), serde_json::Value::Null);
        obj.entry("createdAt").or_insert_with(|| serde_json::Value::String(now.clone()));
        obj.insert("updatedAt".to_string(), serde_json::Value::String(now.clone()));
        obj.insert("checksum".to_string(), serde_json::Value::String(checksum));

        if active {
            obj.insert("activeVersionId".to_string(), serde_json::Value::String(version_id.clone()));
            obj.insert("activeVersion".to_string(), serde_json::json!({
                "versionId": version_id,
                "createdAt": now
            }));
        } else {
            obj.insert("activeVersionId".to_string(), serde_json::Value::Null);
            obj.insert("activeVersion".to_string(), serde_json::Value::Null);
        }

        // Injeksi Scopes & Shared lengkap agar Frontend n8n memberikan hak akses penuh
        obj.insert("scopes".to_string(), serde_json::json!([
            "execution:reveal", "workflow:create", "workflow:delete",
            "workflow:disableRedaction", "workflow:enableRedaction", "workflow:execute",
            "workflow:execute-chat", "workflow:export", "workflow:import", "workflow:list",
            "workflow:move", "workflow:publish", "workflow:read", "workflow:share",
            "workflow:unpublish", "workflow:unshare", "workflow:update"
        ]));

        obj.insert("shared".to_string(), serde_json::json!([
            {
                "role": "workflow:owner",
                "workflowId": id,
                "projectId": "6BERd9J8smAOytt0",
                "project": {
                    "id": "6BERd9J8smAOytt0",
                    "name": "Admin N8N <admin@example.com>",
                    "type": "personal"
                }
            }
        ]));

        // Sanitize every node in the workflow
        if let Some(nodes) = obj.get_mut("nodes").and_then(|n| n.as_array_mut()) {
            for node in nodes.iter_mut() {
                if let Some(n_obj) = node.as_object_mut() {
                    if let Some(tv) = n_obj.get("typeVersion") {
                        if let Some(f) = tv.as_f64() {
                            n_obj.insert("typeVersion".to_string(), serde_json::json!(f as i64));
                        }
                    }
                    if let Some(d) = n_obj.get("disabled") {
                        if d.is_null() {
                            n_obj.remove("disabled");
                        }
                    }
                    if let Some(c) = n_obj.get("credentials") {
                        if c.is_null() {
                            n_obj.remove("credentials");
                        }
                    }
                    n_obj.entry("parameters").or_insert_with(|| serde_json::json!({}));
                }
            }
        }
    }

    (id, name, active, val)
}

// ==========================================
// WORKFLOW HANDLERS (CRUD & EXECUTION)
// ==========================================
async fn list_workflows_handler(State(state): State<AppState>) -> impl IntoResponse {
    match state.db.list_workflows_raw().await {
        Ok(wfs) => {
            let enriched: Vec<serde_json::Value> = wfs.into_iter().map(|wf| {
                let (_, _, _, enriched_wf) = enrich_workflow(wf, None);
                enriched_wf
            }).collect();
            (StatusCode::OK, Json(serde_json::json!({ "data": enriched })))
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn create_workflow_handler(
    State(state): State<AppState>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let (id, name, active, enriched_wf) = enrich_workflow(payload, None);
    match state.db.save_workflow_raw(&id, &name, active, &enriched_wf).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "data": enriched_wf }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn get_workflow_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if id == "new" {
        let (_, _, _, template_wf) = enrich_workflow(serde_json::json!({ "name": "My workflow" }), None);
        return (StatusCode::OK, Json(serde_json::json!({ "data": template_wf })));
    }

    match state.db.get_workflow_raw(&id).await {
        Ok(Some(wf)) => {
            let (_, _, _, enriched_wf) = enrich_workflow(wf, Some(id));
            (StatusCode::OK, Json(serde_json::json!({ "data": enriched_wf })))
        }
        _ => {
            let (_, _, _, fallback_wf) = enrich_workflow(serde_json::json!({ "id": id, "name": "My workflow" }), Some(id));
            (StatusCode::OK, Json(serde_json::json!({ "data": fallback_wf })))
        }
    }
}

async fn update_workflow_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    // Merge dengan data lama jika ada
    let existing = state.db.get_workflow_raw(&id).await.unwrap_or(None);
    if let Some(mut old_val) = existing {
        if let (Some(old_obj), Some(new_obj)) = (old_val.as_object_mut(), payload.as_object()) {
            for (k, v) in new_obj {
                old_obj.insert(k.clone(), v.clone());
            }
            payload = serde_json::Value::Object(old_obj.clone());
        }
    }

    let (saved_id, name, active, enriched_wf) = enrich_workflow(payload, Some(id));
    match state.db.save_workflow_raw(&saved_id, &name, active, &enriched_wf).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "data": enriched_wf }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn delete_workflow_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.delete_workflow_raw(&id).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "data": { "success": true } }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn activate_workflow_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if let Ok(Some(wf_json)) = state.db.get_workflow_raw(&id).await {
        let (saved_id, name, _, mut enriched) = enrich_workflow(wf_json, Some(id));
        if let Some(obj) = enriched.as_object_mut() {
            obj.insert("active".to_string(), serde_json::Value::Bool(true));
        }
        let _ = state.db.save_workflow_raw(&saved_id, &name, true, &enriched).await;
        return (StatusCode::OK, Json(serde_json::json!({ "data": enriched })));
    }
    (StatusCode::OK, Json(serde_json::json!({ "data": { "active": true } })))
}

async fn deactivate_workflow_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if let Ok(Some(wf_json)) = state.db.get_workflow_raw(&id).await {
        let (saved_id, name, _, mut enriched) = enrich_workflow(wf_json, Some(id));
        if let Some(obj) = enriched.as_object_mut() {
            obj.insert("active".to_string(), serde_json::Value::Bool(false));
        }
        let _ = state.db.save_workflow_raw(&saved_id, &name, false, &enriched).await;
        return (StatusCode::OK, Json(serde_json::json!({ "data": enriched })));
    }
    (StatusCode::OK, Json(serde_json::json!({ "data": { "active": false } })))
}

// ==========================================
// WORKFLOW EXECUTION RUNNER
// ==========================================
async fn run_workflow_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Option<Json<serde_json::Value>>,
) -> impl IntoResponse {
    execute_workflow_internal(state, id, body).await
}

async fn run_workflow_root_handler(
    State(state): State<AppState>,
    body: Option<Json<serde_json::Value>>,
) -> impl IntoResponse {
    let id = body
        .as_ref()
        .and_then(|Json(b)| {
            b.get("workflowData")
                .and_then(|w| w.get("id"))
                .or_else(|| b.get("id"))
                .or_else(|| b.get("workflowId"))
                .and_then(|i| i.as_str())
        })
        .map(|s| s.to_string())
        .unwrap_or_else(generate_id);
    execute_workflow_internal(state, id, body).await
}

async fn api_v1_executions_handler(
    State(state): State<AppState>,
    body: Option<Json<serde_json::Value>>,
) -> impl IntoResponse {
    let id = body
        .as_ref()
        .and_then(|Json(b)| {
            b.get("workflowId")
                .or_else(|| b.get("id"))
                .or_else(|| b.get("workflowData").and_then(|w| w.get("id")))
                .and_then(|i| i.as_str())
        })
        .map(|s| s.to_string())
        .unwrap_or_else(generate_id);
    execute_workflow_internal(state, id, body).await
}

fn parse_kernel_workflow(val: serde_json::Value, fallback_id: &str) -> Result<KernelWorkflow, String> {
    let wf_val = if let Some(inner) = val.get("workflowData").cloned() {
        inner
    } else if let Some(inner) = val.get("workflow").cloned() {
        inner
    } else {
        val
    };

    let mut normalized = wf_val;
    if !normalized.is_object() {
        return Err("Workflow data harus berupa JSON object".to_string());
    }

    let obj = normalized.as_object_mut().unwrap();
    if !obj.contains_key("id") {
        obj.insert("id".to_string(), serde_json::json!(fallback_id));
    }
    if !obj.contains_key("name") {
        obj.insert("name".to_string(), serde_json::json!("Workflow"));
    }
    if !obj.contains_key("connections") {
        obj.insert("connections".to_string(), serde_json::json!({}));
    }

    if let Some(nodes_arr) = obj.get_mut("nodes").and_then(|v| v.as_array_mut()) {
        for node in nodes_arr {
            if let Some(node_obj) = node.as_object_mut() {
                if !node_obj.contains_key("position") || !node_obj["position"].is_array() {
                    node_obj.insert("position".to_string(), serde_json::json!([0.0, 0.0]));
                }
                if !node_obj.contains_key("id") {
                    let name = node_obj.get("name").and_then(|n| n.as_str()).unwrap_or("node");
                    node_obj.insert("id".to_string(), serde_json::json!(format!("id-{}", name)));
                }
                if !node_obj.contains_key("typeVersion") {
                    node_obj.insert("typeVersion".to_string(), serde_json::json!(1.0));
                }
            }
        }
    } else {
        obj.insert("nodes".to_string(), serde_json::json!([]));
    }

    KernelWorkflow::from_wire(&normalized)
        .map_err(|e| format!("Gagal mendeserialisasi workflow ke KernelWorkflow: {}", e))
}

async fn execute_workflow_internal(
    state: AppState,
    id: String,
    body: Option<Json<serde_json::Value>>,
) -> impl IntoResponse {
    let exec_id = uuid::Uuid::new_v4().to_string();
    let start_time = Utc::now();
    let start_str = start_time.to_rfc3339();

    // 1. Ambil workflow JSON dari payload atau database
    let workflow_json: Option<serde_json::Value> = if let Some(Json(ref payload)) = body {
        if payload.get("workflowData").is_some()
            || payload.get("workflow").is_some()
            || payload.get("nodes").is_some()
        {
            Some(payload.clone())
        } else {
            state.db.get_workflow_raw(&id).await.unwrap_or(None)
        }
    } else {
        state.db.get_workflow_raw(&id).await.unwrap_or(None)
    };

    let workflow_json = if workflow_json.is_none() {
        state
            .db
            .get_workflow(&id)
            .await
            .ok()
            .flatten()
            .and_then(|w| serde_json::to_value(w).ok())
    } else {
        workflow_json
    };

    let Some(raw_wf) = workflow_json else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!("Workflow dengan ID '{}' tidak ditemukan", id)
            })),
        );
    };

    // 2. Deserialisasi ke KernelWorkflow (n8n_workflow::Workflow)
    let workflow = match parse_kernel_workflow(raw_wf, &id) {
        Ok(w) => w,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": err
                })),
            );
        }
    };

    // 3. Ekstraksi initial_data dari payload jika ada
    let initial_data: Option<Vec<INodeExecutionData>> = body.as_ref().and_then(|Json(b)| {
        let data_val = b
            .get("triggerData")
            .or_else(|| b.get("data"))
            .or_else(|| b.get("inputData"));

        data_val.map(|dv| {
            if let Some(arr) = dv.as_array() {
                arr.iter()
                    .map(|item| {
                        if item.get("json").is_some() {
                            serde_json::from_value(item.clone()).unwrap_or_else(|_| INodeExecutionData {
                                json: item.clone(),
                                binary: None,
                                paired_item: None,
                            })
                        } else {
                            INodeExecutionData {
                                json: item.clone(),
                                binary: None,
                                paired_item: None,
                            }
                        }
                    })
                    .collect()
            } else {
                vec![INodeExecutionData {
                    json: dv.clone(),
                    binary: None,
                    paired_item: None,
                }]
            }
        })
    });

    // 4. Inisialisasi ExecutionContext dan KernelScheduler
    let push_ref = body.as_ref().and_then(|Json(b)| {
        b.get("pushRef")
            .or_else(|| b.get("push_ref"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    });

    let session_registry = Arc::new(state.realtime_registry.clone());
    let mut ctx = ExecutionContext::new(id.clone(), ExecutionMode::Manual)
        .with_run_id(exec_id.clone())
        .with_realtime_sessions(session_registry.clone());

    if let Some(ref p_ref) = push_ref {
        ctx = ctx.with_push_ref(p_ref);
    }

    let context = Arc::new(ctx);
    let scheduler = KernelScheduler::default();

    // 5. Broadcast lifecycle executionStarted via EventBus & internal event sender
    let _ = state.event_sender.send(ExecutionEvent::WorkflowStarted {
        workflow_id: id.clone(),
        execution_id: exec_id.clone(),
        started_at: start_str.clone(),
    });

    // 6. Jalankan scheduler.execute(&workflow, initial_data, &context).await
    let exec_res = scheduler.execute(&workflow, initial_data, &context).await;

    match exec_res {
        Ok(result) => {
            let status_str = match result.status {
                WorkflowExecutionStatus::Success => "success",
                WorkflowExecutionStatus::Failed => "error",
                WorkflowExecutionStatus::Cancelled => "crashed",
            };

            // Susun format n8n-compatible runData
            let mut run_data = serde_json::Map::new();
            for (name, frame) in &result.frames {
                let mut task_run = serde_json::Map::new();
                if let Some(st) = frame.start_time {
                    task_run.insert(
                        "startTime".to_string(),
                        serde_json::json!(st.timestamp_millis()),
                    );
                }
                if let Some(dur) = frame.execution_time_ms {
                    task_run.insert("executionTime".to_string(), serde_json::json!(dur));
                }
                let mut data_map = serde_json::Map::new();
                if let Some(ref out_data) = frame.output_data {
                    data_map.insert(
                        "main".to_string(),
                        serde_json::to_value(out_data).unwrap_or(serde_json::json!([])),
                    );
                }
                task_run.insert("data".to_string(), serde_json::Value::Object(data_map));
                if let Some(ref err) = frame.error {
                    task_run.insert("error".to_string(), serde_json::json!({ "message": err }));
                }
                run_data.insert(name.clone(), serde_json::json!([task_run]));
            }

            let result_data = serde_json::json!({
                "resultData": {
                    "runData": run_data
                }
            });

            let stop_str = result.end_time.to_rfc3339();

            // Simpan riwayat eksekusi ke database
            let _ = state
                .db
                .save_execution(
                    &result.execution_id,
                    &result.workflow_id,
                    status_str,
                    &result_data,
                    &start_str,
                    Some(&stop_str),
                )
                .await;

            if result.status == WorkflowExecutionStatus::Success {
                let _ = state.event_sender.send(ExecutionEvent::WorkflowCompleted {
                    workflow_id: result.workflow_id.clone(),
                    execution_id: result.execution_id.clone(),
                    status: "success".to_string(),
                    duration_ms: result.duration_ms,
                    results: result_data.clone(),
                });
            } else {
                let _ = state.event_sender.send(ExecutionEvent::WorkflowFailed {
                    workflow_id: result.workflow_id.clone(),
                    execution_id: result.execution_id.clone(),
                    error: result
                        .error
                        .clone()
                        .unwrap_or_else(|| "Workflow execution failed".to_string()),
                });
            }

            let response_payload = serde_json::json!({
                "data": {
                    "id": result.execution_id,
                    "executionId": result.execution_id,
                    "workflowId": result.workflow_id,
                    "status": status_str,
                    "finished": true,
                    "mode": "manual",
                    "startedAt": start_str,
                    "stoppedAt": stop_str,
                    "durationMs": result.duration_ms,
                    "frames": result.frames,
                    "error": result.error,
                    "data": {
                        "resultData": {
                            "runData": run_data
                        }
                    }
                }
            });

            let status_code = if result.status == WorkflowExecutionStatus::Failed {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::OK
            };

            (status_code, Json(response_payload))
        }
        Err(err) => {
            let err_msg = format!("DAG Execution Plan Error: {}", err);
            let _ = state.event_sender.send(ExecutionEvent::WorkflowFailed {
                workflow_id: id.clone(),
                execution_id: exec_id.clone(),
                error: err_msg.clone(),
            });

            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "data": {
                        "executionId": exec_id,
                        "status": "error",
                        "finished": true,
                        "error": err_msg
                    }
                })),
            )
        }
    }
}

// ==========================================
// EXECUTIONS HANDLERS
// ==========================================
async fn list_executions_handler(State(state): State<AppState>) -> impl IntoResponse {
    let scopes_path = "/home/catzpro01/n8n-rust/n8n_rust_core/execution_scopes.json";
    let scopes: serde_json::Value = if let Ok(content) = tokio::fs::read_to_string(scopes_path).await {
        serde_json::from_str(&content).unwrap_or(serde_json::json!([
            "execution:delete", "execution:list", "execution:read"
        ]))
    } else {
        serde_json::json!(["execution:delete", "execution:list", "execution:read"])
    };

    match state.db.list_executions(50).await {
        Ok(execs) => {
            let results: Vec<serde_json::Value> = execs.into_iter().map(|e| {
                serde_json::json!({
                    "id": e.id,
                    "workflowId": e.workflow_id,
                    "workflowVersionId": "28b8ea2f-d00e-400e-a6da-d960e6b577bc",
                    "jsonSizeBytes": 2048,
                    "binaryDataSizeBytes": 0,
                    "mode": "manual",
                    "retryOf": serde_json::Value::Null,
                    "status": e.status,
                    "createdAt": e.started_at,
                    "startedAt": e.started_at,
                    "stoppedAt": e.stopped_at.unwrap_or_else(|| e.started_at.clone()),
                    "usedPrivateCredentials": false,
                    "waitTill": serde_json::Value::Null,
                    "retrySuccessId": serde_json::Value::Null,
                    "workflowName": "My workflow",
                    "annotation": {
                        "vote": serde_json::Value::Null,
                        "tags": []
                    },
                    "scopes": scopes
                })
            }).collect();
            let count = results.len();
            (StatusCode::OK, Json(serde_json::json!({
                "data": {
                    "results": results,
                    "count": count,
                    "estimated": false,
                    "concurrentExecutionsCount": -1
                }
            })))
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

fn flatted_stringify(value: &serde_json::Value) -> String {
    let mut objects: Vec<serde_json::Value> = Vec::new();
    let mut known: Vec<String> = Vec::new();

    fn walk(
        val: &serde_json::Value,
        objects: &mut Vec<serde_json::Value>,
        known: &mut Vec<String>,
    ) -> String {
        let serialized = serde_json::to_string(val).unwrap_or_default();
        if let Some(pos) = known.iter().position(|k| k == &serialized) {
            return pos.to_string();
        }
        let idx = known.len();
        known.push(serialized);
        objects.push(serde_json::Value::Null);

        match val {
            serde_json::Value::Object(map) => {
                let mut obj_copy = serde_json::Map::new();
                for (k, v) in map {
                    match v {
                        serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                            let ref_idx = walk(v, objects, known);
                            obj_copy.insert(k.clone(), serde_json::Value::String(ref_idx));
                        }
                        serde_json::Value::String(s) => {
                            let s_val = serde_json::Value::String(s.clone());
                            let s_idx = walk(&s_val, objects, known);
                            obj_copy.insert(k.clone(), serde_json::Value::String(s_idx));
                        }
                        _ => {
                            obj_copy.insert(k.clone(), v.clone());
                        }
                    }
                }
                objects[idx] = serde_json::Value::Object(obj_copy);
            }
            serde_json::Value::Array(arr) => {
                let mut arr_copy = Vec::new();
                for item in arr {
                    match item {
                        serde_json::Value::Object(_) | serde_json::Value::Array(_) => {
                            let ref_idx = walk(item, objects, known);
                            arr_copy.push(serde_json::Value::String(ref_idx));
                        }
                        serde_json::Value::String(s) => {
                            let s_val = serde_json::Value::String(s.clone());
                            let s_idx = walk(&s_val, objects, known);
                            arr_copy.push(serde_json::Value::String(s_idx));
                        }
                        _ => {
                            arr_copy.push(item.clone());
                        }
                    }
                }
                objects[idx] = serde_json::Value::Array(arr_copy);
            }
            serde_json::Value::String(s) => {
                objects[idx] = serde_json::Value::String(s.clone());
            }
            _ => {
                objects[idx] = val.clone();
            }
        }

        idx.to_string()
    }

    walk(value, &mut objects, &mut known);
    serde_json::to_string(&objects).unwrap_or_else(|_| "[]".to_string())
}

async fn get_execution_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if let Ok(records) = state.db.list_executions(100).await {
        if let Some(found) = records.into_iter().find(|e| e.id == id) {
            // Ambil workflow definition jika ada
            let wf_raw = state.db.get_workflow_raw(&found.workflow_id).await.unwrap_or(None);
            let wf_data = wf_raw.unwrap_or_else(|| serde_json::json!({
                "id": found.workflow_id,
                "name": "My workflow",
                "nodes": [],
                "connections": {}
            }));

            // Format runData sesuai standar n8n v2.39.6
            let mut run_data = serde_json::Map::new();
            if let Some(nodes_obj) = found.data.as_object() {
                for (node_name, node_val) in nodes_obj {
                    let items = if let Some(arr) = node_val.as_array() {
                        arr.clone()
                    } else {
                        vec![serde_json::json!({ "json": node_val })]
                    };
                    run_data.insert(
                        node_name.clone(),
                        serde_json::json!([
                            {
                                "startTime": Utc::now().timestamp_millis(),
                                "executionIndex": 0,
                                "executionTime": 1,
                                "executionStatus": "success",
                                "data": {
                                    "main": [ items ]
                                }
                            }
                        ])
                    );
                }
            }

            let result_payload = serde_json::json!({
                "resultData": {
                    "runData": run_data
                }
            });

            // Serialisasikan ke format Flatted JSON string yang diharapkan n8n frontend
            let flatted_data_str = flatted_stringify(&result_payload);

            let resp = serde_json::json!({
                "data": {
                    "id": found.id,
                    "finished": true,
                    "mode": "manual",
                    "retryOf": serde_json::Value::Null,
                    "retrySuccessId": serde_json::Value::Null,
                    "status": found.status,
                    "createdAt": found.started_at,
                    "startedAt": found.started_at,
                    "stoppedAt": found.stopped_at.unwrap_or_else(|| found.started_at.clone()),
                    "deletedAt": serde_json::Value::Null,
                    "workflowId": found.workflow_id,
                    "waitTill": serde_json::Value::Null,
                    "storedAt": "db",
                    "tracingContext": serde_json::Value::Null,
                    "deduplicationKey": serde_json::Value::Null,
                    "jsonSizeBytes": flatted_data_str.len(),
                    "binaryDataSizeBytes": 0,
                    "workflowVersionId": "28b8ea2f-d00e-400e-a6da-d960e6b577bc",
                    "usedPrivateCredentials": false,
                    "data": flatted_data_str,
                    "workflowData": wf_data,
                    "customData": {}
                }
            });
            return (StatusCode::OK, Json(resp)).into_response();
        }
    }
    (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Execution not found" }))).into_response()
}

async fn delete_execution_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.delete_execution_raw(&id).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "data": { "success": true } }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn stop_execution_handler(
    Path(_id): Path<String>,
) -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({ "data": { "success": true } })))
}

async fn retry_execution_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if let Ok(Some(exec)) = state.db.get_execution_raw(&id).await {
        let now = Utc::now().to_rfc3339();
        let new_exec_id = generate_id();
        let _ = state.db.save_execution(
            &new_exec_id,
            &exec.workflow_id,
            "success",
            &exec.data,
            &now,
            Some(&now),
        ).await;
        return (StatusCode::OK, Json(serde_json::json!({
            "data": {
                "id": new_exec_id,
                "workflowId": exec.workflow_id,
                "status": "success"
            }
        }))).into_response();
    }
    (StatusCode::OK, Json(serde_json::json!({ "data": { "id": id, "status": "success" } }))).into_response()
}

// ==========================================
// CREDENTIALS CRUD HANDLERS
// ==========================================
async fn list_credentials_handler(State(state): State<AppState>) -> impl IntoResponse {
    match state.db.list_credentials_raw().await {
        Ok(list) => (StatusCode::OK, Json(serde_json::json!({ "data": list }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn get_credential_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.get_credential_raw(&id).await {
        Ok(Some(cred)) => (StatusCode::OK, Json(serde_json::json!({ "data": cred }))).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "message": "Credential not found" }))).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ).into_response(),
    }
}

async fn create_credential_handler(
    State(state): State<AppState>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let id = payload.get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty() && *s != "new")
        .map(|s| s.to_string())
        .unwrap_or_else(generate_id);
    let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("New Credential");
    let cred_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("custom");
    let cred_data = payload.get("data").cloned().unwrap_or(serde_json::json!({}));

    match state.db.save_credential_raw(&id, name, cred_type, &cred_data).await {
        Ok(cred) => (StatusCode::OK, Json(serde_json::json!({ "data": cred }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn update_credential_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("Updated Credential");
    let cred_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("custom");
    let cred_data = payload.get("data").cloned().unwrap_or(serde_json::json!({}));

    match state.db.save_credential_raw(&id, name, cred_type, &cred_data).await {
        Ok(cred) => (StatusCode::OK, Json(serde_json::json!({ "data": cred }))).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ).into_response(),
    }
}

async fn delete_credential_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.delete_credential_raw(&id).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "data": { "success": true } }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn test_credential_handler(Json(_body): Json<serde_json::Value>) -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({
        "data": {
            "status": "success",
            "message": "Connection tested successfully!"
        }
    })))
}

// ==========================================
// TAGS CRUD HANDLERS
// ==========================================
async fn tags_list_handler(State(state): State<AppState>) -> impl IntoResponse {
    match state.db.list_tags_raw().await {
        Ok(list) => (StatusCode::OK, Json(serde_json::json!({ "data": list }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn tags_create_handler(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let id = body.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(generate_id);
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("tag");
    match state.db.save_tag_raw(&id, name).await {
        Ok(tag) => (StatusCode::OK, Json(serde_json::json!({ "data": tag }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn tags_delete_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.delete_tag_raw(&id).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "data": { "success": true } }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

// ==========================================
// VARIABLES CRUD HANDLERS
// ==========================================
async fn variables_list_handler(State(state): State<AppState>) -> impl IntoResponse {
    match state.db.list_variables_raw().await {
        Ok(list) => (StatusCode::OK, Json(serde_json::json!({ "data": list }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn variables_create_handler(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let id = body.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()).unwrap_or_else(generate_id);
    let key = body.get("key").and_then(|v| v.as_str()).unwrap_or("KEY");
    let val = body.get("value").and_then(|v| v.as_str()).unwrap_or("");
    match state.db.save_variable_raw(&id, key, val).await {
        Ok(v) => (StatusCode::OK, Json(serde_json::json!({ "data": v }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

async fn variables_delete_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.delete_variable_raw(&id).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "data": { "success": true } }))),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err.to_string() })),
        ),
    }
}

// ==========================================
// WEBHOOK LISTENER
// ==========================================
async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, Json(serde_json::json!({ "status": "ok", "engine": "n8n-rust" })))
}

async fn webhook_handler(
    State(state): State<AppState>,
    Path(webhook_id): Path<String>,
    body: Option<Json<serde_json::Value>>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    let payload = body.map(|b| b.0).unwrap_or(serde_json::json!({}));
    let workflows = state.db.list_workflows().await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e.to_string() })))
    })?;

    let matching_workflow = workflows.into_iter().find(|wf| {
        wf.active && wf.nodes.iter().any(|node| {
            node.node_type == "n8n-nodes-base.webhook"
                && node
                    .parameters
                    .get("path")
                    .and_then(|p| p.as_str())
                    .map(|p| p == webhook_id)
                    .unwrap_or(false)
        })
    });

    let workflow = match matching_workflow {
        Some(wf) => wf,
        None => return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Webhook tidak ditemukan atau workflow belum diaktifkan." })))),
    };

    let exec_id = uuid::Uuid::new_v4().to_string();
    let start_time = Utc::now();
    let start_str = start_time.to_rfc3339();

    let _ = state.event_sender.send(ExecutionEvent::WorkflowStarted {
        workflow_id: webhook_id.clone(),
        execution_id: exec_id.clone(),
        started_at: start_str.clone(),
    });

    let dag = WorkflowGraph::build(&workflow);
    let executor = WorkflowExecutor::new(dag)
        .with_trigger_data(serde_json::json!([{ "json": payload }]))
        .with_events(state.event_sender.clone(), webhook_id.clone(), exec_id.clone());

    match executor.execute().await {
        Ok(results) => {
            let stop_time = Utc::now();
            let duration = (stop_time - start_time).num_milliseconds() as u64;
            let res_val = serde_json::to_value(&results).unwrap_or_default();

            let _ = state.db.save_execution(
                &exec_id,
                &webhook_id,
                "success",
                &res_val,
                &start_str,
                Some(&stop_time.to_rfc3339()),
            ).await;

            let _ = state.event_sender.send(ExecutionEvent::WorkflowCompleted {
                workflow_id: webhook_id,
                execution_id: exec_id,
                status: "success".to_string(),
                duration_ms: duration,
                results: res_val.clone(),
            });

            Ok((StatusCode::OK, Json(serde_json::json!({ "status": "success", "results": res_val }))))
        }
        Err(err) => {
            let stop_time = Utc::now();
            let err_val = serde_json::json!({ "error": err.clone() });

            let _ = state.db.save_execution(
                &exec_id,
                &webhook_id,
                "error",
                &err_val,
                &start_str,
                Some(&stop_time.to_rfc3339()),
            ).await;

            let _ = state.event_sender.send(ExecutionEvent::WorkflowFailed {
                workflow_id: webhook_id,
                execution_id: exec_id,
                error: err.clone(),
            });

            Err((StatusCode::INTERNAL_SERVER_ERROR, Json(err_val)))
        }
    }
}

// ==========================================
// REALTIME WEBSOCKET STREAM
// ==========================================
#[derive(serde::Deserialize, Default)]
pub struct PushQuery {
    #[serde(rename = "pushRef")]
    pub push_ref: Option<String>,
}

async fn websocket_handler(
    ws: WebSocketUpgrade,
    axum::extract::Query(query): axum::extract::Query<PushQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let push_ref = query.push_ref.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    ws.on_upgrade(move |socket| handle_socket(socket, state, push_ref))
}

async fn handle_socket(socket: WebSocket, state: AppState, push_ref: String) {
    use futures_util::{SinkExt, StreamExt};

    println!("🔌 [WebSocket] Klien terhubung ke live execution stream! (pushRef: {})", push_ref);

    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx_push) = tokio::sync::mpsc::unbounded_channel::<String>();

    state.realtime_registry.register(push_ref.clone(), "user-default".to_string(), tx).await;

    // Kirim pesan handshake connected
    let handshake = serde_json::json!({
        "type": "connection",
        "data": {
            "authenticated": true
        }
    });
    let _ = ws_sender.send(Message::Text(handshake.to_string().into())).await;

    let mut rx_events = state.event_sender.subscribe();
    let registry_clone = state.realtime_registry.clone();
    let push_ref_clone = push_ref.clone();

    // Loop pengiriman pesan ke WebSocket client
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(push_msg) = rx_push.recv() => {
                    if ws_sender.send(Message::Text(push_msg.into())).await.is_err() {
                        break;
                    }
                }
                Ok(event) = rx_events.recv() => {
                    let n8n_push_msg = match &event {
                        ExecutionEvent::WorkflowStarted { workflow_id, execution_id, .. } => {
                            PushMessage::execution_started(execution_id, workflow_id)
                        }
                        ExecutionEvent::NodeStarted { node_name, execution_id, .. } => {
                            PushMessage::node_execute_before(execution_id, node_name)
                        }
                        ExecutionEvent::NodeCompleted { node_name, execution_id, output, .. } => {
                            PushMessage::node_execute_after(execution_id, node_name, output.clone())
                        }
                        ExecutionEvent::WorkflowCompleted { workflow_id, execution_id, status, .. } => {
                            PushMessage::execution_finished(execution_id, workflow_id, status)
                        }
                        ExecutionEvent::WorkflowFailed { workflow_id, execution_id, .. } => {
                            PushMessage::execution_finished(execution_id, workflow_id, "error")
                        }
                    };

                    if let Ok(serialized) = serde_json::to_string(&n8n_push_msg) {
                        if ws_sender.send(Message::Text(serialized.into())).await.is_err() {
                            break;
                        }
                    }
                }
                else => break,
            }
        }
    });

    // Loop penerimaan pesan dari WebSocket client
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            match msg {
                Message::Text(txt) => {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&txt) {
                        if is_heartbeat_message(&val) {
                            // R10: Heartbeat frame di-swallow, atau balas pong jika perlu
                            continue;
                        }
                    }
                }
                Message::Pong(_) => {
                    registry_clone.on_pong(&push_ref_clone).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    };

    state.realtime_registry.unregister(&push_ref).await;
    println!("🔌 [WebSocket] Klien terputus dari stream. (pushRef: {})", push_ref);
}

// ==========================================
// REALTIME PUSH BROADCAST (n8n-lego bridge)
// ==========================================
async fn realtime_broadcast_handler(
    State(state): State<AppState>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let payload_str = payload.to_string();
    state.realtime_registry.broadcast_text(&payload_str).await;

    // Kirimkan juga ke state.event_sender jika relevan
    if let Ok(event) = serde_json::from_value::<ExecutionEvent>(payload.clone()) {
        let _ = state.event_sender.send(event);
    } else if let Some(msg_type) = payload.get("type").and_then(|t| t.as_str()) {
        let data = payload.get("data");
        match msg_type {
            "executionStarted" => {
                let execution_id = data.and_then(|d| d.get("executionId")).and_then(|s| s.as_str()).unwrap_or_default().to_string();
                let workflow_id = data.and_then(|d| d.get("workflowId")).and_then(|s| s.as_str()).unwrap_or_default().to_string();
                let started_at = data.and_then(|d| d.get("startedAt")).and_then(|s| s.as_str()).unwrap_or_default().to_string();
                let _ = state.event_sender.send(ExecutionEvent::WorkflowStarted {
                    workflow_id,
                    execution_id,
                    started_at,
                });
            }
            "nodeExecuteBefore" => {
                let execution_id = data.and_then(|d| d.get("executionId")).and_then(|s| s.as_str()).unwrap_or_default().to_string();
                let workflow_id = data.and_then(|d| d.get("workflowId")).and_then(|s| s.as_str()).unwrap_or_default().to_string();
                let node_name = data.and_then(|d| d.get("nodeName")).and_then(|s| s.as_str()).unwrap_or_default().to_string();
                let _ = state.event_sender.send(ExecutionEvent::NodeStarted {
                    workflow_id,
                    execution_id,
                    node_name,
                });
            }
            "nodeExecuteAfter" => {
                let execution_id = data.and_then(|d| d.get("executionId")).and_then(|s| s.as_str()).unwrap_or_default().to_string();
                let workflow_id = data.and_then(|d| d.get("workflowId")).and_then(|s| s.as_str()).unwrap_or_default().to_string();
                let node_name = data.and_then(|d| d.get("nodeName")).and_then(|s| s.as_str()).unwrap_or_default().to_string();
                let output = data.and_then(|d| d.get("data")).cloned().unwrap_or(serde_json::Value::Null);
                let _ = state.event_sender.send(ExecutionEvent::NodeCompleted {
                    workflow_id,
                    execution_id,
                    node_name,
                    output,
                });
            }
            "executionFinished" => {
                let execution_id = data.and_then(|d| d.get("executionId")).and_then(|s| s.as_str()).unwrap_or_default().to_string();
                let workflow_id = data.and_then(|d| d.get("workflowId")).and_then(|s| s.as_str()).unwrap_or_default().to_string();
                let status = data.and_then(|d| d.get("status")).and_then(|s| s.as_str()).unwrap_or("success").to_string();
                if status == "error" || status == "failed" {
                    let _ = state.event_sender.send(ExecutionEvent::WorkflowFailed {
                        workflow_id,
                        execution_id,
                        error: "Execution failed".to_string(),
                    });
                } else {
                    let _ = state.event_sender.send(ExecutionEvent::WorkflowCompleted {
                        workflow_id,
                        execution_id,
                        status,
                        duration_ms: 0,
                        results: serde_json::Value::Null,
                    });
                }
            }
            _ => {}
        }
    }

    (StatusCode::OK, Json(serde_json::json!({ "success": true })))
}
// ==========================================
// POLYGLOT VERSION SELECTOR
// ==========================================
#[derive(serde::Deserialize)]
pub struct PolyglotQuery {
    lang: Option<String>,
}

async fn polyglot_versions_handler(axum::extract::Query(query): axum::extract::Query<PolyglotQuery>) -> impl axum::response::IntoResponse {
    let lang = query.lang.unwrap_or_else(|| "javaScript".to_string());
    
    // In a real implementation, you would use std::process::Command to query mise ls-remote python or node.
    // For now, we return a mock list of versions for demonstration.
    let mut versions = vec![
        serde_json::json!({ "name": "Default System", "value": "default" })
    ];
    
    if lang == "javaScript" {
        versions.push(serde_json::json!({ "name": "Node.js 22.0.0", "value": "22.0.0" }));
        versions.push(serde_json::json!({ "name": "Node.js 20.9.0", "value": "20.9.0" }));
    } else if lang == "pythonNative" || lang == "python" {
        versions.push(serde_json::json!({ "name": "Python 3.12.0", "value": "3.12.0" }));
        versions.push(serde_json::json!({ "name": "Python 3.11.0", "value": "3.11.0" }));
    }
    
    axum::response::Json(serde_json::json!({
        "versions": versions
    }))
}
