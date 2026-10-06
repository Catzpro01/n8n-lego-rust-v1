use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::RwLock;

/// RuntimeRegistry memetakan bahasa + versi ke executable biner absolut
/// Menghindari overhead konstan dari `mise exec` di hot path.
pub struct RuntimeRegistry {
    cache: RwLock<HashMap<(String, String), PathBuf>>,
    system_runtimes: RwLock<Vec<(String, PathBuf, String)>>,
}

impl RuntimeRegistry {
    pub fn new() -> Self {
        let registry = Self {
            cache: RwLock::new(HashMap::new()),
            system_runtimes: RwLock::new(Vec::new()),
        };
        registry.register_default_runtimes();
        registry
    }

    fn find_all_in_path(cmd_name: &str) -> Vec<PathBuf> {
        let mut results = Vec::new();

        // 1. Coba which -a atau which (Unix)
        if let Ok(o) = Command::new("which").args(["-a", cmd_name]).output() {
            if o.status.success() {
                for line in String::from_utf8_lossy(&o.stdout).lines() {
                    let p = line.trim();
                    if !p.is_empty() {
                        let pb = PathBuf::from(p);
                        if pb.is_file() && !results.contains(&pb) {
                            results.push(pb);
                        }
                    }
                }
            }
        } else if let Ok(o) = Command::new("which").arg(cmd_name).output() {
            if o.status.success() {
                let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !p.is_empty() {
                    let pb = PathBuf::from(p);
                    if pb.is_file() && !results.contains(&pb) {
                        results.push(pb);
                    }
                }
            }
        }

        // 2. Coba where (Windows)
        if let Ok(o) = Command::new("where").arg(cmd_name).output() {
            if o.status.success() {
                for line in String::from_utf8_lossy(&o.stdout).lines() {
                    let p = line.trim();
                    if !p.is_empty() {
                        let pb = PathBuf::from(p);
                        if pb.is_file() && !results.contains(&pb) {
                            results.push(pb);
                        }
                    }
                }
            }
        }

        results
    }

    fn get_binary_version(path: &PathBuf, lang: &str) -> Option<String> {
        let arg = if lang == "javascript" || lang == "nodejs" { "-v" } else { "--version" };
        let out = Command::new(path).arg(arg).output().ok()?;
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !stdout.is_empty() {
                return Some(stdout);
            }
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if !stderr.is_empty() {
                return Some(stderr);
            }
        }
        None
    }

    fn version_matches(detected: &str, requested: &str) -> bool {
        let req = requested.trim().to_lowercase();
        if req == "default" || req.is_empty() {
            return true;
        }
        let req_clean = req.strip_prefix('v').unwrap_or(&req);

        let det = detected.trim().to_lowercase();
        let det_no_py = det.strip_prefix("python ").unwrap_or(&det);
        let det_clean = det_no_py.strip_prefix('v').unwrap_or(det_no_py);

        if det_clean == req_clean {
            return true;
        }

        let prefix_with_dot = format!("{}.", req_clean);
        if det_clean.starts_with(&prefix_with_dot) {
            return true;
        }

        false
    }

    fn register_default_runtimes(&self) {
        let mut map = self.cache.write().unwrap();
        let mut runtimes = self.system_runtimes.write().unwrap();

        // Cari node
        for cmd in ["node", "nodejs"] {
            for path in Self::find_all_in_path(cmd) {
                if let Some(ver) = Self::get_binary_version(&path, "javascript") {
                    if !map.contains_key(&("javascript".to_string(), "default".to_string())) {
                        map.insert(("javascript".to_string(), "default".to_string()), path.clone());
                        map.insert(("nodejs".to_string(), "default".to_string()), path.clone());
                    }
                    runtimes.push(("javascript".to_string(), path.clone(), ver.clone()));
                    runtimes.push(("nodejs".to_string(), path, ver));
                }
            }
        }

        // Cari python
        for cmd in ["python3", "python"] {
            for path in Self::find_all_in_path(cmd) {
                if let Some(ver) = Self::get_binary_version(&path, "python") {
                    if !map.contains_key(&("python".to_string(), "default".to_string())) {
                        map.insert(("python".to_string(), "default".to_string()), path.clone());
                    }
                    runtimes.push(("python".to_string(), path, ver));
                }
            }
        }
    }

    /// Resolve binary path secara deterministik.
    /// Mendukung default, pencocokan versi sistem (e.g. "22", "v22", "3.10"), dan mise.
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

        // 3. Cek pencocokan versi dengan sistem runtimes
        {
            let runtimes = self.system_runtimes.read().unwrap();
            for (rt_lang, path, detected_ver) in runtimes.iter() {
                if rt_lang == &lang && Self::version_matches(detected_ver, ver) {
                    let mut map = self.cache.write().unwrap();
                    map.insert((lang.clone(), ver.to_string()), path.clone());
                    return Some(path.clone());
                }
            }
        }

        // 4. Jika versi spesifik diminta dan belum cocok dengan sistem, resolve via `mise which`
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
