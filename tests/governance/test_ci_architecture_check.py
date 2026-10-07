#!/usr/bin/env python3
"""
Unit and regression tests for CI Architecture Enforcer governance additions
(checks 8, 9, 10, 11 in scripts/ci_architecture_check.py).
"""

import unittest
import sys
import os
import tempfile
import shutil

# Ensure scripts dir is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from scripts.ci_architecture_check import CIArchitectureEnforcer, ArchitectureCheckResult


class TestCIGovernanceChecks(unittest.TestCase):

    def setUp(self):
        self.workspace = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        self.enforcer = CIArchitectureEnforcer(self.workspace)

    def test_live_governance_semantic_consistency_passes(self):
        res = ArchitectureCheckResult("Test Governance Semantic Consistency")
        self.enforcer.check_governance_semantic_consistency(res)
        self.assertTrue(res.passed, f"Expected PASS, errors: {res.errors}")

    def test_live_subagent_result_validator_passes(self):
        res = ArchitectureCheckResult("Test Sub-Agent Validator")
        self.enforcer.check_subagent_result_validator(res)
        self.assertTrue(res.passed, f"Expected PASS, errors: {res.errors}")

    def test_live_status_transition_passes(self):
        # Must populate sublegos first
        res1 = ArchitectureCheckResult("Test Registry")
        self.enforcer.check_registry_validity(res1)
        self.assertTrue(res1.passed)

        res = ArchitectureCheckResult("Test Status Transition")
        self.enforcer.check_status_transition_and_evidence(res)
        self.assertTrue(res.passed, f"Expected PASS, errors: {res.errors}")

    def test_live_report_provenance_passes(self):
        res = ArchitectureCheckResult("Test Report Provenance")
        self.enforcer.check_report_provenance_and_git_ledger(res)
        self.assertTrue(res.passed, f"Expected PASS, errors: {res.errors}")

    def test_negative_governance_hierarchy_mismatch_fails(self):
        """Simulate an inverted hierarchy in a temporary test directory."""
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_enforcer = CIArchitectureEnforcer(tmpdir)
            agents_md = os.path.join(tmpdir, "AGENTS.md")
            master_md = os.path.join(tmpdir, "docs", "migration", "ANTIGRAVITY-MASTER-EXECUTION-CONTRACT.md")
            os.makedirs(os.path.dirname(master_md), exist_ok=True)

            # Inverted hierarchy in AGENTS.md (COORDINATOR before MASTER EXECUTION CONTRACT)
            bad_agents = """
1. PLATFORM / SYSTEM
8. ANTIGRAVITY COORDINATOR
3. MASTER EXECUTION CONTRACT
UNKNOWN != COMPLETE
PARTIAL != COMPLETE
CONTRACTED != IMPLEMENTED
IMPLEMENTED != TESTED
TESTED != CERTIFIED
LOCAL != REMOTE
"""
            with open(agents_md, "w", encoding="utf-8") as f:
                f.write(bad_agents)
            with open(master_md, "w", encoding="utf-8") as f:
                f.write(bad_agents)

            res = ArchitectureCheckResult("Negative Test Inverted Hierarchy")
            temp_enforcer.check_governance_semantic_consistency(res)
            self.assertFalse(res.passed, "Inverted hierarchy should fail check 8")
            self.assertTrue(any("violates" in e.lower() or "missing" in e.lower() for e in res.errors))

    def test_negative_check_10_missing_implementation_fails(self):
        """Simulate a Sub-LEGO claiming TESTED without implementation/mod.rs."""
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_enforcer = CIArchitectureEnforcer(tmpdir)
            sub_path = os.path.join(tmpdir, "lego", "L00", "S01")
            os.makedirs(os.path.join(sub_path, "ports"), exist_ok=True)
            with open(os.path.join(sub_path, "ports", "lib.rs"), "w") as f:
                f.write("// port")
            with open(os.path.join(sub_path, "CONTRACT.md"), "w") as f:
                f.write("# Contract\n" * 15)  # > 100 bytes

            temp_enforcer.sublegos = {
                "L00.S01": {
                    "status": "TESTED",
                    "canonical_path": "lego/L00/S01",
                }
            }
            res = ArchitectureCheckResult("Negative Test Missing Implementation")
            temp_enforcer.check_status_transition_and_evidence(res)
            self.assertFalse(res.passed)
            self.assertTrue(any("implementation/ directory is missing" in e for e in res.errors))

    def test_negative_check_10_stub_evidence_fails(self):
        """Simulate a Sub-LEGO claiming TESTED with stub evidence (<= 200 bytes)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_enforcer = CIArchitectureEnforcer(tmpdir)
            sub_path = os.path.join(tmpdir, "lego", "L00", "S01")
            os.makedirs(os.path.join(sub_path, "ports"), exist_ok=True)
            os.makedirs(os.path.join(sub_path, "implementation"), exist_ok=True)
            os.makedirs(os.path.join(sub_path, "evidence"), exist_ok=True)
            with open(os.path.join(sub_path, "ports", "lib.rs"), "w") as f:
                f.write("// port")
            with open(os.path.join(sub_path, "CONTRACT.md"), "w") as f:
                f.write("# Contract\n" * 15)
            with open(os.path.join(sub_path, "implementation", "mod.rs"), "w") as f:
                f.write("// impl")
            with open(os.path.join(sub_path, "evidence", "L00-S01-EVIDENCE.md"), "w") as f:
                f.write("# Stub Evidence")  # ~15 bytes <= 200 bytes

            temp_enforcer.sublegos = {
                "L00.S01": {
                    "status": "TESTED",
                    "canonical_path": "lego/L00/S01",
                }
            }
            res = ArchitectureCheckResult("Negative Test Stub Evidence")
            temp_enforcer.check_status_transition_and_evidence(res)
            self.assertFalse(res.passed)
            self.assertTrue(any("evidence files are stubs" in e for e in res.errors))

    def test_negative_check_10_missing_tests_dir_fails(self):
        """Simulate a Sub-LEGO claiming TESTED without tests/ directory."""
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_enforcer = CIArchitectureEnforcer(tmpdir)
            sub_path = os.path.join(tmpdir, "lego", "L00", "S01")
            os.makedirs(os.path.join(sub_path, "ports"), exist_ok=True)
            os.makedirs(os.path.join(sub_path, "implementation"), exist_ok=True)
            os.makedirs(os.path.join(sub_path, "evidence"), exist_ok=True)
            with open(os.path.join(sub_path, "ports", "lib.rs"), "w") as f:
                f.write("// port")
            with open(os.path.join(sub_path, "CONTRACT.md"), "w") as f:
                f.write("# Contract\n" * 15)
            with open(os.path.join(sub_path, "implementation", "mod.rs"), "w") as f:
                f.write("// impl")
            with open(os.path.join(sub_path, "evidence", "L00-S01-EVIDENCE.md"), "w") as f:
                f.write("# Valid Evidence\n" * 20)  # > 200 bytes

            temp_enforcer.sublegos = {
                "L00.S01": {
                    "status": "TESTED",
                    "canonical_path": "lego/L00/S01",
                }
            }
            res = ArchitectureCheckResult("Negative Test Missing Tests Dir")
            temp_enforcer.check_status_transition_and_evidence(res)
            self.assertFalse(res.passed)
            self.assertTrue(any("tests/ directory is missing" in e for e in res.errors))

    def test_negative_check_11_missing_remote_main_citation_fails(self):
        """Simulate report.md missing explicit REMOTE MAIN citation."""
        real_report = os.path.join(self.workspace, "report.md")
        backup = real_report + ".test_bak"
        try:
            shutil.copyfile(real_report, backup)
            with open(real_report, "w", encoding="utf-8") as f:
                f.write("# Report without remote main citation\nfeat(sublego-batch): commit\n")
            res = ArchitectureCheckResult("Negative Test Missing Remote Main Citation")
            self.enforcer.check_report_provenance_and_git_ledger(res)
            self.assertFalse(res.passed)
            self.assertTrue(any("does not contain explicit 'REMOTE MAIN' citation" in e for e in res.errors))
        finally:
            if os.path.isfile(backup):
                shutil.copyfile(backup, real_report)
                os.remove(backup)

    def test_negative_check_11_divergent_remote_main_citation_fails(self):
        """Simulate report.md citing a wrong/divergent REMOTE MAIN SHA."""
        real_report = os.path.join(self.workspace, "report.md")
        backup = real_report + ".test_bak"
        try:
            shutil.copyfile(real_report, backup)
            with open(real_report, "w", encoding="utf-8") as f:
                f.write("# Report\n- **REMOTE MAIN**: 0000000000000000000000000000000000000000\n")
            res = ArchitectureCheckResult("Negative Test Divergent Remote Main Citation")
            self.enforcer.check_report_provenance_and_git_ledger(res)
            self.assertFalse(res.passed)
            self.assertTrue(any("does not match actual origin/main SHA" in e for e in res.errors))
        finally:
            if os.path.isfile(backup):
                shutil.copyfile(backup, real_report)
                os.remove(backup)

    def test_negative_check_11_ancestor_remote_main_citation_rejected(self):
        """Simulate report.md citing an ancestor commit instead of current origin/main.
        Must strictly fail Check 11 (merge-base --is-ancestor tolerance eliminated)."""
        import subprocess
        origin_main = subprocess.check_output(["git", "rev-parse", "origin/main"], cwd=self.workspace, text=True).strip()
        ancestor = subprocess.check_output(["git", "rev-parse", "origin/main~1"], cwd=self.workspace, text=True).strip()
        self.assertNotEqual(origin_main, ancestor)

        real_report = os.path.join(self.workspace, "report.md")
        backup = real_report + ".test_bak"
        try:
            shutil.copyfile(real_report, backup)
            with open(real_report, "w", encoding="utf-8") as f:
                f.write(f"# Report citing ancestor\n- **REMOTE MAIN**: {ancestor}\n")
            res = ArchitectureCheckResult("Negative Test Ancestor Remote Main Citation")
            self.enforcer.check_report_provenance_and_git_ledger(res)
            self.assertFalse(res.passed, "Ancestor citation as active REMOTE MAIN must be strictly rejected")
            self.assertTrue(any("remote provenance mismatch" in e.lower() for e in res.errors))
            self.assertTrue(any("does not match actual origin/main sha" in e.lower() for e in res.errors))
        finally:
            if os.path.isfile(backup):
                shutil.copyfile(backup, real_report)
                os.remove(backup)

    def test_check_11_historical_remote_main_citation_passes(self):
        """Verify that historical remote main citations with valid git ledger presence pass when accompanied by exact active REMOTE MAIN."""
        import subprocess
        origin_main = subprocess.check_output(["git", "rev-parse", "origin/main"], cwd=self.workspace, text=True).strip()
        ancestor = subprocess.check_output(["git", "rev-parse", "origin/main~1"], cwd=self.workspace, text=True).strip()

        real_report = os.path.join(self.workspace, "report.md")
        backup = real_report + ".test_bak"
        try:
            shutil.copyfile(real_report, backup)
            with open(real_report, "w", encoding="utf-8") as f:
                f.write(f"# Report\n- **HISTORICAL REMOTE MAIN**: {ancestor}\n- **REMOTE MAIN**: {origin_main}\n")
            res = ArchitectureCheckResult("Test Historical And Active Remote Main")
            self.enforcer.check_report_provenance_and_git_ledger(res)
            self.assertTrue(res.passed, f"Expected PASS with valid historical and exact active citations, errors: {res.errors}")
        finally:
            if os.path.isfile(backup):
                shutil.copyfile(backup, real_report)
                os.remove(backup)

    def test_negative_check_11_nonexistent_historical_citation_fails(self):
        """Simulate report.md citing a non-existent commit as HISTORICAL REMOTE MAIN."""
        import subprocess
        origin_main = subprocess.check_output(["git", "rev-parse", "origin/main"], cwd=self.workspace, text=True).strip()

        real_report = os.path.join(self.workspace, "report.md")
        backup = real_report + ".test_bak"
        try:
            shutil.copyfile(real_report, backup)
            with open(real_report, "w", encoding="utf-8") as f:
                f.write(f"# Report\n- **HISTORICAL REMOTE MAIN**: 1111111111111111111111111111111111111111\n- **REMOTE MAIN**: {origin_main}\n")
            res = ArchitectureCheckResult("Negative Test Nonexistent Historical Remote Main")
            self.enforcer.check_report_provenance_and_git_ledger(res)
            self.assertFalse(res.passed)
            self.assertTrue(any("not found in git ledger" in e.lower() for e in res.errors))
        finally:
            if os.path.isfile(backup):
                shutil.copyfile(backup, real_report)
                os.remove(backup)

    def test_negative_check_11_multiple_active_remote_main_with_stale_fails(self):
        """Verify that if multiple active REMOTE MAIN citations exist and one is stale/ancestor, Check 11 strictly fails."""
        import subprocess
        origin_main = subprocess.check_output(["git", "rev-parse", "origin/main"], cwd=self.workspace, text=True).strip()
        ancestor = subprocess.check_output(["git", "rev-parse", "origin/main~1"], cwd=self.workspace, text=True).strip()

        real_report = os.path.join(self.workspace, "report.md")
        backup = real_report + ".test_bak"
        try:
            shutil.copyfile(real_report, backup)
            with open(real_report, "w", encoding="utf-8") as f:
                f.write(f"# Report\n- **REMOTE MAIN**: {ancestor}\n- **REMOTE MAIN**: {origin_main}\n")
            res = ArchitectureCheckResult("Negative Test Multiple Active Remote Main With Stale")
            self.enforcer.check_report_provenance_and_git_ledger(res)
            self.assertFalse(res.passed)
            self.assertTrue(any("remote provenance mismatch" in e.lower() for e in res.errors))
        finally:
            if os.path.isfile(backup):
                shutil.copyfile(backup, real_report)
                os.remove(backup)


if __name__ == "__main__":
    unittest.main()


