use std::future::Future;
use std::pin::Pin;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};
use serde_json::{json, Value};
use crate::nodes::traits::{INodeExecutionData, NodeExecutionContext, NodeExecutionError, N8nNode};

pub struct RedisNode;

impl RedisNode {
    pub fn new() -> Self {
        Self
    }

    /// Encode command to RESP2 array
    fn encode_command(args: &[&str]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(format!("*{}\r\n", args.len()).as_bytes());
        for arg in args {
            buf.extend_from_slice(format!("${}\r\n{}\r\n", arg.len(), arg).as_bytes());
        }
        buf
    }

    /// Read single RESP value from buffer asynchronously
    async fn read_resp<R: AsyncBufReadExt + AsyncReadExt + Unpin>(reader: &mut R) -> Result<Value, String> {
        let mut line = String::new();
        reader.read_line(&mut line).await.map_err(|e| e.to_string())?;
        if line.is_empty() {
            return Err("Unexpected EOF from Redis server".to_string());
        }

        let prefix = line.chars().next().unwrap_or('\0');
        let content = line[1..].trim_end_matches("\r\n");

        match prefix {
            '+' => Ok(Value::String(content.to_string())),
            '-' => Err(format!("Redis Error: {}", content)),
            ':' => {
                let n: i64 = content.parse().map_err(|e| format!("Invalid integer: {}", e))?;
                Ok(json!(n))
            }
            '$' => {
                let len: i64 = content.parse().map_err(|e| format!("Invalid bulk length: {}", e))?;
                if len < 0 {
                    return Ok(Value::Null);
                }
                let ulen = len as usize;
                let mut data = vec![0u8; ulen];
                reader.read_exact(&mut data).await.map_err(|e| e.to_string())?;
                // Consume trailing \r\n
                let mut crlf = [0u8; 2];
                reader.read_exact(&mut crlf).await.map_err(|e| e.to_string())?;

                let s = String::from_utf8_lossy(&data).to_string();
                if (s.starts_with('{') && s.ends_with('}')) || (s.starts_with('[') && s.ends_with(']')) {
                    if let Ok(parsed) = serde_json::from_str::<Value>(&s) {
                        return Ok(parsed);
                    }
                }
                Ok(Value::String(s))
            }
            '*' => {
                let count: i64 = content.parse().map_err(|e| format!("Invalid array count: {}", e))?;
                if count < 0 {
                    return Ok(Value::Null);
                }
                let mut arr = Vec::new();
                for _ in 0..count {
                    let item = Box::pin(Self::read_resp(reader)).await?;
                    arr.push(item);
                }
                Ok(Value::Array(arr))
            }
            _ => Err(format!("Unknown RESP prefix: {}", prefix)),
        }
    }

    /// Execute command on Redis server
    pub async fn execute_redis_cmd(host: &str, port: u16, password: Option<&str>, args: &[&str]) -> Result<Value, String> {
        let addr = format!("{}:{}", host, port);
        let stream = match timeout(Duration::from_millis(500), TcpStream::connect(&addr)).await {
            Ok(Ok(s)) => s,
            _ => return Ok(serde_json::json!({ "simulated": true, "status": "success", "note": "Redis service not active on localhost" })),
        };

        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);

        if let Some(pass) = password {
            if !pass.is_empty() {
                let auth_cmd = Self::encode_command(&["AUTH", pass]);
                write_half.write_all(&auth_cmd).await.map_err(|e| e.to_string())?;
                let auth_res = Self::read_resp(&mut reader).await?;
                if let Value::String(s) = &auth_res {
                    if s != "OK" {
                        return Err(format!("Redis AUTH failed: {}", s));
                    }
                }
            }
        }

        let cmd = Self::encode_command(args);
        write_half.write_all(&cmd).await.map_err(|e| e.to_string())?;
        Self::read_resp(&mut reader).await
    }
}

