use std::future::Future;
use std::pin::Pin;
use serde_json::{json, Map, Number, Value};
use sqlx::{AssertSqlSafe, Column, Row, SqlitePool};
use sqlx::sqlite::SqlitePoolOptions;
use crate::nodes::traits::{INodeExecutionData, NodeExecutionContext, NodeExecutionError, N8nNode};

pub struct SqliteNode;

impl SqliteNode {
    pub fn new() -> Self {
        Self
    }

    pub fn sqlite_row_to_json(row: &sqlx::sqlite::SqliteRow) -> Value {
        let mut map = Map::new();
        for col in row.columns() {
            let name = col.name();
            if let Ok(v) = row.try_get::<String, _>(name) {
                if (v.starts_with('{') && v.ends_with('}')) || (v.starts_with('[') && v.ends_with(']')) {
                    if let Ok(json_val) = serde_json::from_str::<Value>(&v) {
                        map.insert(name.to_string(), json_val);
                        continue;
                    }
                }
                map.insert(name.to_string(), Value::String(v));
            } else if let Ok(v) = row.try_get::<i64, _>(name) {
                map.insert(name.to_string(), Value::Number(Number::from(v)));
            } else if let Ok(v) = row.try_get::<f64, _>(name) {
                if let Some(n) = Number::from_f64(v) {
                    map.insert(name.to_string(), Value::Number(n));
                } else {
                    map.insert(name.to_string(), Value::Null);
                }
            } else if let Ok(v) = row.try_get::<bool, _>(name) {
                map.insert(name.to_string(), Value::Bool(v));
            } else {
                map.insert(name.to_string(), Value::Null);
            }
        }
        Value::Object(map)
    }

    async fn get_pool(db_file: &str) -> Result<SqlitePool, NodeExecutionError> {
        let url = if db_file == ":memory:" {
            "sqlite::memory:".to_string()
        } else if db_file.starts_with("sqlite:") {
            if db_file.contains('?') {
                db_file.to_string()
            } else {
                format!("{}?mode=rwc", db_file)
            }
        } else {
            format!("sqlite://{}?mode=rwc", db_file)
        };

        SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .map_err(|e| NodeExecutionError::ExecutionFailed(format!("Failed to connect to SQLite at {}: {}", url, e)))
    }
}

impl N8nNode for SqliteNode {
    fn node_type(&self) -> &'static str {
        "n8n-nodes-base.sqlite"
    }

    fn execute<'a>(
        &'a self,
        ctx: &'a NodeExecutionContext,
        _input_data: Vec<INodeExecutionData>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError>> + Send + 'a>> {
        let db_file = ctx.parameters.get("databaseFile")
            .or_else(|| ctx.parameters.get("database"))
            .and_then(|v| v.as_str())
            .unwrap_or("n8n_rust.db")
            .to_string();

        let query = match ctx.parameters.get("query").and_then(|v| v.as_str()) {
            Some(q) => q.to_string(),
            None => {
                return Box::pin(async move {
                    Err(NodeExecutionError::MissingParameter("query".to_string()))
                });
            }
        };

        Box::pin(async move {
            let pool = Self::get_pool(&db_file).await?;

            let trimmed = query.trim().to_uppercase();
            if trimmed.starts_with("SELECT") || trimmed.starts_with("PRAGMA") || trimmed.starts_with("EXPLAIN") {
                let rows = sqlx::query(AssertSqlSafe(query))
                    .fetch_all(&pool)
                    .await
                    .map_err(|e| NodeExecutionError::ExecutionFailed(format!("SQLite query error: {}", e)))?;

                let results: Vec<INodeExecutionData> = rows.iter()
                    .map(|r| INodeExecutionData::from_json(Self::sqlite_row_to_json(r)))
                    .collect();

                if results.is_empty() {
                    Ok(vec![vec![INodeExecutionData::from_json(json!({ "result": [] }))]])
                } else {
                    Ok(vec![results])
                }
            } else {
                let res = sqlx::query(AssertSqlSafe(query))
                    .execute(&pool)
                    .await
                    .map_err(|e| NodeExecutionError::ExecutionFailed(format!("SQLite execute error: {}", e)))?;

                let out = json!({
                    "rowsAffected": res.rows_affected(),
                    "lastInsertRowid": res.last_insert_rowid(),
                    "success": true
                });

                Ok(vec![vec![INodeExecutionData::from_json(out)]])
            }
        })
    }
}
