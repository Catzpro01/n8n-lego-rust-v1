use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};
use std::str::FromStr;

use crate::workflow::Workflow;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionRecord {
    pub id: String,
    pub workflow_id: String,
    pub status: String,
    pub data: serde_json::Value,
    pub started_at: String,
    pub stopped_at: Option<String>,
}

#[derive(Clone)]
pub struct Database {
    pub pool: Pool<Sqlite>,
}

impl Database {
    pub async fn init(database_url: &str) -> Result<Self, sqlx::Error> {
        let connection_options = SqliteConnectOptions::from_str(database_url)?
            .create_if_missing(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(10)
            .connect_with(connection_options)
            .await?;

        // Initialize SQLite Tables
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS workflows (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS executions (
                id TEXT PRIMARY KEY,
                workflow_id TEXT NOT NULL,
                status TEXT NOT NULL,
                data TEXT NOT NULL,
                started_at TEXT NOT NULL,
                stopped_at TEXT
            );

            CREATE TABLE IF NOT EXISTS credentials (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS variables (
                id TEXT PRIMARY KEY,
                key TEXT NOT NULL UNIQUE,
                value TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            "#,
        )
        .execute(&pool)
        .await?;

        println!("📦 Database SQLite terhubung dan tabel berhasil diinisialisasi.");
        Ok(Self { pool })
    }

    pub async fn save_workflow(&self, workflow: &Workflow) -> Result<(), sqlx::Error> {
        let mut wf = workflow.clone();
        let id = wf.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        wf.id = Some(id.clone());
        
        let now = Utc::now().to_rfc3339();
        if wf.created_at.is_none() {
            wf.created_at = Some(now.clone());
        }
        wf.updated_at = Some(now.clone());

        let json_data = serde_json::to_string(&wf).unwrap_or_default();
        let active_int = if wf.active { 1 } else { 0 };

        sqlx::query(
            r#"
            INSERT INTO workflows (id, name, active, data, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                active = excluded.active,
                data = excluded.data,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(id)
        .bind(&workflow.name)
        .bind(active_int)
        .bind(json_data)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn save_workflow_raw(
        &self,
        id: &str,
        name: &str,
        active: bool,
        data: &serde_json::Value,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        let json_data = serde_json::to_string(data).unwrap_or_default();
        let active_int = if active { 1 } else { 0 };

        sqlx::query(
            r#"
            INSERT INTO workflows (id, name, active, data, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                active = excluded.active,
                data = excluded.data,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(id)
        .bind(name)
        .bind(active_int)
        .bind(json_data)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn get_workflow(&self, id: &str) -> Result<Option<Workflow>, sqlx::Error> {
        let row = sqlx::query_as::<_, (String,)>(
            "SELECT data FROM workflows WHERE id = ?1 LIMIT 1"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        if let Some((data,)) = row {
            if let Ok(wf) = serde_json::from_str::<Workflow>(&data) {
                return Ok(Some(wf));
            }
        }
        Ok(None)
    }

    pub async fn get_workflow_raw(&self, id: &str) -> Result<Option<serde_json::Value>, sqlx::Error> {
        let row = sqlx::query_as::<_, (String,)>(
            "SELECT data FROM workflows WHERE id = ?1 LIMIT 1"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        if let Some((data,)) = row {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
                return Ok(Some(val));
            }
        }
        Ok(None)
    }

    pub async fn list_workflows(&self) -> Result<Vec<Workflow>, sqlx::Error> {
        let rows = sqlx::query_as::<_, (String,)>(
            "SELECT data FROM workflows ORDER BY updated_at DESC"
        )
        .fetch_all(&self.pool)
        .await?;

        let mut workflows = Vec::new();
        for (data,) in rows {
            if let Ok(wf) = serde_json::from_str::<Workflow>(&data) {
                workflows.push(wf);
            }
        }
        Ok(workflows)
    }

    pub async fn list_workflows_raw(&self) -> Result<Vec<serde_json::Value>, sqlx::Error> {
        let rows = sqlx::query_as::<_, (String,)>(
            "SELECT data FROM workflows ORDER BY updated_at DESC"
        )
        .fetch_all(&self.pool)
        .await?;

        let mut workflows = Vec::new();
        for (data,) in rows {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
                workflows.push(val);
            }
        }
        Ok(workflows)
    }

    pub async fn delete_workflow_raw(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM workflows WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn save_execution(
        &self,
        id: &str,
        workflow_id: &str,
        status: &str,
        data: &serde_json::Value,
        started_at: &str,
        stopped_at: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let data_str = serde_json::to_string(data).unwrap_or_default();

        sqlx::query(
            r#"
            INSERT INTO executions (id, workflow_id, status, data, started_at, stopped_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                data = excluded.data,
                stopped_at = excluded.stopped_at
            "#,
        )
        .bind(id)
        .bind(workflow_id)
        .bind(status)
        .bind(data_str)
        .bind(started_at)
        .bind(stopped_at)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    pub async fn list_executions(&self, limit: i64) -> Result<Vec<ExecutionRecord>, sqlx::Error> {
        let rows = sqlx::query_as::<_, (String, String, String, String, String, Option<String>)>(
            "SELECT id, workflow_id, status, data, started_at, stopped_at FROM executions ORDER BY started_at DESC LIMIT ?1"
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let records = rows
            .into_iter()
            .map(|(id, workflow_id, status, data_str, started_at, stopped_at)| {
                let data = serde_json::from_str(&data_str).unwrap_or(serde_json::json!({}));
                ExecutionRecord {
                    id,
                    workflow_id,
                    status,
                    data,
                    started_at,
                    stopped_at,
                }
            })
            .collect();

        Ok(records)
    }

    pub async fn get_execution_raw(&self, id: &str) -> Result<Option<ExecutionRecord>, sqlx::Error> {
        let row = sqlx::query_as::<_, (String, String, String, String, String, Option<String>)>(
            "SELECT id, workflow_id, status, data, started_at, stopped_at FROM executions WHERE id = ?1 LIMIT 1"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        if let Some((id, workflow_id, status, data_str, started_at, stopped_at)) = row {
            let data = serde_json::from_str(&data_str).unwrap_or(serde_json::json!({}));
            return Ok(Some(ExecutionRecord {
                id,
                workflow_id,
                status,
                data,
                started_at,
                stopped_at,
            }));
        }
        Ok(None)
    }

    pub async fn delete_execution_raw(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM executions WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ==========================================
    // CREDENTIALS DATABASE OPERATIONS
    // ==========================================
    pub async fn save_credential_raw(
        &self,
        id: &str,
        name: &str,
        cred_type: &str,
        data: &serde_json::Value,
    ) -> Result<serde_json::Value, sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        let data_str = serde_json::to_string(data).unwrap_or_default();
        sqlx::query(
            r#"
            INSERT INTO credentials (id, name, type, data, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                type = excluded.type,
                data = excluded.data,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(id)
        .bind(name)
        .bind(cred_type)
        .bind(data_str)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        Ok(serde_json::json!({
            "id": id,
            "name": name,
            "type": cred_type,
            "data": data,
            "createdAt": now,
            "updatedAt": now,
            "isManaged": false,
            "isGlobal": false,
            "isResolvable": false,
            "resolverId": null,
            "usageScope": "project",
            "homeProject": {
                "id": "6BERd9J8smAOytt0",
                "type": "personal",
                "name": "Admin N8N <admin@example.com>",
                "icon": null
            },
            "sharedWithProjects": [],
            "scopes": [
                "credential:connect", "credential:create", "credential:createEndUser",
                "credential:delete", "credential:list", "credential:manageInstance",
                "credential:move", "credential:read", "credential:share",
                "credential:shareGlobally", "credential:unshare", "credential:update"
            ]
        }))
    }

    pub async fn get_credential_raw(&self, id: &str) -> Result<Option<serde_json::Value>, sqlx::Error> {
        let row = sqlx::query_as::<_, (String, String, String, String, String, String)>(
            "SELECT id, name, type, data, created_at, updated_at FROM credentials WHERE id = ?1 LIMIT 1"
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        if let Some((id, name, cred_type, data_str, created_at, updated_at)) = row {
            let data_val = serde_json::from_str::<serde_json::Value>(&data_str).unwrap_or(serde_json::json!({}));
            return Ok(Some(serde_json::json!({
                "id": id,
                "name": name,
                "type": cred_type,
                "data": data_val,
                "createdAt": created_at,
                "updatedAt": updated_at,
                "isManaged": false,
                "isGlobal": false,
                "isResolvable": false,
                "resolverId": null,
                "usageScope": "project",
                "homeProject": {
                    "id": "6BERd9J8smAOytt0",
                    "type": "personal",
                    "name": "Admin N8N <admin@example.com>",
                    "icon": null
                },
                "sharedWithProjects": [],
                "scopes": [
                    "credential:connect", "credential:create", "credential:createEndUser",
                    "credential:delete", "credential:list", "credential:manageInstance",
                    "credential:move", "credential:read", "credential:share",
                    "credential:shareGlobally", "credential:unshare", "credential:update"
                ]
            })));
        }
        Ok(None)
    }

    pub async fn list_credentials_raw(&self) -> Result<Vec<serde_json::Value>, sqlx::Error> {
        let rows = sqlx::query_as::<_, (String, String, String, String, String)>(
            "SELECT id, name, type, created_at, updated_at FROM credentials ORDER BY updated_at DESC"
        )
        .fetch_all(&self.pool)
        .await?;

        let mut list = Vec::new();
        for (id, name, cred_type, created_at, updated_at) in rows {
            list.push(serde_json::json!({
                "id": id,
                "name": name,
                "type": cred_type,
                "createdAt": created_at,
                "updatedAt": updated_at,
                "isManaged": false,
                "isGlobal": false,
                "isResolvable": false,
                "resolverId": null,
                "homeProject": {
                    "id": "6BERd9J8smAOytt0",
                    "type": "personal",
                    "name": "Admin N8N <admin@example.com>",
                    "icon": null
                },
                "sharedWithProjects": [],
                "scopes": [
                    "credential:connect", "credential:create", "credential:createEndUser",
                    "credential:delete", "credential:list", "credential:manageInstance",
                    "credential:move", "credential:read", "credential:share",
                    "credential:shareGlobally", "credential:unshare", "credential:update"
                ]
            }));
        }
        Ok(list)
    }

    pub async fn delete_credential_raw(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM credentials WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ==========================================
    // TAGS DATABASE OPERATIONS
    // ==========================================
    pub async fn save_tag_raw(&self, id: &str, name: &str) -> Result<serde_json::Value, sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO tags (id, name, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(id)
        .bind(name)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        Ok(serde_json::json!({
            "id": id,
            "name": name,
            "createdAt": now,
            "updatedAt": now
        }))
    }

    pub async fn list_tags_raw(&self) -> Result<Vec<serde_json::Value>, sqlx::Error> {
        let rows = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT id, name, created_at, updated_at FROM tags ORDER BY name ASC"
        )
        .fetch_all(&self.pool)
        .await?;

        let mut list = Vec::new();
        for (id, name, created_at, updated_at) in rows {
            list.push(serde_json::json!({
                "id": id,
                "name": name,
                "createdAt": created_at,
                "updatedAt": updated_at
            }));
        }
        Ok(list)
    }

    pub async fn delete_tag_raw(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM tags WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ==========================================
    // VARIABLES DATABASE OPERATIONS
    // ==========================================
    pub async fn save_variable_raw(&self, id: &str, key: &str, value: &str) -> Result<serde_json::Value, sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            r#"
            INSERT INTO variables (id, key, value, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(id) DO UPDATE SET
                key = excluded.key,
                value = excluded.value,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(id)
        .bind(key)
        .bind(value)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        Ok(serde_json::json!({
            "id": id,
            "key": key,
            "value": value,
            "createdAt": now,
            "updatedAt": now
        }))
    }

    pub async fn list_variables_raw(&self) -> Result<Vec<serde_json::Value>, sqlx::Error> {
        let rows = sqlx::query_as::<_, (String, String, String, String, String)>(
            "SELECT id, key, value, created_at, updated_at FROM variables ORDER BY key ASC"
        )
        .fetch_all(&self.pool)
        .await?;

        let mut list = Vec::new();
        for (id, key, value, created_at, updated_at) in rows {
            list.push(serde_json::json!({
                "id": id,
                "key": key,
                "value": value,
                "createdAt": created_at,
                "updatedAt": updated_at
            }));
        }
        Ok(list)
    }

    pub async fn delete_variable_raw(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM variables WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