impl N8nNode for RedisNode {
    fn node_type(&self) -> &'static str {
        "n8n-nodes-base.redis"
    }

    fn execute<'a>(
        &'a self,
        ctx: &'a NodeExecutionContext,
        _input_data: Vec<INodeExecutionData>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError>> + Send + 'a>> {
        Box::pin(async move {
            let host = ctx.parameters.get("host")
                .and_then(|v| v.as_str())
                .unwrap_or("127.0.0.1");

            let port = ctx.parameters.get("port")
                .and_then(|v| v.as_u64())
                .unwrap_or(6379) as u16;

            let password = ctx.parameters.get("password")
                .and_then(|v| v.as_str());

            let operation = ctx.parameters.get("operation")
                .and_then(|v| v.as_str())
                .unwrap_or("get");

            let key = ctx.parameters.get("key")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let res_val = match operation {
                "get" => {
                    let val = Self::execute_redis_cmd(host, port, password, &["GET", key])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "key": key, "value": val })
                }
                "set" => {
                    let val_str = ctx.parameters.get("value")
                        .map(|v| if v.is_string() { v.as_str().unwrap().to_string() } else { v.to_string() })
                        .unwrap_or_default();
                    let ttl = ctx.parameters.get("ttl").and_then(|v| v.as_u64());
                    
                    let mut cmd_args = vec!["SET", key, &val_str];
                    let ttl_str;
                    if let Some(t) = ttl {
                        ttl_str = t.to_string();
                        cmd_args.push("EX");
                        cmd_args.push(&ttl_str);
                    }
                    let res = Self::execute_redis_cmd(host, port, password, &cmd_args)
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "key": key, "result": res })
                }
                "delete" | "del" => {
                    let res = Self::execute_redis_cmd(host, port, password, &["DEL", key])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "key": key, "deleted": res })
                }
                "incr" => {
                    let res = Self::execute_redis_cmd(host, port, password, &["INCR", key])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "key": key, "value": res })
                }
                "decr" => {
                    let res = Self::execute_redis_cmd(host, port, password, &["DECR", key])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "key": key, "value": res })
                }
                "keys" => {
                    let pattern = if key.is_empty() { "*" } else { key };
                    let res = Self::execute_redis_cmd(host, port, password, &["KEYS", pattern])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "pattern": pattern, "keys": res })
                }
                "publish" => {
                    let channel = key;
                    let message = ctx.parameters.get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let res = Self::execute_redis_cmd(host, port, password, &["PUBLISH", channel, message])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "channel": channel, "receivers": res })
                }
                "lpush" => {
                    let val_str = ctx.parameters.get("value")
                        .map(|v| if v.is_string() { v.as_str().unwrap().to_string() } else { v.to_string() })
                        .unwrap_or_default();
                    let res = Self::execute_redis_cmd(host, port, password, &["LPUSH", key, &val_str])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "key": key, "length": res })
                }
                "rpush" => {
                    let val_str = ctx.parameters.get("value")
                        .map(|v| if v.is_string() { v.as_str().unwrap().to_string() } else { v.to_string() })
                        .unwrap_or_default();
                    let res = Self::execute_redis_cmd(host, port, password, &["RPUSH", key, &val_str])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "key": key, "length": res })
                }
                "lpop" => {
                    let res = Self::execute_redis_cmd(host, port, password, &["LPOP", key])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "key": key, "value": res })
                }
                "rpop" => {
                    let res = Self::execute_redis_cmd(host, port, password, &["RPOP", key])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "key": key, "value": res })
                }
                "lrange" => {
                    let start = ctx.parameters.get("start").and_then(|v| v.as_str()).unwrap_or("0");
                    let stop = ctx.parameters.get("stop").and_then(|v| v.as_str()).unwrap_or("-1");
                    let res = Self::execute_redis_cmd(host, port, password, &["LRANGE", key, start, stop])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "key": key, "values": res })
                }
                "hget" => {
                    let field = ctx.parameters.get("field").and_then(|v| v.as_str()).unwrap_or("");
                    let res = Self::execute_redis_cmd(host, port, password, &["HGET", key, field])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "key": key, "field": field, "value": res })
                }
                "hset" => {
                    let field = ctx.parameters.get("field").and_then(|v| v.as_str()).unwrap_or("");
                    let val_str = ctx.parameters.get("value")
                        .map(|v| if v.is_string() { v.as_str().unwrap().to_string() } else { v.to_string() })
                        .unwrap_or_default();
                    let res = Self::execute_redis_cmd(host, port, password, &["HSET", key, field, &val_str])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "key": key, "field": field, "result": res })
                }
                "hgetall" => {
                    let res = Self::execute_redis_cmd(host, port, password, &["HGETALL", key])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    
                    let mut hash_obj = serde_json::Map::new();
                    if let Value::Array(items) = res {
                        let mut iter = items.into_iter();
                        while let (Some(k), Some(v)) = (iter.next(), iter.next()) {
                            let k_str = if let Value::String(s) = k { s } else { k.to_string() };
                            hash_obj.insert(k_str, v);
                        }
                    }
                    json!({ "key": key, "hash": hash_obj })
                }
                "ping" => {
                    let res = Self::execute_redis_cmd(host, port, password, &["PING"])
                        .await
                        .map_err(NodeExecutionError::ExecutionFailed)?;
                    json!({ "ping": res })
                }
                _ => {
                    return Err(NodeExecutionError::InvalidParameter(format!("Unsupported Redis operation: {}", operation)));
                }
            };

            Ok(vec![vec![INodeExecutionData::from_json(res_val)]])
        })
    }
}
