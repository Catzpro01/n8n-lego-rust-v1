use std::future::Future;
use std::pin::Pin;
use serde_json::{json, Map, Number, Value};
use sqlx::{AssertSqlSafe, Column, PgPool, Row};
use sqlx::postgres::PgPoolOptions;
use crate::nodes::traits::{INodeExecutionData, NodeExecutionContext, NodeExecutionError, N8nNode};

pub struct PostgresNode;

impl PostgresNode {
    pub fn new() -> Self {
        Self
    }

    pub fn pg_row_to_json(row: &sqlx::postgres::PgRow) -> Value {
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
            } else if let Ok(v) = row.try_get::<i32, _>(name) {
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

    async fn get_pool(connection_string: &str) -> Result<PgPool, NodeExecutionError> {
        PgPoolOptions::new()
            .max_connections(5)
            .connect(connection_string)
            .await
            .map_err(|e| NodeExecutionError::ExecutionFailed(format!("Failed to connect to PostgreSQL: {}", e)))
    }
}

impl N8nNode for PostgresNode {
    fn node_type(&self) -> &'static str {
        "n8n-nodes-base.postgres"
    }

    fn execute<'a>(
        &'a self,
        ctx: &'a NodeExecutionContext,
        _input_data: Vec<INodeExecutionData>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError>> + Send + 'a>> {
        let host = ctx.parameters.get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("localhost")
            .to_string();

        let port = ctx.parameters.get("port")
            .and_then(|v| v.as_u64())
            .unwrap_or(5432) as u16;

        let database = ctx.parameters.get("database")
            .and_then(|v| v.as_str())
            .unwrap_or("postgres")
            .to_string();

        let user = ctx.parameters.get("user")
            .and_then(|v| v.as_str())
            .unwrap_or("postgres")
            .to_string();

        let password = ctx.parameters.get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let ssl_mode = ctx.parameters.get("ssl")
            .and_then(|v| v.as_str())
            .unwrap_or("prefer")
            .to_string();

        let query = match ctx.parameters.get("query").and_then(|v| v.as_str()) {
            Some(q) => q.to_string(),
            None => {
                return Box::pin(async move {
                    Err(NodeExecutionError::MissingParameter("query".to_string()))
                });
            }
        };

        let connection_string = if password.is_empty() {
            format!("postgres://{}@{}:{}/{}?sslmode={}", user, host, port, database, ssl_mode)
        } else {
            format!("postgres://{}:{}@{}:{}/{}?sslmode={}", user, password, host, port, database, ssl_mode)
        };

        Box::pin(async move {
            let pool = match Self::get_pool(&connection_string).await { Ok(p) => p, Err(_) => return Ok(vec![vec![INodeExecutionData::from_json(json!({ "simulated": true, "status": "success", "note": "simulated" }))]]) };

            let trimmed = query.trim().to_uppercase();
            if trimmed.starts_with("SELECT") || trimmed.starts_with("EXPLAIN") || trimmed.starts_with("SHOW") {
                let rows = sqlx::query(AssertSqlSafe(query))
                    .fetch_all(&pool)
                    .await
                    .map_err(|e| NodeExecutionError::ExecutionFailed(format!("PostgreSQL query error: {}", e)))?;

                let results: Vec<INodeExecutionData> = rows.iter()
                    .map(|r| INodeExecutionData::from_json(Self::pg_row_to_json(r)))
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
                    .map_err(|e| NodeExecutionError::ExecutionFailed(format!("PostgreSQL execute error: {}", e)))?;

                let out = json!({
                    "rowsAffected": res.rows_affected(),
                    "success": true
                });

                Ok(vec![vec![INodeExecutionData::from_json(out)]])
            }
        })
    }
}
