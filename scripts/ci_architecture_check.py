#!/usr/bin/env python3
"""
CI Architecture Enforcer for n8n-lego-rust-v1 monorepo.
Validates the canonical LEGO -> Sub-LEGO -> Port architecture invariants.

Invariants checked:
1. docs/migration/LEGO-SUBLEGO-REGISTRY.yaml and docs/migration/LEGO-SUBLEGO-REGISTRY.json
   are valid, parse cleanly, and contain exactly 83 Sub-LEGOs with matching metadata.
2. The Sub-LEGO dependency graph is strictly a Directed Acyclic Graph (DAG) with zero cycles.
3. No orphan required ports: every required port has exactly 1 declared provider.
4. Unambiguous state ownership: every non-stateless state domain is owned by exactly 1 Sub-LEGO.
5. Physical presence: every Sub-LEGO has a canonical folder in lego/ containing CONTRACT.md and a ports/ directory.
6. Strict boundary isolation: no private cross-Sub-LEGO imports inside lego/ (only public contracts and ports).
7. Staged taxonomy ladder & zero-certified floor: enforces strict progression
   (DESIGNED -> CONTRACTED -> IMPLEMENTED -> TESTED -> CERTIFIED) and guarantees 0 overclaimed CERTIFIED capabilities.

Exit Code:
  0 - All architectural invariants PASS
  1 - One or more invariants FAIL
"""

import sys
import os
import json
import re
from typing import Dict, List, Set, Tuple, Any

try:
    import yaml
except ImportError:
    print("[ERROR] PyYAML is not installed. Please install it via 'pip install pyyaml'.")
    sys.exit(1)


# Color codes for terminal output
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
BLUE = "\033[94m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"


class ArchitectureCheckResult:
    def __init__(self, name: str):
        self.name = name
        self.passed = True
        self.messages: List[str] = []
        self.errors: List[str] = []

    def log(self, msg: str):
        self.messages.append(msg)

    def error(self, err: str):
        self.passed = False
        self.errors.append(err)


