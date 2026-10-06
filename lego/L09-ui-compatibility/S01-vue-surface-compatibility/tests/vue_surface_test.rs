//! Unit tests for L09.S01 Official Vue surface compatibility

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_serve_root_returns_index_html() {
        let service = UiStaticBundleService::new("2.9.4");
        let asset = service.resolve_asset("/").expect("root should resolve to index");

        assert_eq!(asset.path, "/index.html");
        assert_eq!(asset.content_type, "text/html; charset=utf-8");
        assert!(String::from_utf8(asset.content).unwrap().contains("n8n vue bundle v2.9.4"));
    }

    #[test]
    fn test_serve_registered_static_asset() {
        let service = UiStaticBundleService::new("2.9.4");
        service.register_asset(
            "/assets/main.js",
            "application/javascript",
            b"console.log('n8n ready');".to_vec(),
            "public, max-age=31536000, immutable",
        );

        let asset = service.resolve_asset("/assets/main.js").unwrap();
        assert_eq!(asset.path, "/assets/main.js");
        assert_eq!(asset.content_type, "application/javascript");
        assert_eq!(asset.cache_control, "public, max-age=31536000, immutable");
        assert_eq!(String::from_utf8(asset.content).unwrap(), "console.log('n8n ready');");
    }

    #[test]
    fn test_spa_route_fallback() {
        let service = UiStaticBundleService::new("2.9.4");
        // SPA route like /workflow/123 or /settings should fallback to index.html
        let asset = service.resolve_asset("/workflow/new").expect("SPA route should fallback");
        assert_eq!(asset.path, "/index.html");

        let asset_settings = service.resolve_asset("/settings/users").expect("SPA route should fallback");
        assert_eq!(asset_settings.path, "/index.html");
    }

    #[test]
    fn test_path_traversal_prevention() {
        let service = UiStaticBundleService::new("2.9.4");
        let err = service.resolve_asset("/../../etc/passwd");
        assert!(matches!(err, Err(UiStaticError::PathTraversal(_))));
    }

    #[test]
    fn test_manifest_metadata() {
        let service = UiStaticBundleService::new("2.9.4");
        let manifest = service.get_manifest();

        assert_eq!(manifest.version, "2.9.4");
        assert_eq!(manifest.bundle_id, "n8n-vue-bundle-2.9.4");
        assert_eq!(manifest.index_path, "/index.html");
        assert!(manifest.total_assets >= 2);
    }

    #[test]
    fn test_port_handler_serve_and_register() {
        let service = UiStaticBundleService::new("2.9.4");

        // 1. Port Register
        let reg_res = service
            .handle_port_serve(&json!({
                "action": "register",
                "path": "/style.css",
                "content_type": "text/css",
                "body": "body { background: #000; }"
            }))
            .expect("register via port should succeed");
        assert_eq!(reg_res["success"], true);

        // 2. Port Serve
        let serve_res = service
            .handle_port_serve(&json!({
                "action": "serve",
                "path": "/style.css"
            }))
            .expect("serve via port should succeed");
        assert_eq!(serve_res["success"], true);
        assert_eq!(serve_res["content_type"], "text/css");
        assert_eq!(serve_res["body"], "body { background: #000; }");

        // 3. Port Manifest
        let man_res = service
            .handle_port_serve(&json!({
                "action": "manifest"
            }))
            .expect("manifest via port should succeed");
        assert_eq!(man_res["success"], true);
        assert_eq!(man_res["manifest"]["version"], "2.9.4");
    }

    #[test]
    fn test_not_found_on_missing_file_with_extension() {
        let service = UiStaticBundleService::new("2.9.4");
        let err = service.resolve_asset("/assets/non_existent.js");
        assert!(matches!(err, Err(UiStaticError::NotFound(_))));
    }
}
