#!/usr/bin/env python3
"""Agent 5 — static boundary / dependency / hidden-coupling auditor.

Scans reference/n8n/packages/workflow/src, maps every module to the LEGO that
owns it (per docs/LEGO_PARALLEL_RULES.md), and reports:
  * cross-LEGO edges (DIRECT RUNTIME vs TYPE-ONLY)
  * circular dependencies between LEGOs
  * hidden coupling signals (global state, env vars, filesystem/db access)
  * reference-source integrity: `reference/n8n/` is the upstream TypeScript
    snapshot and must never contain `.rs` files or a `Cargo.toml`. Rust lives
    in the Cargo workspace under `crates/` (Phase 3+), which this audit does
    not police.

Read-only: it never modifies reference source. Exit 1 on undocumented findings.
Run with `--selftest` to exercise the guard and the path mapping on a temp tree.
"""
import os, re, sys, json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "reference", "n8n", "packages", "workflow", "src")
REFERENCE_DIR = os.path.join("reference", "n8n")  # must stay Rust-free in every phase

LEGO_OWNERSHIP = {
    "workflow":       (["workflow.ts"], "Agent 1"),
    "node":           (["node-helpers.ts", "node-validation.ts", "node-parameters",
                        "node-reference-parser-utils.ts"], "Agent 2"),
    "connection":     (["graph/graph-utils.ts", "connections-diff.ts"], "Agent 3"),
    "validation":     (["workflow-validation.ts", "type-validation.ts"], "Agent 4"),
    "expression":     (["expression.ts", "expressions", "extensions",
                        "expression-sandboxing.ts", "expression-evaluator-proxy.ts",
                        "workflow-data-proxy.ts"], "Agent 3 (support)"),
    "execution-data": (["run-execution-data", "run-execution-data-factory.ts",
                        "execution-context.ts", "execution-status.ts"], "Agent 3 (support)"),
    "interfaces":     (["interfaces.ts", "types.d.ts", "schemas.ts"], "shared"),
}
# Cross-LEGO edges accepted as intentional and documented in
# docs/isolation/DEPENDENCY-GRAPH.md. Anything else is a new finding.
ALLOWED_EDGES = {
    ("connection", "interfaces"), ("execution-data", "interfaces"),
    ("execution-data", "shared-util"), ("expression", "execution-data"),
    ("expression", "interfaces"), ("expression", "node"),
    ("expression", "shared-util"), ("expression", "validation"),
    ("expression", "workflow"), ("interfaces", "execution-data"),
    ("interfaces", "shared-util"), ("interfaces", "workflow"),
    ("node", "execution-data"), ("node", "expression"), ("node", "interfaces"),
    ("node", "shared-util"), ("node", "validation"), ("node", "workflow"),
    ("shared-util", "connection"), ("shared-util", "expression"),
    ("shared-util", "interfaces"), ("shared-util", "node"),
    ("validation", "interfaces"), ("validation", "shared-util"),
    ("workflow", "expression"), ("workflow", "interfaces"),
    ("workflow", "node"), ("workflow", "shared-util"),
}

def lego_of(rel):
    norm = rel.replace("\\", "/")  # Windows runners hand back backslashes
    for lego, (paths, _owner) in LEGO_OWNERSHIP.items():
        for p in paths:
            if norm == p or norm.startswith(p + "/"):
                return lego
    return "shared-util"

IMPORT_RE = re.compile(r"import\s+(type\s+)?[\s\S]{0,400}?from\s+'(\.[^']+)'")

def build_graph():
    edges, type_only, evidence = {}, {}, {}
    for dp, _dn, fn in os.walk(SRC):
        for f in fn:
            if not f.endswith(".ts"):
                continue
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, SRC)
            if "__tests__" in rel or rel.endswith(".test.ts"):
                continue
            src_lego = lego_of(rel)
            txt = open(full, encoding="utf8", errors="replace").read()
            for m in IMPORT_RE.finditer(txt):
                is_type = bool(m.group(1))
                tp = os.path.normpath(os.path.join(os.path.dirname(rel), m.group(2)))
                resolved = tp
                for cand in (tp + ".ts", tp + "/index.ts", tp):
                    if os.path.exists(os.path.join(SRC, cand)):
                        resolved = cand
                        break
                if resolved.endswith("/index.ts"):
                    resolved = resolved[: -len("/index.ts")]
                dst_lego = lego_of(resolved)
                if dst_lego == src_lego:
                    continue
                key = (src_lego, dst_lego)
                edges.setdefault(key, 0)
                edges[key] += 1
                type_only[key] = type_only.get(key, True) and is_type
                evidence.setdefault(key, set()).add(rel)
    return edges, type_only, evidence

def find_cycles(adj):
    cycles, stack, state = [], [], {}
    def dfs(n):
        state[n] = 1; stack.append(n)
        for m in sorted(adj.get(n, [])):
            if state.get(m) == 1:
                cycles.append(stack[stack.index(m):] + [m])
            elif state.get(m, 0) == 0:
                dfs(m)
        stack.pop(); state[n] = 2
    for n in sorted(adj):
        if state.get(n, 0) == 0:
            dfs(n)
    return cycles

HIDDEN_PATTERNS = {
    "env-coupling": re.compile(r"process\.env"),
    "global-mutable-state": re.compile(r"getGlobalState\(|setGlobalState\("),
    "filesystem-coupling": re.compile(r"require\('fs'\)|from 'node:fs'|from 'fs'"),
    "database-coupling": re.compile(r"typeorm|DataSource|pg\.Client"),
}

