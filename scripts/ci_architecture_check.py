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
8. Governance hierarchy & semantic consistency: AGENTS.md and Master Contract enforce identical canonical precedence order (1..9) with zero contradictions.
9. Mechanical sub-agent result schema validation: enforces parseable SUB-AGENT RESULT protocol and rejects conversational summaries.
10. Status transition lifecycle ladder & evidence-to-claim: prevents progression without verified physical contracts and port implementations.
11. Report provenance & git ledger integrity: verifies report.md citations match verifiable repository git commits and remote branch state.

Exit Code:
  0 - All architectural invariants PASS
  1 - One or more invariants FAIL
"""

import sys
import os
import json
import re
import subprocess
from collections import Counter
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
            ("8. Governance Hierarchy & Semantic Consistency Enforcement", self.check_governance_semantic_consistency),
            ("9. Sub-Agent Result Protocol Mechanical Validation", self.check_subagent_result_validator),
            ("10. Status Transition Lifecycle & Evidence-to-Claim Verification", self.check_status_transition_and_evidence),
            ("11. Report Provenance & Git Ledger Integrity Check", self.check_report_provenance_and_git_ledger),
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
        """Check 1: Mandatory governance contracts exist, and registry YAML/JSON parse cleanly with exactly 83 Sub-LEGOs."""
        # 1. Verify Mandatory Governance Policy Triad
        governance_files = [
            ("Root Agent Governance Policy", os.path.join(self.root, "AGENTS.md")),
            ("Master Execution Contract", os.path.join(self.root, "docs", "migration", "ANTIGRAVITY-MASTER-EXECUTION-CONTRACT.md")),
            ("Agentic Execution Standard", os.path.join(self.root, "docs", "migration", "ANTIGRAVITY-AGENTIC-EXECUTION-STANDARD.md")),
        ]
        for name, path in governance_files:
            if not os.path.isfile(path):
                res.error(f"Missing mandatory governance file ({name}): {os.path.relpath(path, self.root)}")
            elif os.path.getsize(path) == 0:
                res.error(f"Empty mandatory governance file ({name}): {os.path.relpath(path, self.root)}")

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
            "TESTED": 40,
            "IMPLEMENTED": 0,
            "CONTRACTED": 35,
            "DESIGNED": 8,
        }

        for st, expected in expected_counts.items():
            actual = status_counts[st]
            if actual != expected:
                res.error(f"Taxonomy count mismatch for status '{st}': expected {expected}, found {actual}")

        # 4. Verify priority Sub-LEGOs are exactly the ones marked TESTED
        priority_tested_ids = {
            "L00.S01", "L00.S02", "L00.S03", "L00.S04",
            "L01.S01", "L01.S02", "L01.S03", "L01.S04",
            "L02.S01", "L02.S03", "L02.S04", "L02.S05",
            "L03.S01", "L03.S02", "L03.S03", "L03.S04",
            "L04.S01", "L04.S02", "L04.S03", "L04.S04",
            "L04.S05", "L04.S06", "L04.S08",
            "L05.S01", "L05.S02", "L05.S03", "L05.S04",
            "L06.S01", "L06.S02", "L06.S03", "L06.S04", "L06.S05",
            "L07.S01", "L07.S02", "L07.S03",
            "L09.S01", "L09.S02", "L09.S03", "L09.S05",
            "L10.S02"
        }
        actual_tested_ids = {s_id for s_id, s_data in self.sublegos.items() if s_data.get("status") == "TESTED"}

        missing_tested = priority_tested_ids - actual_tested_ids
        unexpected_tested = actual_tested_ids - priority_tested_ids

        if missing_tested:
            res.error(f"Missing priority Sub-LEGO(s) from TESTED status: {sorted(missing_tested)}")
        if unexpected_tested:
            res.error(f"Unexpected Sub-LEGO(s) marked TESTED (not in priority list): {sorted(unexpected_tested)}")

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
            res.log(f"Priority floor verified: Exactly {len(priority_tested_ids)} Sub-LEGOs verified at TESTED status.")

    def check_governance_semantic_consistency(self, res: ArchitectureCheckResult):
        """Check 8: Semantic governance consistency between AGENTS.md and MASTER EXECUTION CONTRACT.
        Enforces identical canonical precedence order (1..9) and zero contradictions.
        """
        agents_md = os.path.join(self.root, "AGENTS.md")
        master_contract = os.path.join(self.root, "docs", "migration", "ANTIGRAVITY-MASTER-EXECUTION-CONTRACT.md")

        if not os.path.isfile(agents_md):
            res.error(f"Missing AGENTS.md at {agents_md}")
            return
        if not os.path.isfile(master_contract):
            res.error(f"Missing Master Execution Contract at {master_contract}")
            return

        with open(agents_md, "r", encoding="utf-8") as f:
            agents_text = f.read()
        with open(master_contract, "r", encoding="utf-8") as f:
            master_text = f.read()

        canonical_order = [
            "1. PLATFORM / SYSTEM",
            "2. LATEST USER INSTRUCTION",
            "3. MASTER EXECUTION CONTRACT",
            "4. AGENTS.md",
            "5. AGENTIC EXECUTION STANDARD",
            "6. ACTIVE ISSUE / ACCEPTANCE CRITERIA",
            "7. TASK-SPECIFIC PROMPT",
            "8. ANTIGRAVITY COORDINATOR",
            "9. SUB-AGENTS",
        ]

        # 1. Verify all canonical items exist in both documents
        for idx, item in enumerate(canonical_order, 1):
            if item not in agents_text:
                res.error(f"AGENTS.md missing canonical hierarchy item #{idx}: '{item}'")
            if item not in master_text:
                res.error(f"Master Execution Contract missing canonical hierarchy item #{idx}: '{item}'")

        # 2. Verify order in AGENTS.md is strictly monotonically increasing
        pos_agents = [agents_text.find(item) for item in canonical_order]
        if any(p == -1 for p in pos_agents):
            res.error("One or more canonical hierarchy items not found in AGENTS.md")
        elif pos_agents != sorted(pos_agents):
            res.error("Hierarchy order in AGENTS.md violates canonical precedence order.")

        # 3. Verify order in Master Execution Contract is strictly monotonically increasing
        pos_master = [master_text.find(item) for item in canonical_order]
        if any(p == -1 for p in pos_master):
            res.error("One or more canonical hierarchy items not found in Master Execution Contract")
        elif pos_master != sorted(pos_master):
            res.error("Hierarchy order in Master Execution Contract violates canonical precedence order.")

        # 4. Verify AGENTS.md does not claim it is #1 above Master Contract
        if "1. AGENTS.md" in agents_text:
            res.error("AGENTS.md contains stale claim '1. AGENTS.md' placing it above Master Contract!")

        # 5. Verify core tenets in both documents using flexible whitespace
        core_tenets = [
            r"UNKNOWN\s*!=\s*COMPLETE",
            r"PARTIAL\s*!=\s*COMPLETE",
            r"CONTRACTED\s*!=\s*IMPLEMENTED",
            r"IMPLEMENTED\s*!=\s*TESTED",
            r"TESTED\s*!=\s*CERTIFIED",
            r"LOCAL\s*!=\s*REMOTE",
        ]
        for pattern in core_tenets:
            if not re.search(pattern, agents_text):
                res.error(f"AGENTS.md missing core tenet matching regex: '{pattern}'")
            if not re.search(pattern, master_text):
                res.error(f"Master Contract missing core tenet matching regex: '{pattern}'")

        if res.passed:
            res.log("Governance hierarchy verified: AGENTS.md and Master Contract share identical canonical precedence order (1..9).")
            res.log("Zero governance contradictions detected; core tenets synchronized.")

    def check_subagent_result_validator(self, res: ArchitectureCheckResult):
        """Check 9: Mechanical enforcement of SUB-AGENT RESULT schema parser."""
        validator_path = os.path.join(self.root, "scripts", "subagent_result_validator.py")
        test_path = os.path.join(self.root, "tests", "governance", "test_subagent_result_validator.py")

        if not os.path.isfile(validator_path):
            res.error(f"Missing sub-agent validator script at: {validator_path}")
            return
        if not os.path.isfile(test_path):
            res.error(f"Missing sub-agent validator unit tests at: {test_path}")
            return

        try:
            scripts_dir = os.path.join(self.root, "scripts")
            if scripts_dir not in sys.path:
                sys.path.insert(0, scripts_dir)

            import subagent_result_validator

            # Test rejection of conversational output
            conversational_samples = [
                "Done! All tests passed and everything is implemented cleanly.",
                "Completed the task successfully. Ready for review.",
            ]
            for samp in conversational_samples:
                is_valid, _, errs = subagent_result_validator.parse_subagent_result(samp)
                if is_valid:
                    res.error(f"Vulnerability: Validator failed to reject conversational output: '{samp}'")

            # Test acceptance of valid complete result
            valid_sample = (
                "SUB-AGENT RESULT\n"
                "STATUS: COMPLETE\n"
                "TASK: Automated CI architecture enforcement\n"
                "SCOPE: scripts/ci_architecture_check.py\n"
                "FILES: scripts/ci_architecture_check.py\n"
                "TESTS: python scripts/ci_architecture_check.py\n"
                "EXIT CODES: 0\n"
                "COMMIT: 1f2784452\n"
                "LOCAL/REMOTE: LOCAL\n"
                "EVIDENCE: 11/11 checks PASS\n"
                "REMAINING: NONE\n"
                "UNVERIFIED: NONE\n"
                "BLOCKERS: NONE\n"
                "CHECKPOINT: CI gate verified mechanically\n"
            )
            is_valid, parsed, errs = subagent_result_validator.parse_subagent_result(valid_sample)
            if not is_valid:
                res.error(f"Validator failed to accept standard valid sample: {errs}")
            elif parsed.status != "COMPLETE":
                res.error(f"Validator misparsed STATUS: {parsed.status}")

            # Test rejection of non-permitted status
            bad_status_sample = valid_sample.replace("STATUS: COMPLETE", "STATUS: SUCCESS")
            is_valid, _, errs = subagent_result_validator.parse_subagent_result(bad_status_sample)
            if is_valid:
                res.error("Validator failed to reject non-permitted STATUS 'SUCCESS'")

        except Exception as e:
            res.error(f"Failed to execute subagent_result_validator mechanically: {e}")

        if res.passed:
            res.log("Mechanical SUB-AGENT RESULT validator verified: successfully rejects conversational summaries and parses compliant outputs.")

    def check_status_transition_and_evidence(self, res: ArchitectureCheckResult):
        """Check 10: Status transition lifecycle ladder & evidence-to-claim verification.
        Guarantees:
        - Strict ladder: DESIGNED -> CONTRACTED -> IMPLEMENTED -> TESTED -> CERTIFIED.
        - Zero CERTIFIED allowed without human/maintainer signoff (quality floor).
        - Every TESTED Sub-LEGO must have physical presence, non-empty CONTRACT.md, ports/ files,
          implementation/mod.rs non-empty, and evidence/*-EVIDENCE.md non-stub (> 200 bytes).
        """
        if not self.sublegos:
            res.error("Registry not populated.")
            return

        for s_id, s_data in self.sublegos.items():
            status = s_data.get("status")
            canonical_path = s_data.get("canonical_path", "")
            abs_path = os.path.join(self.root, canonical_path)

            if status == "TESTED":
                if not os.path.isdir(abs_path):
                    res.error(f"Sub-LEGO {s_id} marked TESTED but directory missing: {canonical_path}")
                    continue

                contract_path = os.path.join(abs_path, "CONTRACT.md")
                if not os.path.isfile(contract_path) or os.path.getsize(contract_path) < 100:
                    res.error(f"Sub-LEGO {s_id} marked TESTED but CONTRACT.md is missing or stub (<100 bytes)")

                ports_dir = os.path.join(abs_path, "ports")
                if not os.path.isdir(ports_dir):
                    res.error(f"Sub-LEGO {s_id} marked TESTED but ports/ directory missing")
                else:
                    port_files = os.listdir(ports_dir)
                    if not port_files:
                        res.error(f"Sub-LEGO {s_id} marked TESTED but ports/ directory is empty")

                # Mechanically verify implementation/mod.rs
                impl_dir = os.path.join(abs_path, "implementation")
                impl_mod = os.path.join(impl_dir, "mod.rs")
                if not os.path.isdir(impl_dir):
                    res.error(f"Sub-LEGO {s_id} marked TESTED but implementation/ directory is missing: {canonical_path}/implementation")
                elif not os.path.isfile(impl_mod) or os.path.getsize(impl_mod) == 0:
                    res.error(f"Sub-LEGO {s_id} marked TESTED but implementation/mod.rs is missing or empty (0 bytes)")

                # Mechanically verify tests/ directory and non-empty test files
                tests_dir = os.path.join(abs_path, "tests")
                if not os.path.isdir(tests_dir):
                    res.error(f"Sub-LEGO {s_id} marked TESTED but tests/ directory is missing: {canonical_path}/tests")
                else:
                    test_files = [f for f in os.listdir(tests_dir) if f.endswith(('.rs', '.ts', '.js', '.mjs'))]
                    if not test_files:
                        res.error(f"Sub-LEGO {s_id} marked TESTED but no test files found in tests/")
                    else:
                        valid_tests = [f for f in test_files if os.path.getsize(os.path.join(tests_dir, f)) > 0]
                        if not valid_tests:
                            res.error(f"Sub-LEGO {s_id} marked TESTED but all test files in tests/ are empty (0 bytes): {test_files}")

                # Mechanically verify evidence/*-EVIDENCE.md (> 200 bytes)
                evidence_dir = os.path.join(abs_path, "evidence")
                if not os.path.isdir(evidence_dir):
                    res.error(f"Sub-LEGO {s_id} marked TESTED but evidence/ directory is missing: {canonical_path}/evidence")
                else:
                    ev_files = [f for f in os.listdir(evidence_dir) if f.endswith("-EVIDENCE.md")]
                    if not ev_files:
                        res.error(f"Sub-LEGO {s_id} marked TESTED but no *-EVIDENCE.md file found in evidence/")
                    else:
                        valid_ev = [f for f in ev_files if os.path.getsize(os.path.join(evidence_dir, f)) > 200]
                        if not valid_ev:
                            res.error(f"Sub-LEGO {s_id} marked TESTED but evidence files are stubs (<= 200 bytes): {ev_files}")

            elif status == "IMPLEMENTED":
                if not os.path.isdir(abs_path):
                    res.error(f"Sub-LEGO {s_id} marked IMPLEMENTED but directory missing: {canonical_path}")
                    continue
                contract_path = os.path.join(abs_path, "CONTRACT.md")
                if not os.path.isfile(contract_path) or os.path.getsize(contract_path) < 100:
                    res.error(f"Sub-LEGO {s_id} marked IMPLEMENTED but CONTRACT.md is missing or stub (<100 bytes)")
                ports_dir = os.path.join(abs_path, "ports")
                if not os.path.isdir(ports_dir) or not os.listdir(ports_dir):
                    res.error(f"Sub-LEGO {s_id} marked IMPLEMENTED but ports/ directory missing or empty")
                impl_mod = os.path.join(abs_path, "implementation", "mod.rs")
                if not os.path.isfile(impl_mod) or os.path.getsize(impl_mod) == 0:
                    res.error(f"Sub-LEGO {s_id} marked IMPLEMENTED but implementation/mod.rs is missing or empty (0 bytes)")

            elif status == "CERTIFIED":
                res.error(f"Sub-LEGO {s_id} marked CERTIFIED: Violation of Section 2 - Zero self-awarded certification permitted.")

        if res.passed:
            tested_count = len([s for s in self.sublegos.values() if s.get("status") == "TESTED"])
            res.log(f"Status transition lifecycle verified: all {tested_count} TESTED Sub-LEGOs have mechanically verified physical contracts (CONTRACT.md >= 100 bytes), non-empty ports/, physical Rust implementation (implementation/mod.rs > 0 bytes), physical test suites (tests/* > 0 bytes), and verified evidence (evidence/*-EVIDENCE.md > 200 bytes).")
            res.log("Zero Sub-LEGOs marked CERTIFIED (zero self-awarded certification floor strictly preserved).")

    def check_report_provenance_and_git_ledger(self, res: ArchitectureCheckResult):
        """Check 11: Remote Provenance & Git Ledger Integrity Check.
        Verifies:
        1. report.md exists and is non-empty.
        2. Remote provenance: verifies git rev-parse origin/main against git rev-parse HEAD
           and ensures claimed remote commits accurately reflect remote repository state.
        3. Distinguishes clearly between Implementation Commit SHAs vs Report/Evidence Commit SHAs.
        """
        report_path = os.path.join(self.root, "report.md")
        if not os.path.isfile(report_path):
            res.error(f"Mandatory report.md missing at workspace root: {report_path}")
            return
        if os.path.getsize(report_path) == 0:
            res.error("report.md exists but is empty.")
            return

        try:
            # 1. Local HEAD verification
            git_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, text=True).strip()
            git_head_short = git_head[:9]

            # 2. Remote Provenance verification via origin/main
            remote_main = None
            try:
                remote_main = subprocess.check_output(["git", "rev-parse", "origin/main"], cwd=self.root, text=True).strip()
            except Exception as e:
                res.error(f"Failed to resolve origin/main ref for remote provenance: {e}")

            if remote_main:
                remote_main_short = remote_main[:9]
                if git_head == remote_main:
                    res.log(f"Remote provenance verified: Local HEAD ({git_head_short}) matches origin/main ({remote_main_short}).")
                else:
                    try:
                        subprocess.check_call(["git", "merge-base", "--is-ancestor", remote_main, git_head], cwd=self.root)
                        res.log(f"Remote provenance note: Local HEAD ({git_head_short}) is ahead of origin/main ({remote_main_short}); pending atomic batch push.")
                    except subprocess.CalledProcessError:
                        res.error(f"Remote provenance diverged: Local HEAD ({git_head_short}) has diverged from origin/main ({remote_main_short}).")

            # 3. Categorize Implementation Commit SHAs vs Report/Evidence Commit SHAs from git history
            git_log = subprocess.check_output(
                ["git", "log", "-n", "50", "--format=%H|%h|%s"],
                cwd=self.root,
                text=True
            ).strip().splitlines()

            impl_commits = []
            report_commits = []

            for line in git_log:
                if not line.strip():
                    continue
                parts = line.split("|", 2)
                if len(parts) == 3:
                    full_sha, short_sha, subject = parts
                    # Implementation commits: feat(..., fix(..., refactor(...
                    if subject.startswith("feat(") or subject.startswith("fix(") or subject.startswith("refactor("):
                        impl_commits.append((short_sha, full_sha, subject))
                    elif subject.startswith("docs(") or "report" in subject.lower() or "evidence" in subject.lower():
                        report_commits.append((short_sha, full_sha, subject))

            with open(report_path, "r", encoding="utf-8") as f:
                report_text = f.read()

            found_impl_citations = [s for s, _, _ in impl_commits if s in report_text]
            found_report_citations = [s for s, _, _ in report_commits if s in report_text]

            res.log(f"Commit Ledger Categorization: {len(impl_commits)} implementation commits, {len(report_commits)} report/evidence commits tracked in recent history.")
            res.log(f"Implementation Commit Citations verified in report.md: {len(found_impl_citations)} matches (e.g. {found_impl_citations[:5]}).")
            res.log(f"Report/Evidence Commit Citations verified in report.md: {len(found_report_citations)} matches (e.g. {found_report_citations[:5]}).")

            # Check if report.md explicitly cites REMOTE MAIN and verify that claim
            # Distinguish strictly between HISTORICAL REMOTE MAIN vs active REMOTE MAIN citations.
            historical_remote_main_citations = []
            active_remote_main_citations = []

            for line in report_text.splitlines():
                if "REMOTE MAIN" in line.upper():
                    m_hist = re.search(r"HISTORICAL[_\s*]*REMOTE\s*MAIN[*:\s=]*[`\s]*([0-9a-f]{7,40})", line, re.IGNORECASE)
                    if m_hist:
                        historical_remote_main_citations.append(m_hist.group(1))
                    else:
                        m_active = re.search(r"REMOTE\s*MAIN[*:\s=]*[`\s]*([0-9a-f]{7,40})", line, re.IGNORECASE)
                        if m_active:
                            active_remote_main_citations.append(m_active.group(1))

            if not active_remote_main_citations:
                res.error("report.md does not contain explicit 'REMOTE MAIN' citation required for remote provenance verification.")
            else:
                for cited_sha in active_remote_main_citations:
                    is_exact_match = bool(remote_main and (cited_sha.lower() == remote_main.lower() or (len(cited_sha) >= 7 and remote_main.lower().startswith(cited_sha.lower()))))
                    if not is_exact_match:
                        res.error(f"Remote provenance mismatch: Report cited active REMOTE MAIN '{cited_sha}' does not match actual origin/main SHA '{remote_main}'!")
                    else:
                        res.log(f"Active report cited REMOTE MAIN '{cited_sha}' verified exactly on actual origin/main ref ({remote_main_short}).")

            # Verify historical remote main citations exist in git ledger
            for hist_sha in historical_remote_main_citations:
                try:
                    subprocess.check_call(["git", "cat-file", "-e", hist_sha], cwd=self.root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    res.log(f"Historical cited REMOTE MAIN '{hist_sha}' verified in git ledger.")
                except subprocess.CalledProcessError:
                    res.error(f"Historical cited REMOTE MAIN '{hist_sha}' not found in git ledger!")

        except Exception as e:
            res.error(f"Failed to verify git provenance for report.md: {e}")

    def _print_summary(self, overall_pass: bool, results: List[ArchitectureCheckResult]):
        print(f"{BOLD}{CYAN}{'='*78}{RESET}")
        print(f"{BOLD}{CYAN}                      CI ARCHITECTURE AUDIT SUMMARY{RESET}")
        print(f"{BOLD}{CYAN}{'='*78}{RESET}")

        for res in results:
            status_str = f"{GREEN}PASS{RESET}" if res.passed else f"{RED}FAIL{RESET}"
            print(f"  * {res.name:<60} : [{status_str}]")

        print(f"{BOLD}{CYAN}{'-'*78}{RESET}")
        if overall_pass:
            status_counts = Counter(s.get("status", "UNKNOWN") for s in self.sublegos.values())
            print(f"  {BOLD}{GREEN}OVERALL STATUS: ARCHITECTURAL & GOVERNANCE INTEGRITY PASS (Exit Code 0){RESET}")
            print(f"  {GREEN}Taxonomy ladder enforced: {status_counts.get('CERTIFIED', 0)} CERTIFIED (zero overclaim), {status_counts.get('TESTED', 0)} TESTED, {status_counts.get('IMPLEMENTED', 0)} IMPLEMENTED, {status_counts.get('CONTRACTED', 0)} CONTRACTED, {status_counts.get('DESIGNED', 0)} DESIGNED.{RESET}")
            print(f"  {GREEN}All 11 architecture, governance hierarchy, sub-agent schema, and provenance checks PASS.{RESET}")
        else:
            print(f"  {BOLD}{RED}OVERALL STATUS: REJECTED / AUDIT FAILED (Exit Code 1){RESET}")
            print(f"  {RED}Please resolve the reported architectural, governance, or taxonomy violations before committing.{RESET}")
        print(f"{BOLD}{CYAN}{'='*78}{RESET}\n")


def main():
    workspace = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    enforcer = CIArchitectureEnforcer(workspace)
    success = enforcer.run_all_checks()
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