class CIArchitectureEnforcer:
    def __init__(self, workspace_root: str):
        self.root = workspace_root
        self.yaml_path = os.path.join(self.root, "docs", "migration", "LEGO-SUBLEGO-REGISTRY.yaml")
        self.json_path = os.path.join(self.root, "docs", "migration", "LEGO-SUBLEGO-REGISTRY.json")
        self.lego_dir = os.path.join(self.root, "lego")

        self.yaml_data: Dict[str, Any] = {}
        self.json_data: Dict[str, Any] = {}
        self.sublegos: Dict[str, Dict[str, Any]] = {}
        self.providers: Dict[str, str] = {}  # port_id -> sublego_id
        self.duplicate_providers: Dict[str, List[str]] = {}

    def run_all_checks(self) -> bool:
        print(f"\n{BOLD}{CYAN}{'='*78}{RESET}")
        print(f"{BOLD}{CYAN}      LEGO ARCHITECTURE CI ENFORCEMENT & QUALITY FLOOR AUDIT{RESET}")
        print(f"{BOLD}{CYAN}{'='*78}{RESET}\n")

        checks = [
            ("1. Registry Validity & 83 Sub-LEGO Count", self.check_registry_validity),
            ("2. Dependency Graph Acyclicity (DAG Enforcement)", self.check_dag_acyclicity),
            ("3. Port Binding & Orphan Required Port Check", self.check_orphan_ports),
            ("4. State Ownership Uniqueness & Boundary", self.check_state_ownership),
            ("5. Physical Sub-LEGO Presence (CONTRACT.md & ports/)", self.check_physical_presence),
            ("6. Private Cross-Sub-LEGO Import Isolation", self.check_cross_sublego_imports),
            ("7. Staged Taxonomy Ladder & Zero-Certified Floor Audit", self.check_taxonomy_and_quality_floor),
        ]

        overall_pass = True
        results: List[ArchitectureCheckResult] = []

        for title, check_func in checks:
            print(f"{BOLD}Running Check: {title}...{RESET}")
            res = ArchitectureCheckResult(title)
            try:
                check_func(res)
            except Exception as e:
                res.error(f"Unexpected exception during check: {e}")

            results.append(res)
            if not res.passed:
                overall_pass = False
                print(f"  {RED}[FAIL]{RESET} {title}")
                for err in res.errors:
                    print(f"    {RED}x {err}{RESET}")
            else:
                print(f"  {GREEN}[PASS]{RESET} {title}")
                for msg in res.messages:
                    print(f"    {msg}")
            print()

        self._print_summary(overall_pass, results)
        return overall_pass

    def check_registry_validity(self, res: ArchitectureCheckResult):
        """Check 1: Both YAML and JSON exist, parse cleanly, and have exactly 83 Sub-LEGOs."""
        # Check files exist
        if not os.path.isfile(self.yaml_path):
            res.error(f"Missing registry YAML file at: {self.yaml_path}")
            return
        if not os.path.isfile(self.json_path):
            res.error(f"Missing registry JSON file at: {self.json_path}")
            return

        # Parse YAML
        try:
            with open(self.yaml_path, "r", encoding="utf-8") as f:
                self.yaml_data = yaml.safe_load(f)
        except Exception as e:
            res.error(f"YAML parsing failed on {self.yaml_path}: {e}")
            return

        # Parse JSON
        try:
            with open(self.json_path, "r", encoding="utf-8") as f:
                self.json_data = json.load(f)
        except Exception as e:
            res.error(f"JSON parsing failed on {self.json_path}: {e}")
            return

        # Extract sublegos from JSON
        json_sublegos = {}
        for lego_id, lego_data in self.json_data.get("legos", {}).items():
            for sub_id, sub_data in lego_data.get("sublegos", {}).items():
                json_sublegos[sub_data["id"]] = sub_data

        # Extract sublegos from YAML
        yaml_sublegos = {}
        for lego_id, lego_data in self.yaml_data.get("legos", {}).items():
            for sub_id, sub_data in lego_data.get("sublegos", {}).items():
                yaml_sublegos[sub_data["id"]] = sub_data

        res.log(f"Extracted {len(json_sublegos)} Sub-LEGOs from JSON.")
        res.log(f"Extracted {len(yaml_sublegos)} Sub-LEGOs from YAML.")

        if len(json_sublegos) != 83:
            res.error(f"Expected exactly 83 Sub-LEGOs in JSON, found {len(json_sublegos)}")

        if len(yaml_sublegos) != 83:
            res.error(f"Expected exactly 83 Sub-LEGOs in YAML, found {len(yaml_sublegos)}")

        # Verify exact key match between YAML and JSON
        missing_in_yaml = set(json_sublegos.keys()) - set(yaml_sublegos.keys())
        missing_in_json = set(yaml_sublegos.keys()) - set(json_sublegos.keys())
        if missing_in_yaml:
            res.error(f"Sub-LEGOs present in JSON but missing in YAML: {sorted(missing_in_yaml)}")
        if missing_in_json:
            res.error(f"Sub-LEGOs present in YAML but missing in JSON: {sorted(missing_in_json)}")

        # Check critical fields consistency
        for s_id, s_json in json_sublegos.items():
            s_yaml = yaml_sublegos.get(s_id)
            if not s_yaml:
                continue
            if s_json.get("canonical_path") != s_yaml.get("canonical_path"):
                res.error(f"Path mismatch for {s_id}: JSON='{s_json.get('canonical_path')}' vs YAML='{s_yaml.get('canonical_path')}'")
            if s_json.get("status") != s_yaml.get("status"):
                res.error(f"Status mismatch for {s_id}: JSON='{s_json.get('status')}' vs YAML='{s_yaml.get('status')}'")

        self.sublegos = json_sublegos
        res.log("Registry JSON and YAML are perfectly synchronized with exactly 83 Sub-LEGOs.")

    def check_dag_acyclicity(self, res: ArchitectureCheckResult):
        """Check 2: Dependency graph formed by port bindings is strictly a DAG (no cycles)."""
        if not self.sublegos:
            res.error("Sub-LEGO registry not populated.")
            return

        # Build port provider mapping
        self.providers = {}
        self.duplicate_providers = {}
        for s_id, s_data in self.sublegos.items():
            for p in s_data.get("ports", {}).get("provided", []):
                if p in self.providers:
                    if p not in self.duplicate_providers:
                        self.duplicate_providers[p] = [self.providers[p]]
                    self.duplicate_providers[p].append(s_id)
                self.providers[p] = s_id

        # Build dependency adjacency graph: consumer -> set(providers)
        adj: Dict[str, Set[str]] = {s_id: set() for s_id in self.sublegos}
        for s_id, s_data in self.sublegos.items():
            for req in s_data.get("ports", {}).get("required", []):
                provider_id = self.providers.get(req)
                if provider_id and provider_id != s_id:
                    adj[s_id].add(provider_id)

        # Cycle detection using DFS with coloring
        # 0 = UNVISITED, 1 = VISITING, 2 = VISITED
        visited: Dict[str, int] = {s_id: 0 for s_id in self.sublegos}
        cycles: List[List[str]] = []

        def dfs(node: str, path: List[str]):
            visited[node] = 1
            for neighbor in sorted(adj[node]):
                if visited[neighbor] == 1:
                    cycle_start = path.index(neighbor)
                    cycles.append(path[cycle_start:] + [neighbor])
                elif visited[neighbor] == 0:
                    dfs(neighbor, path + [neighbor])
            visited[node] = 2

        for s_id in sorted(self.sublegos.keys()):
            if visited[s_id] == 0:
                dfs(s_id, [s_id])

        if cycles:
            res.error(f"Detected {len(cycles)} cycle(s) in Sub-LEGO dependency graph:")
            for cycle in cycles:
                res.error("  Cycle: " + " -> ".join(cycle))
        else:
            total_edges = sum(len(neighbors) for neighbors in adj.values())
            res.log(f"Dependency graph verified as DAG: 83 nodes, {total_edges} dependency edges, 0 cycles.")

    def check_orphan_ports(self, res: ArchitectureCheckResult):
        """Check 3: No orphan required ports and no duplicate providers."""
        if not self.sublegos or not self.providers:
            res.error("Registry or port providers not populated.")
            return

        # Check duplicate providers
        if self.duplicate_providers:
            for p, provs in self.duplicate_providers.items():
                res.error(f"Duplicate port provider: port '{p}' provided by multiple Sub-LEGOs: {provs}")

        # Check orphan required ports
        orphan_ports: List[Tuple[str, str]] = []
        total_required_bindings = 0

        for s_id, s_data in self.sublegos.items():
            for req in s_data.get("ports", {}).get("required", []):
                total_required_bindings += 1
                if req not in self.providers:
                    orphan_ports.append((s_id, req))

        if orphan_ports:
            res.error(f"Detected {len(orphan_ports)} orphan required port(s):")
            for consumer, port in orphan_ports:
                res.error(f"  Consumer '{consumer}' requires unknown port '{port}'")
        else:
            total_provided = len(self.providers)
            res.log(f"All {total_required_bindings} required port bindings resolved to exactly 1 provider.")
            res.log(f"Total provided unique ports across system: {total_provided}.")

    def check_state_ownership(self, res: ArchitectureCheckResult):
        """Check 4: State ownership is unambiguous and unique (stateless is allowed to be shared)."""
        if not self.sublegos:
            res.error("Registry not populated.")
            return

        state_to_owner: Dict[str, str] = {}
        conflicts: List[Tuple[str, str, str]] = []
        stateless_count = 0

        for s_id, s_data in self.sublegos.items():
            state = s_data.get("state_ownership", "").strip()
            if not state:
                res.error(f"Sub-LEGO {s_id} has empty state_ownership definition.")
                continue

            if state == "stateless":
                stateless_count += 1
                continue

            if state in state_to_owner:
                conflicts.append((state, state_to_owner[state], s_id))
            else:
                state_to_owner[state] = s_id

        if conflicts:
            res.error(f"Detected {len(conflicts)} duplicate state ownership conflict(s):")
            for st, owner1, owner2 in conflicts:
                res.error(f"  State '{st}' claimed by both '{owner1}' and '{owner2}'")
        else:
            res.log(f"State ownership verified: {len(state_to_owner)} unique state domains, {stateless_count} stateless Sub-LEGOs.")

    def check_physical_presence(self, res: ArchitectureCheckResult):
        """Check 5: Every Sub-LEGO across stages has folder, CONTRACT.md, and ports/."""
        if not self.sublegos:
            res.error("Registry not populated.")
            return

        missing_folders: List[str] = []
        missing_contracts: List[str] = []
        missing_ports_dirs: List[str] = []
        empty_contracts: List[str] = []
        qualified_count = 0

        for s_id, s_data in self.sublegos.items():
            status = s_data.get("status", "")
            if status in ("DESIGNED", "CONTRACTED", "IMPLEMENTED", "TESTED", "CERTIFIED"):
                qualified_count += 1
                rel_path = s_data.get("canonical_path", "")
                abs_dir = os.path.join(self.root, rel_path)
                contract_path = os.path.join(abs_dir, "CONTRACT.md")
                ports_path = os.path.join(abs_dir, "ports")

                if not os.path.isdir(abs_dir):
                    missing_folders.append(f"{s_id} ({rel_path})")
                    continue

                if not os.path.isfile(contract_path):
                    missing_contracts.append(f"{s_id} ({contract_path})")
                else:
                    if os.path.getsize(contract_path) == 0:
                        empty_contracts.append(f"{s_id} ({contract_path})")

                if not os.path.isdir(ports_path):
                    missing_ports_dirs.append(f"{s_id} ({ports_path})")

        if missing_folders:
            res.error(f"Missing canonical folders for {len(missing_folders)} Sub-LEGOs: {missing_folders[:5]}")
        if missing_contracts:
            res.error(f"Missing CONTRACT.md for {len(missing_contracts)} Sub-LEGOs: {missing_contracts[:5]}")
        if empty_contracts:
            res.error(f"Empty CONTRACT.md for {len(empty_contracts)} Sub-LEGOs: {empty_contracts[:5]}")
        if missing_ports_dirs:
            res.error(f"Missing ports/ directory for {len(missing_ports_dirs)} Sub-LEGOs: {missing_ports_dirs[:5]}")

        if not (missing_folders or missing_contracts or empty_contracts or missing_ports_dirs):
            res.log(f"All {qualified_count} Sub-LEGOs across all stages have valid physical canonical folders, CONTRACT.md, and ports/.")

    def check_cross_sublego_imports(self, res: ArchitectureCheckResult):
        """Check 6: No private cross-Sub-LEGO imports in lego/ directory."""
        if not os.path.isdir(self.lego_dir):
            res.error(f"lego/ directory not found at: {self.lego_dir}")
            return

        illegal_imports: List[Tuple[str, int, str, str]] = []

        # Patterns of forbidden cross-sublego private imports:
        # 1. Rust: #[path = "..."] crossing out of sublego root into another sublego implementation
        # 2. Rust: use ... referencing another sublego's internal or implementation directly
        # 3. TS/JS: import/require relative paths targeting another sublego's internal/implementation

        rust_use_pattern = re.compile(r'^\s*use\s+([^;]+);')
        rust_path_attr = re.compile(r'#\[path\s*=\s*"([^"]+)"\]')
        js_import_pattern = re.compile(r'(?:import|from|require\()\s*[\'"]([^\'"]+)[\'"]')

        source_extensions = ('.rs', '.ts', '.js', '.mjs')

        scanned_files = 0
        for root, dirs, files in os.walk(self.lego_dir):
            # Determine which sublego root this file belongs to
            rel_root = os.path.relpath(root, self.lego_dir)
            parts = rel_root.replace("\\", "/").split("/")
            # Typically parts are [Lxx-slug, Syy-slug, ...]
            current_sublego_slug = parts[1] if len(parts) >= 2 else None

            for f in files:
                if f.endswith(source_extensions):
                    scanned_files += 1
                    file_path = os.path.join(root, f)
                    rel_file = os.path.relpath(file_path, self.root)

                    try:
                        with open(file_path, "r", encoding="utf-8", errors="ignore") as src:
                            for line_idx, line in enumerate(src, 1):
                                stripped = line.strip()
                                if stripped.startswith("//") or stripped.startswith("/*"):
                                    continue

                                # Check Rust path attribute
                                m_path = rust_path_attr.search(line)
                                if m_path:
                                    target = m_path.group(1)
                                    if ".." in target and ("implementation" in target or "src" in target):
                                        illegal_imports.append((rel_file, line_idx, stripped, "Forbidden cross-sublego path attribute"))

                                # Check Rust use statements
                                m_use = rust_use_pattern.search(line)
                                if m_use:
                                    imported = m_use.group(1)
                                    # Forbidden: importing private internals of another sublego
                                    # e.g., use crate::lego::L01...::implementation
                                    if "lego::" in imported and ("::implementation" in imported or "::internal" in imported):
                                        illegal_imports.append((rel_file, line_idx, stripped, "Forbidden private sublego import"))

                                # Check JS/TS imports
                                m_js = js_import_pattern.search(line)
                                if m_js:
                                    target = m_js.group(1)
                                    if target.startswith("..") and ("/implementation" in target or "/internal" in target or "/src" in target):
                                        illegal_imports.append((rel_file, line_idx, stripped, "Forbidden relative private cross-import"))

                    except Exception as e:
                        res.error(f"Error reading file {rel_file}: {e}")

        if illegal_imports:
            res.error(f"Detected {len(illegal_imports)} illegal private cross-Sub-LEGO import(s):")
            for path, line_no, content, reason in illegal_imports:
                res.error(f"  {path}:{line_no}: '{content}' ({reason})")
        else:
            res.log(f"Scanned {scanned_files} source files in lego/: 0 private cross-Sub-LEGO imports detected (100% isolated).")

    def check_taxonomy_and_quality_floor(self, res: ArchitectureCheckResult):
        """Check 7: Enforce staged taxonomy ladder and guarantee zero overclaimed CERTIFIED Sub-LEGOs."""
        if not self.sublegos:
            res.error("Registry not populated.")
            return

        valid_ladder = ["DESIGNED", "CONTRACTED", "IMPLEMENTED", "TESTED", "CERTIFIED"]
        valid_statuses = set(valid_ladder)

        # 1. Check all statuses belong to valid ladder stages
        invalid_statuses: List[Tuple[str, str]] = []
        status_counts = {st: 0 for st in valid_ladder}
        for s_id, s_data in self.sublegos.items():
            status = s_data.get("status", "")
            if status not in valid_statuses:
                invalid_statuses.append((s_id, status))
            else:
                status_counts[status] += 1

        if invalid_statuses:
            res.error(f"Detected {len(invalid_statuses)} Sub-LEGO(s) with invalid status not in ladder {valid_ladder}:")
            for s_id, bad_status in invalid_statuses:
                res.error(f"  {s_id}: '{bad_status}'")

        # 2. Strict Quality Floor: No capability certified yet on production host
        # Rule: 83 Sub-LEGOs does NOT mean 83 certified!
        if status_counts["CERTIFIED"] > 0:
            res.error(f"CRITICAL QUALITY FLOOR VIOLATION: Overclaim detected! {status_counts['CERTIFIED']} Sub-LEGO(s) marked CERTIFIED. Expected exactly 0 (no capability is fully certified on production host yet).")

        # 3. Exact taxonomy distribution enforcement
        expected_counts = {
            "CERTIFIED": 0,
            "TESTED": 10,
            "IMPLEMENTED": 21,
            "CONTRACTED": 44,
            "DESIGNED": 8,
        }

        for st, expected in expected_counts.items():
            actual = status_counts[st]
            if actual != expected:
                res.error(f"Taxonomy count mismatch for status '{st}': expected {expected}, found {actual}")

        # 4. Verify 10 priority Sub-LEGOs are exactly the ones marked TESTED
        priority_tested_ids = {
            "L00.S01", "L00.S02", "L00.S03", "L00.S04",
            "L01.S01", "L01.S04", "L02.S04", "L03.S01",
            "L05.S02", "L06.S01"
        }
        actual_tested_ids = {s_id for s_id, s_data in self.sublegos.items() if s_data.get("status") == "TESTED"}

        missing_tested = priority_tested_ids - actual_tested_ids
        unexpected_tested = actual_tested_ids - priority_tested_ids

        if missing_tested:
            res.error(f"Missing priority Sub-LEGO(s) from TESTED status: {sorted(missing_tested)}")
        if unexpected_tested:
            res.error(f"Unexpected Sub-LEGO(s) marked TESTED (not in 10 priority list): {sorted(unexpected_tested)}")

        # 5. Verify 8 DESIGNED Sub-LEGOs belong to L11 Future Platform
        expected_designed_ids = {f"L11.S0{i}" for i in range(1, 9)}
        actual_designed_ids = {s_id for s_id, s_data in self.sublegos.items() if s_data.get("status") == "DESIGNED"}
        if actual_designed_ids != expected_designed_ids:
            res.error(f"DESIGNED status mismatch: expected L11.S01-L11.S08, found {sorted(actual_designed_ids)}")

        # Log details if passed
        if res.passed:
            res.log(f"Taxonomy ladder enforced: DESIGNED -> CONTRACTED -> IMPLEMENTED -> TESTED -> CERTIFIED")
            res.log(f"Taxonomy breakdown: CERTIFIED={status_counts['CERTIFIED']}, TESTED={status_counts['TESTED']}, IMPLEMENTED={status_counts['IMPLEMENTED']}, CONTRACTED={status_counts['CONTRACTED']}, DESIGNED={status_counts['DESIGNED']}")
            res.log(f"Quality floor verified: Exactly 0 individual Sub-LEGOs overclaimed as CERTIFIED.")
            res.log(f"Priority floor verified: Exactly 10 priority Sub-LEGOs verified at TESTED status.")

    def _print_summary(self, overall_pass: bool, results: List[ArchitectureCheckResult]):
        print(f"{BOLD}{CYAN}{'='*78}{RESET}")
        print(f"{BOLD}{CYAN}                      CI ARCHITECTURE AUDIT SUMMARY{RESET}")
        print(f"{BOLD}{CYAN}{'='*78}{RESET}")

        for res in results:
            status_str = f"{GREEN}PASS{RESET}" if res.passed else f"{RED}FAIL{RESET}"
            print(f"  * {res.name:<58} : [{status_str}]")

        print(f"{BOLD}{CYAN}{'-'*78}{RESET}")
        if overall_pass:
            print(f"  {BOLD}{GREEN}OVERALL STATUS: ARCHITECTURAL INTEGRITY PASS (Exit Code 0){RESET}")
            print(f"  {GREEN}Taxonomy ladder enforced: 0 CERTIFIED (zero overclaim), 10 TESTED, 21 IMPLEMENTED, 44 CONTRACTED, 8 DESIGNED.{RESET}")
            print(f"  {GREEN}All LEGO architecture boundaries, ports, contracts, and DAG invariants are intact.{RESET}")
        else:
            print(f"  {BOLD}{RED}OVERALL STATUS: REJECTED / AUDIT FAILED (Exit Code 1){RESET}")
            print(f"  {RED}Please resolve the reported architectural or taxonomy violations before committing or merging.{RESET}")
        print(f"{BOLD}{CYAN}{'='*78}{RESET}\n")


def main():
    workspace = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    enforcer = CIArchitectureEnforcer(workspace)
    success = enforcer.run_all_checks()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
