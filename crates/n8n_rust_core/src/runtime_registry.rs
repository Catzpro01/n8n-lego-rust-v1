use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::RwLock;

/// Registry untuk memetakan bahasa + versi ke path biner absolut yang sudah ter-resolve
pub struct RuntimeRegistry {
    cache: RwLock<HashMap<(String, String), PathBuf>>,
}

impl RuntimeRegistry {
    pub fn new() -> Self {
        let registry = Self {
            cache: RwLock::new(HashMap::new()),
        };
        registry.register_default_runtimes();
        registry
    }

    fn find_in_path(cmd_name: &str) -> Option<PathBuf> {
        let out = Command::new("which").arg(cmd_name).output().ok()?;
        if out.status.success() {
            let path_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path_str.is_empty() {
                return Some(PathBuf::from(path_str));
            }
        }
        None
    }

    fn register_default_runtimes(&self) {
        let mut map = self.cache.write().unwrap();
        // Cari node default
        if let Some(path) = Self::find_in_path("node") {
            map.insert(("javascript".to_string(), "default".to_string()), path.clone());
            map.insert(("nodejs".to_string(), "default".to_string()), path);
        }
        // Cari python3 / python default
        if let Some(path) = Self::find_in_path("python3").or_else(|| Self::find_in_path("python")) {
            map.insert(("python".to_string(), "default".to_string()), path);
        }
    }

    /// Resolve executable path via mise which or fallback to system
    pub fn resolve_binary(&self, language: &str, version: &str) -> Option<PathBuf> {
        let lang = language.to_lowercase();
        let ver = if version.trim().is_empty() { "default" } else { version.trim() };

        // 1. Cek cache memori
        {
            let map = self.cache.read().unwrap();
            if let Some(path) = map.get(&(lang.clone(), ver.to_string())) {
                return Some(path.clone());
            }
        }

        // 2. Jika bukan default, coba resolve menggunakan `mise which`
        if ver != "default" {
            let tool_arg = format!("{}@{}", lang, ver);
            let output = Command::new("mise")
                .args(["which", &tool_arg])
                .output();

            if let Ok(out) = output {
                if out.status.success() {
                    let resolved = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !resolved.is_empty() {
                        let path = PathBuf::from(resolved);
                        let mut map = self.cache.write().unwrap();
                        map.insert((lang.clone(), ver.to_string()), path.clone());
                        return Some(path);
                    }
                }
            }
        }

        // 3. Fallback ke default
        let map = self.cache.read().unwrap();
        map.get(&(lang, "default".to_string())).cloned()
    }
}