def hidden_coupling():
    hits = {}
    for dp, _dn, fn in os.walk(SRC):
        for f in fn:
            if not f.endswith(".ts"):
                continue
            rel = os.path.relpath(os.path.join(dp, f), SRC)
            if "__tests__" in rel or rel.endswith(".test.ts") or rel.endswith("global-state.ts"):
                continue
            txt = open(os.path.join(dp, f), encoding="utf8", errors="replace").read()
            for kind, rx in HIDDEN_PATTERNS.items():
                for i, line in enumerate(txt.splitlines(), 1):
                    if line.lstrip().startswith(("*", "//")):
                        continue
                    if rx.search(line):
                        hits.setdefault(kind, []).append(f"{rel}:{i}")
    return hits

def rust_guard(root=None):
    """Return the `.rs` / `Cargo.toml` files found inside reference/n8n/ (sorted).

    Reference-source integrity is phase-independent: the upstream snapshot is the
    behavioural oracle of every LEGO and must never receive Rust. Vendored
    node_modules are skipped. Rust under crates/ is the expected Phase-3 state.
    """
    root = root or ROOT
    ref_dir = os.path.join(root, REFERENCE_DIR)
    offenders = []
    if os.path.isdir(ref_dir):
        for dp, _dn, fn in os.walk(ref_dir):
            if "node_modules" in dp.split(os.sep):
                continue
            for f in fn:
                if f.endswith(".rs") or f == "Cargo.toml":
                    offenders.append(os.path.relpath(os.path.join(dp, f), root).replace(os.sep, "/"))
    return sorted(offenders)

def selftest():
    import tempfile, shutil
    tmp = tempfile.mkdtemp(prefix="boundary-audit-selftest-")
    try:
        def touch(rel):
            p = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w", encoding="utf-8").close()
        touch("crates/n8n-workflow/src/lib.rs")
        touch("crates/n8n-workflow/Cargo.toml")
        touch("apps/n8n-ts/src/server.ts")
        touch("reference/n8n/packages/workflow/src/workflow.ts")
        touch("reference/n8n/node_modules/vendored/Cargo.toml")   # vendored, ignored

        checks = []
        checks.append(("Rust under crates/ is allowed (Phase 3 workspace)", rust_guard(tmp) == [], str(rust_guard(tmp))))
        touch("reference/n8n/packages/core/native.rs")
        touch("reference/n8n/packages/core/Cargo.toml")
        got = rust_guard(tmp)
        checks.append(("Rust inside reference/n8n is flagged, node_modules ignored",
                       got == ["reference/n8n/packages/core/Cargo.toml", "reference/n8n/packages/core/native.rs"], str(got)))
        checks.append(("missing reference dir yields no offenders (missing SRC is reported by main())",
                       rust_guard(os.path.join(tmp, "nowhere")) == [], "unexpected offenders"))
        checks.append(("lego_of normalises Windows separators",
                       lego_of("graph\\graph-utils.ts") == "connection" and lego_of("workflow.ts") == "workflow",
                       f"{lego_of('graph\\graph-utils.ts')} / {lego_of('workflow.ts')}"))

        failed = 0
        for name, ok, detail in checks:
            print(f"[{'PASS' if ok else 'FAIL'}] {name}" + ("" if ok else f" -> {detail}"))
            failed += 0 if ok else 1
        print(f"SELFTEST: {len(checks) - failed}/{len(checks)} passed")
        return 1 if failed else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

def main():
    if "--selftest" in sys.argv[1:]:
        return selftest()
    if not os.path.isdir(SRC):
        print(f"[FAIL] reference source missing: {SRC}")
        return 1
    edges, type_only, evidence = build_graph()
    print("=== [AGENT 5] BOUNDARY & DEPENDENCY AUDIT ===\n")
    print("-- Cross-LEGO dependency edges --")
    undocumented = []
    for (s, d), n in sorted(edges.items()):
        kind = "TYPE-ONLY" if type_only[(s, d)] else "DIRECT RUNTIME"
        flag = "" if (s, d) in ALLOWED_EDGES else "  <== UNDOCUMENTED"
        if flag:
            undocumented.append((s, d))
        ev = sorted(evidence[(s, d)])[:2]
        print(f"  {s:>14} -> {d:<14} [{kind}] x{n}  e.g. {ev}{flag}")

    adj = {}
    for (s, d) in edges:
        adj.setdefault(s, set()).add(d)
    cycles = find_cycles(adj)
    print(f"\n-- Circular dependencies: {len(cycles)} cycle(s) --")
    for c in cycles[:12]:
        print("  " + " -> ".join(c))

    print("\n-- Hidden coupling signals --")
    hits = hidden_coupling()
    if not hits:
        print("  none")
    for kind, locs in sorted(hits.items()):
        print(f"  {kind}: {len(locs)} hit(s) e.g. {locs[:3]}")

    offenders = rust_guard()
    print(f"\n-- Reference-source integrity guard: {'CONTAMINATION ' + str(offenders) if offenders else 'clean (no .rs / Cargo.toml in reference/)'}")

    print("\n-------------------------------------------------------")
    failed = bool(undocumented) or bool(offenders)
    if undocumented:
        print(f"BOUNDARY VIOLATION: {len(undocumented)} undocumented edge(s): {undocumented}")
    if offenders:
        print(f"REFERENCE CONTAMINATION: Rust introduced inside reference/ ({len(offenders)} file(s))")
    print("AUDIT RESULT:", "FAIL" if failed else "PASS (all edges documented)")
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
