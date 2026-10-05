//! P4 PERFORMANCE BENCHMARK — Issue #99 §T/§U/§W (finalisasi P4, Agent 1).
//!
//! Mengukur di *reference hardware* (host sandbox ini) dalam mode release:
//! route lookup (atlas indexed + webhook resolve), admission latency steady/
//! duplicate, activation latency, burst overload + recovery, normalisasi
//! payload tiny/64KiB, journal/reconcile recovery, serta RSS/CPU/alokasi.
//!
//! Jalankan:
//! ```text
//! cargo run --release -p n8n-common --example p4_perf_bench
//! ```
//! Output: satu objek JSON di stdout (tanpa narasi) — disimpan sebagai evidence.

use n8n_common::{
    normalize_request, ActivationMode, ActivationRegistry, AdmissionConfig, AdmissionControl,
    AdmissionOutcome, CorrelationId, Generation, HttpMethod, IdempotencyKey, IngressEnvelope,
    IngressSource, IngressSourceKind, Journal, LifecycleEvent, MetadataRef, NodeWebhookSpec,
    NormalizeLimits, NormalizedRequest, PayloadRef, Priority, RawWebhookRequest, RequestId,
    ResponseMode, RouteAtlas, RouteKind, RouteRecord, ScheduleRegistry, ScheduleSpec,
    SecurityDecisionRef, SecurityOutcome, WebhookAuth, WebhookRegistry, WorkflowIdentity,
    ENVELOPE_VERSION,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

// ------------------------------------------------------------------ allocator
struct CountingAlloc;

static ALLOC_CALLS: AtomicU64 = AtomicU64::new(0);
static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(layout.size() as u64, Ordering::Relaxed);
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
        ALLOC_BYTES.fetch_add(new_size as u64, Ordering::Relaxed);
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GA: CountingAlloc = CountingAlloc;

// ------------------------------------------------------------------ helpers
fn pxx(sorted_ns: &[u64], p: f64) -> u64 {
    if sorted_ns.is_empty() {
        return 0;
    }
    let idx = ((p / 100.0) * (sorted_ns.len() as f64 - 1.0)).round() as usize;
    sorted_ns[idx.min(sorted_ns.len() - 1)]
}

#[allow(clippy::too_many_arguments)]
fn stats_json(name: &str, mut samples: Vec<u64>, extra: serde_json::Value) -> serde_json::Value {
    samples.sort_unstable();
    let n = samples.len() as u64;
    let sum: u64 = samples.iter().sum();
    let mut obj = serde_json::json!({
        "name": name,
        "samples": n,
        "p50_ns": pxx(&samples, 50.0),
        "p95_ns": pxx(&samples, 95.0),
        "p99_ns": pxx(&samples, 99.0),
        "min_ns": samples.first().copied().unwrap_or(0),
        "max_ns": samples.last().copied().unwrap_or(0),
        "mean_ns": if n > 0 { sum / n } else { 0 },
    });
    if let serde_json::Value::Object(map) = extra {
        for (k, v) in map {
            obj[k] = v;
        }
    }
    obj
}

fn lcg(state: &mut u64) -> u64 {
    *state = state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    *state >> 33
}

fn wf(id: &str, version: u64) -> WorkflowIdentity {
    WorkflowIdentity::new(id, Some(format!("v{version}"))).unwrap()
}

fn envelope(req_id: &str, idem: Option<&str>) -> IngressEnvelope {
    IngressEnvelope {
        version: ENVELOPE_VERSION,
        request_id: RequestId::new(req_id).unwrap(),
        correlation_id: Some(CorrelationId::new(&format!("c-{req_id}")).unwrap()),
        received_at_ms: 1_700_000_000_000,
        deadline_ms: Some(1_700_000_000_000 + 60_000),
        priority: Priority::Normal,
        source: IngressSource {
            kind: IngressSourceKind::ProductionWebhook,
            received_method: Some(HttpMethod::Post),
            received_path: Some("/webhook/bench".to_string()),
        },
        workflow: Some(WorkflowIdentity::new("wf-1", None).unwrap()),
        generation: Some(Generation::new(1)),
        tenant_id: None,
        security: Some(SecurityDecisionRef {
            decision_id: "sec-1".to_string(),
            authority: "webhook-auth".to_string(),
            outcome: SecurityOutcome::Allow,
            decided_at_ms: 1_700_000_000_000,
            reason_code: None,
        }),
        idempotency_key: idem.map(|s| IdempotencyKey::new(s).unwrap()),
        payload: PayloadRef::Inline {
            json: serde_json::json!({"a": 1}),
        },
        metadata: MetadataRef {
            headers: Vec::new(),
            query: Vec::new(),
        },
    }
}

fn activated_registry() -> ActivationRegistry {
    let mut reg = ActivationRegistry::new();
    reg.begin_activation(
        wf("wf-1", 1),
        ActivationMode::Activate,
        None,
        None,
        1_700_000_000_000,
    )
    .unwrap();
    reg.commit_activation("wf-1", None, 1_700_000_000_001)
        .unwrap();
    reg
}

fn route_record(i: usize) -> RouteRecord {
    RouteRecord {
        route_id: format!("rid-{i}"),
        workflow: WorkflowIdentity::new(&format!("wf-{i}"), None).unwrap(),
        node_id: format!("node-{i}"),
        node_name: format!("Node {i}"),
        kind: RouteKind::ProductionWebhook,
        method: HttpMethod::Post,
        path: format!("bench/path-{i}"),
        path_depth: 2,
        generation: Generation::new(1),
        registered_at_ms: 1_700_000_000_000,
        webhook_id: Some(format!("wh-{i}")),
        auth: WebhookAuth::None,
    }
}

fn webhook_spec(i: usize) -> NodeWebhookSpec {
    NodeWebhookSpec {
        node_id: "hook".to_string(),
        node_name: "Hook Node".to_string(),
        method: HttpMethod::Post,
        path: format!("b{i}"),
        auth: WebhookAuth::None,
        response_mode: ResponseMode::OnReceived,
        response_data: None,
        response_status_code: None,
        response_headers: Vec::new(),
    }
}

fn bench_atlas(routes: usize, iters: usize) -> serde_json::Value {
    let built = RouteAtlas::compile((0..routes).map(route_record));
    let atlas = match built {
        Ok(a) => a,
        Err(e) => {
            // Hard bound desain (#17/§P, innovation test atlas_bounded): atlas
            // menolak di atas kapasitas — dicatat apa adanya, fallback diukur
            // terpisah lewat WebhookRegistry (authoritative index).
            return serde_json::json!({
                "name": "atlas_route_lookup",
                "routes_requested": routes,
                "bounded_out": format!("{e:?}"),
                "hard_bound_behavior": "AtlasFull (fail-closed, no unbounded map)",
            });
        }
    };
    // warm-up
    let mut st = 0x9E37_79B9_7F4A_7C15u64;
    for _ in 0..10_000 {
        let i = (lcg(&mut st) as usize) % routes;
        std::hint::black_box(atlas.resolve(HttpMethod::Post, &format!("bench/path-{i}")));
    }
    let mut samples = Vec::with_capacity(iters);
    let c0 = ALLOC_CALLS.load(Ordering::Relaxed);
    for _ in 0..iters {
        let i = (lcg(&mut st) as usize) % routes;
        let path = format!("bench/path-{i}");
        let t0 = Instant::now();
        let hit = std::hint::black_box(atlas.resolve(HttpMethod::Post, &path));
        samples.push(t0.elapsed().as_nanos() as u64);
        std::hint::black_box(hit.expect("hit"));
    }
    let c1 = ALLOC_CALLS.load(Ordering::Relaxed);
    stats_json(
        "atlas_route_lookup",
        samples,
        serde_json::json!({
            "routes": routes,
            "hit_rate": 1.0,
            "allocs_total": c1 - c0,
            "allocs_per_op": (c1 - c0) as f64 / iters as f64,
        }),
    )
}

fn bench_webhook_resolve(routes: usize, iters: usize) -> serde_json::Value {
    let mut reg = WebhookRegistry::new();
    for i in 0..routes {
        let id = format!("wf-{i}");
        reg.register_workflow(
            wf(&id, 1),
            &[webhook_spec(i)],
            ActivationMode::Activate,
            None,
            1_700_000_000_000,
        )
        .expect("register");
        reg.commit_workflow(&id, None, 1_700_000_000_001)
            .expect("commit");
    }
    let mut st = 0xDEAD_BEEF_1234_5678u64;
    for _ in 0..5_000 {
        let i = (lcg(&mut st) as usize) % routes;
        std::hint::black_box(reg.resolve_http(HttpMethod::Post, &format!("/webhook/b{i}")));
    }
    let mut samples = Vec::with_capacity(iters);
    let mut misses = 0u64;
    let c0 = ALLOC_CALLS.load(Ordering::Relaxed);
    for _ in 0..iters {
        let i = (lcg(&mut st) as usize) % routes;
        let path = format!("/webhook/b{i}");
        let t0 = Instant::now();
        let res = std::hint::black_box(reg.resolve_http(HttpMethod::Post, &path));
        samples.push(t0.elapsed().as_nanos() as u64);
        if !matches!(res, n8n_common::RouteResolution::Matched(_)) {
            misses += 1;
        }
    }
    let c1 = ALLOC_CALLS.load(Ordering::Relaxed);
    stats_json(
        "webhook_resolve_http",
        samples,
        serde_json::json!({
            "routes": routes,
            "misses": misses,
            "allocs_per_op": (c1 - c0) as f64 / iters as f64,
        }),
    )
}

fn bench_admission_steady(iters: usize) -> serde_json::Value {
    let reg = activated_registry();
    // Konfigurasi khusus ukur (DICATAT — bukan default): capacity/refill rute
    // dinaikkan agar 50K iterasi seluruhnya menempuh jalur Admitted; perilaku
    // rate-limit default (capacity 1000 / refill 200 per dtk) diukur pada
    // skenario burst terpisah.
    let mut cfg = AdmissionConfig::default();
    cfg.route_capacity = 1_000_000;
    cfg.route_refill_per_s = 10_000_000;
    let mut ctrl = AdmissionControl::new(cfg).expect("ctrl");
    let mut samples = Vec::with_capacity(iters);
    let mut admitted = 0u64;
    let c0 = ALLOC_CALLS.load(Ordering::Relaxed);
    for i in 0..iters {
        let env = envelope(&format!("req-{i}"), Some(&format!("idem-{i}")));
        let t0 = Instant::now();
        let out = ctrl
            .admit_probe(env, &reg, 1_700_000_000_100)
            .expect("admit");
        samples.push(t0.elapsed().as_nanos() as u64);
        if matches!(out, AdmissionOutcome::Admitted(_)) {
            admitted += 1;
            ctrl.finish_execution(0);
        }
    }
    let c1 = ALLOC_CALLS.load(Ordering::Relaxed);
    stats_json(
        "admission_steady",
        samples,
        serde_json::json!({
            "admitted": admitted,
            "config": "route_capacity=1_000_000, route_refill_per_s=10_000_000 (measurement config; defaults measured in burst)",
            "allocs_per_op": (c1 - c0) as f64 / iters as f64,
        }),
    )
}

fn bench_admission_duplicate(iters: usize) -> serde_json::Value {
    let reg = activated_registry();
    let mut ctrl = AdmissionControl::new(AdmissionConfig::default()).expect("ctrl");
    // kunci pertama diterima; iterasi berikut memakai kunci sama → Duplicate
    let first = envelope("req-dup-0", Some("idem-dup"));
    match ctrl
        .admit_probe(first, &reg, 1_700_000_000_100)
        .expect("admit")
    {
        AdmissionOutcome::Admitted(_) => ctrl.finish_execution(0),
        other => panic!("iter0 harus Admitted, dapat {other:?}"),
    }
    let mut samples = Vec::with_capacity(iters);
    let mut duplicate_rejects = 0u64;
    let mut other_rejects = 0u64;
    for i in 0..iters {
        let env = envelope(&format!("req-dup-{}", i + 1), Some("idem-dup"));
        let t0 = Instant::now();
        let out = ctrl
            .admit_probe(env, &reg, 1_700_000_000_101)
            .expect("admit");
        samples.push(t0.elapsed().as_nanos() as u64);
        if let AdmissionOutcome::Rejected { admission, .. } = &out {
            if matches!(admission.state, n8n_common::AdmissionState::Duplicate) {
                duplicate_rejects += 1;
            } else {
                other_rejects += 1;
            }
        }
    }
    stats_json(
        "admission_duplicate",
        samples,
        serde_json::json!({
            "duplicate_rejects": duplicate_rejects,
            "other_rejects": other_rejects,
        }),
    )
}

fn bench_activation(workflows: usize) -> serde_json::Value {
    let mut reg = ScheduleRegistry::new();
    let spec = ScheduleSpec {
        node_id: "node-1".to_string(),
        node_name: "N1".to_string(),
        cron: "0 0 * * *".to_string(),
        timezone: "+00:00".to_string(),
        enabled: true,
        misfire: Default::default(),
        overlap: Default::default(),
        jitter_ms: 0,
        deadline_ms: None,
        gap_policy: Default::default(),
    };
    let mut samples = Vec::with_capacity(workflows);
    let mut ok = 0u64;
    for i in 0..workflows {
        let id = format!("wf-act-{i}");
        let t0 = Instant::now();
        reg.register_workflow(
            wf(&id, 1),
            std::slice::from_ref(&spec),
            ActivationMode::Activate,
            None,
            1_700_000_000_000,
        )
        .expect("register");
        reg.commit_workflow(&id, None, 1_700_000_000_001)
            .expect("commit");
        samples.push(t0.elapsed().as_nanos() as u64);
        ok += 1;
    }
    stats_json(
        "activation_register_commit",
        samples,
        serde_json::json!({ "workflows": ok }),
    )
}

fn bench_burst() -> serde_json::Value {
    let reg = activated_registry();
    let mut ctrl = AdmissionControl::new(AdmissionConfig::default()).expect("ctrl");
    let issued = 20_000usize;
    let mut admitted = 0u64;
    let mut shed = 0u64;
    let mut max_in_flight = 0u64;
    let mut steady_ns = Vec::with_capacity(issued);
    let t0 = Instant::now();
    for i in 0..issued {
        let env = envelope(&format!("burst-{i}"), Some(&format!("burst-idem-{i}")));
        let ti = Instant::now();
        let out = ctrl
            .admit_probe(env, &reg, 1_700_000_000_200)
            .expect("admit");
        steady_ns.push(ti.elapsed().as_nanos() as u64);
        match out {
            AdmissionOutcome::Admitted(_) => {
                admitted += 1;
                max_in_flight = max_in_flight.max(ctrl.in_flight());
                // tanpa finish → in-flight menumpuk hingga batas → overload shed
            }
            AdmissionOutcome::Rejected { .. } => shed += 1,
        }
    }
    let wall_ms = t0.elapsed().as_secs_f64() * 1000.0;
    // Pemulihan overload: drain in-flight, lalu ukur durasi hingga admission
    // kembali menerima (token bucket route refill — default 200/s; probe unik
    // tiap percobaan agar tidak terkena dedupe).
    while ctrl.in_flight() > 0 {
        ctrl.finish_execution(0);
    }
    let t_rec = Instant::now();
    let mut recovered = false;
    let mut rec_attempts = 0u64;
    let mut rec_reason = String::new();
    let deadline = std::time::Duration::from_secs(2);
    for i in 0..2_000u32 {
        rec_attempts += 1;
        let env = envelope(
            &format!("after-drain-{i}"),
            Some(&format!("after-drain-{i}")),
        );
        match ctrl.admit_probe(env, &reg, 1_700_000_000_300 + i as u64) {
            Ok(AdmissionOutcome::Admitted(_)) => {
                recovered = true;
                break;
            }
            Ok(AdmissionOutcome::Rejected { admission, .. }) => {
                rec_reason = format!("{:?}", admission.state);
            }
            Err(e) => {
                rec_reason = format!("err {e}");
                break;
            }
        }
        if t_rec.elapsed() > deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    let recovery_duration_ms = t_rec.elapsed().as_secs_f64() * 1000.0;
    if recovered && ctrl.in_flight() > 0 {
        ctrl.finish_execution(0);
    }
    let mut s = steady_ns;
    s.sort_unstable();
    let n = s.len() as u64;
    let sum: u64 = s.iter().sum();
    serde_json::json!({
        "name": "burst_overload",
        "issued": issued,
        "admitted": admitted,
        "shed": shed,
        "max_in_flight_seen": max_in_flight,
        "max_in_flight_limit": AdmissionConfig::default().max_in_flight,
        "wall_ms": wall_ms,
        "issued_per_s": (issued as f64) / (wall_ms / 1000.0),
        "admission_recovers_after_drain": recovered,
        "recovery_duration_ms": recovery_duration_ms,
        "recovery_attempts": rec_attempts,
        "recovery_last_reject_state": rec_reason,
        "p50_ns": pxx(&s, 50.0),
        "p95_ns": pxx(&s, 95.0),
        "p99_ns": pxx(&s, 99.0),
        "mean_ns": if n > 0 { sum / n } else { 0 },
        "samples": n,
    })
}

fn bench_normalize() -> (serde_json::Value, serde_json::Value) {
    let limits = NormalizeLimits::default();
    let tiny_body = serde_json::json!({"x":1}).to_string();
    let large_body = format!("{{\"blob\":\"{}\"}}", "A".repeat(64 * 1024));
    let iters = 20_000usize;

    let mut tiny = Vec::with_capacity(iters);
    for i in 0..iters {
        let raw = RawWebhookRequest {
            method: HttpMethod::Post,
            path_and_query: format!("/webhook/tiny?i={i}"),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: tiny_body.clone(),
            content_type: Some("application/json".to_string()),
        };
        let t0 = Instant::now();
        let norm: NormalizedRequest =
            normalize_request(&raw, &limits, 1_700_000_000_000).expect("norm");
        tiny.push(t0.elapsed().as_nanos() as u64);
        std::hint::black_box(norm);
    }
    let mut large = Vec::with_capacity(iters / 4);
    for i in 0..iters / 4 {
        let raw = RawWebhookRequest {
            method: HttpMethod::Post,
            path_and_query: format!("/webhook/large?i={i}"),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: large_body.clone(),
            content_type: Some("application/json".to_string()),
        };
        let t0 = Instant::now();
        let norm = normalize_request(&raw, &limits, 1_700_000_000_000).expect("norm");
        large.push(t0.elapsed().as_nanos() as u64);
        std::hint::black_box(norm);
    }
    (
        stats_json(
            "normalize_tiny_json",
            tiny,
            serde_json::json!({"payload_bytes": 7usize}),
        ),
        stats_json(
            "normalize_large_json_64k",
            large,
            serde_json::json!({"payload_bytes": large_body.len()}),
        ),
    )
}

fn bench_recovery() -> serde_json::Value {
    // journal append + replay
    let mut journal = Journal::new();
    let n = 10_000usize;
    let t0 = Instant::now();
    for i in 0..n {
        journal.append(
            format!("wf-{i}"),
            LifecycleEvent::ActivationStarted,
            Generation::new(1),
            1_700_000_000_000 + i as u64,
        );
    }
    let append_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let t1 = Instant::now();
    let replayed = journal.replay_from(0);
    let replay_us = t1.elapsed().as_micros() as u64;

    // orphan reconcile atas 1000 schedule
    let mut reg = ScheduleRegistry::new();
    let spec = ScheduleSpec {
        node_id: "node-1".to_string(),
        node_name: "N1".to_string(),
        cron: "0 0 * * *".to_string(),
        timezone: "+00:00".to_string(),
        enabled: true,
        misfire: Default::default(),
        overlap: Default::default(),
        jitter_ms: 0,
        deadline_ms: None,
        gap_policy: Default::default(),
    };
    for i in 0..1000 {
        let id = format!("wf-rec-{i}");
        reg.register_workflow(
            wf(&id, 1),
            std::slice::from_ref(&spec),
            ActivationMode::Activate,
            None,
            1_700_000_000_000,
        )
        .expect("register");
        reg.commit_workflow(&id, None, 1_700_000_000_001)
            .expect("commit");
    }
    let t2 = Instant::now();
    let orphans = reg.reconcile_orphans(&[]); // desired kosong → semua orphan
    let reconcile_us = t2.elapsed().as_micros() as u64;
    let t3 = Instant::now();
    let removed = reg.remove_orphans(&[]);
    let cleanup_us = t3.elapsed().as_micros() as u64;

    serde_json::json!({
        "name": "recovery",
        "journal_entries": n,
        "journal_append_total_ms": append_ms,
        "journal_append_per_entry_ns": (append_ms * 1_000_000.0) / n as f64,
        "journal_replay_count": replayed.len(),
        "journal_dropped_by_bound": journal.dropped_entries(),
        "journal_replay_total_us": replay_us,
        "orphan_schedules": orphans.len(),
        "orphan_reconcile_us": reconcile_us,
        "orphan_cleanup_count": removed,
        "orphan_cleanup_us": cleanup_us,
    })
}

fn proc_cpu_ms() -> u64 {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let parts: Vec<&str> = stat.split_whitespace().collect();
    if parts.len() < 15 {
        return 0;
    }
    let utime: u64 = parts[13].parse().unwrap_or(0);
    let stime: u64 = parts[14].parse().unwrap_or(0);
    // CLK_TCK = 100 pada Linux umum
    ((utime + stime) * 1000) / 100
}

fn vm_hwm_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .find(|l| l.starts_with("VmHWM:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

fn environment() -> serde_json::Value {
    let model = std::fs::read_to_string("/proc/cpuinfo")
        .unwrap_or_default()
        .lines()
        .find(|l| l.starts_with("model name"))
        .and_then(|l| l.split(':').nth(1))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0);
    let mem_kb = std::fs::read_to_string("/proc/meminfo")
        .unwrap_or_default()
        .lines()
        .find(|l| l.starts_with("MemTotal:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .unwrap_or_default()
        .trim()
        .to_string();
    serde_json::json!({
        "cpu_model": model,
        "cores": cores,
        "mem_total_kb": mem_kb,
        "kernel": kernel,
        "profile": "release",
        "toolchain": "stable rustc (see `rustc -V` in evidence)",
        "date": "2026-09-24",
        "host": "sandbox reference environment (Asia/Novosibirsk session)",
    })
}

fn main() {
    let cpu0 = proc_cpu_ms();
    let a0 = ALLOC_CALLS.load(Ordering::Relaxed);
    let b0 = ALLOC_BYTES.load(Ordering::Relaxed);

    let atlas_1 = bench_atlas(1, 50_000);
    let atlas_1k = bench_atlas(1_000, 100_000);
    let atlas_4k = bench_atlas(4_096, 100_000); // plafon hard-bound atlas
    let atlas_10k = bench_atlas(10_000, 100_000); // diharapkan AtlasFull (bounded)
    let webhook_1k = bench_webhook_resolve(1_000, 100_000);
    let webhook_10k = bench_webhook_resolve(10_000, 100_000); // fallback authoritative @10K
    let admission = bench_admission_steady(50_000);
    let duplicate = bench_admission_duplicate(50_000);
    let activation = bench_activation(2_000);
    let burst = bench_burst();
    let (tiny, large) = bench_normalize();
    let recovery = bench_recovery();

    let cpu_ms = proc_cpu_ms() - cpu0;
    let allocs = ALLOC_CALLS.load(Ordering::Relaxed) - a0;
    let bytes = ALLOC_BYTES.load(Ordering::Relaxed) - b0;

    let out = serde_json::json!({
        "benchmark": "P4-INGRESS-PERF-1.0",
        "issue": "#99 §T/§U/§W",
        "environment": environment(),
        "route_lookup": { "atlas_1": atlas_1, "atlas_1000": atlas_1k, "atlas_4096_ceiling": atlas_4k, "atlas_10000_bounded": atlas_10k, "webhook_1000": webhook_1k, "webhook_10000_fallback": webhook_10k },
        "admission": { "steady": admission, "duplicate": duplicate },
        "activation": activation,
        "burst": burst,
        "payload": { "tiny": tiny, "large_64k": large },
        "recovery": recovery,
        "resources": {
            "process_cpu_ms_total": cpu_ms,
            "vm_hwm_kb": vm_hwm_kb(),
            "alloc_calls_total": allocs,
            "alloc_bytes_total": bytes,
        },
        "targets": {
            "warm_route_lookup_sub_ms": "p99 < 1_000_000 ns",
            "overload_bounded": "max_in_flight == config.max_in_flight (hard bound)",
            "recovery_bounded": "journal ≤ MAX_JOURNAL_ENTRIES; reconcile deterministic",
        },
    });
    println!("{}", serde_json::to_string_pretty(&out).expect("json"));
}
