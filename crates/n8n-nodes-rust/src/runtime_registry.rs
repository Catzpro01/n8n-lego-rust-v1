use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::RwLock;

/// RuntimeRegistry memetakan bahasa + versi ke executable biner absolut
/// Menghindari overhead konstan dari `mise exec` di hot path.
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
        let out = Command::new("which").arg(cmd_name).output();
        if let Ok(o) = out {
            if o.status.success() {
                let path_str = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !path_str.is_empty() {
                    return Some(PathBuf::from(path_str));
                }
            }
        }
        // Fallback Windows where
        let out_win = Command::new("where").arg(cmd_name).output();
        if let Ok(o) = out_win {
            if o.status.success() {
                let first_line = String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !first_line.is_empty() {
                    return Some(PathBuf::from(first_line));
                }
            }
        }
        None
    }

    fn register_default_runtimes(&self) {
        let mut map = self.cache.write().unwrap();
        if let Some(path) = Self::find_in_path("node") {
            map.insert(("javascript".to_string(), "default".to_string()), path.clone());
            map.insert(("nodejs".to_string(), "default".to_string()), path);
        }
        if let Some(path) = Self::find_in_path("python3").or_else(|| Self::find_in_path("python")) {
            map.insert(("python".to_string(), "default".to_string()), path);
        }
    }

    /// Resolve binary path secara deterministik.
    /// PERBAIKAN AUDIT: Jika versi spesifik diminta dan tidak ditemukan via mise,
    /// sistem TIDAK BOLEH fallback ke default agar version pinning tidak rusak.
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

        // 2. Jika default diminta, ambil default biner sistem
        if ver == "default" {
            let map = self.cache.read().unwrap();
            return map.get(&(lang, "default".to_string())).cloned();
        }

        // 3. Jika versi spesifik diminta, resolve via `mise which`
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
                    map.insert((lang, ver.to_string()), path.clone());
                    return Some(path);
                }
            }
        }

        // Deterministik: Tidak ada fallback ke default saat versi spesifik gagal ditemukan
        None
    }
}

impl Default for RuntimeRegistry {
    fn default() -> Self {
        Self::new()
    }
}
