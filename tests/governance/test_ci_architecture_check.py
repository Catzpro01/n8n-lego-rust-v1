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


if __name__ == "__main__":
    unittest.main()
