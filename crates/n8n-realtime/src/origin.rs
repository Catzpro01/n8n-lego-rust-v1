use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginInfo {
    pub protocol: String,
    pub host: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginValidationResult {
    pub is_valid: bool,
    pub origin_info: Option<OriginInfo>,
    pub expected_host: Option<String>,
    pub expected_protocol: Option<String>,
    pub raw_expected_host: Option<String>,
    pub error: Option<String>,
}

fn strip_default_port(host: &str, proto: &str) -> String {
    let is_https = proto == "https";
    if is_https && host.ends_with(":443") {
        host[..host.len() - 4].to_string()
    } else if !is_https && host.ends_with(":80") {
        host[..host.len() - 3].to_string()
    } else {
        host.to_string()
    }
}

fn parse_forwarded_header(header: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for part in header.split(';') {
        let mut kv = part.trim().splitn(2, '=');
        if let (Some(k), Some(v)) = (kv.next(), kv.next()) {
            let key = k.trim().to_lowercase();
            let val = v.trim().trim_matches('"').to_string();
            map.insert(key, val);
        }
    }
    map
}

fn parse_url_proto_host(url_str: &str) -> Option<(String, String)> {
    let trimmed = url_str.trim();
    let (proto, rest) = if let Some(idx) = trimmed.find("://") {
        let p = &trimmed[..idx];
        let r = &trimmed[idx + 3..];
        (p.to_lowercase(), r)
    } else {
        return None;
    };

    let host = if let Some(slash_idx) = rest.find('/') {
        &rest[..slash_idx]
    } else if let Some(q_idx) = rest.find('?') {
        &rest[..q_idx]
    } else {
        rest
    };

    if host.is_empty() {
        return None;
    }

    Some((proto, host.to_string()))
}

/// Validates Origin header with precedence: Forwarded > X-Forwarded-Host > Host (Invariant R11)
pub fn validate_origin_headers(
    origin: Option<&str>,
    host: Option<&str>,
    x_forwarded_host: Option<&str>,
    x_forwarded_proto: Option<&str>,
    forwarded: Option<&str>,
) -> OriginValidationResult {
    let origin_str = match origin {
        Some(o) if !o.trim().is_empty() => o.trim(),
        _ => {
            return OriginValidationResult {
                is_valid: false,
                origin_info: None,
                expected_host: None,
                expected_protocol: None,
                raw_expected_host: None,
                error: Some("Origin header is missing or malformed".to_string()),
            }
        }
    };

    let (origin_proto, origin_raw_host) = match parse_url_proto_host(origin_str) {
        Some(pair) => pair,
        None => {
            return OriginValidationResult {
                is_valid: false,
                origin_info: None,
                expected_host: None,
                expected_protocol: None,
                raw_expected_host: None,
                error: Some("Origin header is missing or malformed".to_string()),
            }
        }
    };

    let origin_host = strip_default_port(&origin_raw_host, &origin_proto);

    let mut raw_expected_host = host.map(|s| s.to_string());
    let mut expected_proto = origin_proto.clone();

    if let Some(fwd_str) = forwarded {
        let fwd = parse_forwarded_header(fwd_str);
        if let Some(fwd_host) = fwd.get("host") {
            raw_expected_host = Some(fwd_host.clone());
            if let Some(fwd_proto) = fwd.get("proto") {
                expected_proto = fwd_proto.clone();
            }
        }
    } else if let Some(xf_host) = x_forwarded_host {
        raw_expected_host = Some(xf_host.to_string());
        if let Some(xf_proto) = x_forwarded_proto {
            expected_proto = xf_proto.to_string();
        }
    }

    let expected_host = raw_expected_host.as_deref().map(|h| strip_default_port(h, &expected_proto));

    // Normalize IPv6 brackets for comparison
    let norm_origin = origin_host.replace('[', "").replace(']', "");
    let norm_expected = expected_host
        .as_deref()
        .map(|h| h.replace('[', "").replace(']', ""))
        .unwrap_or_default();

    let is_valid = !norm_expected.is_empty() && norm_origin == norm_expected;

    OriginValidationResult {
        is_valid,
        origin_info: Some(OriginInfo {
            protocol: origin_proto,
            host: origin_host,
        }),
        expected_host,
        expected_protocol: Some(expected_proto),
        raw_expected_host,
        error: if is_valid {
            None
        } else {
            Some("Origin header does not match expected host".to_string())
        },
    }
}
