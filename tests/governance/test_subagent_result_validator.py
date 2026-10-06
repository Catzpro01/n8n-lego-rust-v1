#!/usr/bin/env python3
"""
Unit tests for Sub-Agent Result Protocol Validator (scripts/subagent_result_validator.py).
Tests that conversational outputs are rejected and valid schema results pass.
"""

import unittest
import sys
import os

# Ensure scripts dir is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from scripts.subagent_result_validator import parse_subagent_result, SubAgentResultValidator


class TestSubAgentResultValidator(unittest.TestCase):

    def test_valid_complete_result(self):
        sample = """
SUB-AGENT RESULT
STATUS: COMPLETE
TASK: Migrate L05.S01 workflow execution persistence to canonical port
SCOPE: L05.S01, lego/L05-storage/S01-workflow-execution-persistence/
FILES: lego/L05-storage/S01-workflow-execution-persistence/CONTRACT.md, lego/L05-storage/S01-workflow-execution-persistence/ports/lib.rs
TESTS: cargo test -p n8n-port-contract
EXIT CODES: 0
COMMIT: 51f1a3b5d
LOCAL/REMOTE: LOCAL
EVIDENCE: 16 passed, 0 failed in n8n-port-contract test suite
REMAINING: NONE
UNVERIFIED: Performance benchmarks on >10k concurrent executions
BLOCKERS: NONE
CHECKPOINT: L05.S01 port contract implemented and verified locally
"""
        valid, res, errs = parse_subagent_result(sample)
        self.assertTrue(valid, f"Expected valid, got errors: {errs}")
        self.assertIsNotNone(res)
        self.assertEqual(res.status, "COMPLETE")
        self.assertEqual(res.locality, "LOCAL")
        self.assertEqual(res.exit_codes, [0])
        self.assertEqual(res.commit, "51f1a3b5d")

    def test_valid_partial_result(self):
        sample = """
SUB-AGENT RESULT
STATUS: PARTIAL
TASK: Implement L06.S02 audit logging provider
SCOPE: L06.S02
FILES: lego/L06-observability/S02-audit-logging/ports/lib.rs
TESTS: cargo check
EXIT CODES: 0
COMMIT: UNCOMMITTED
LOCAL/REMOTE: LOCAL
EVIDENCE: Port contract compiled without errors
REMAINING: Implement physical storage backend
UNVERIFIED: Fail-closed WAL recovery under power cut
BLOCKERS: NONE
CHECKPOINT: Staged port interface ready for storage adapter
"""
        valid, res, errs = parse_subagent_result(sample)
        self.assertTrue(valid, f"Expected valid, got errors: {errs}")
        self.assertEqual(res.status, "PARTIAL")
        self.assertEqual(res.commit, "UNCOMMITTED")

    def test_valid_blocked_result(self):
        sample = """
SUB-AGENT RESULT
STATUS: BLOCKED
TASK: Wire Postgres distributed lock
SCOPE: L01.S03
FILES: NONE
TESTS: NONE
EXIT CODES: NONE
COMMIT: NONE
LOCAL/REMOTE: LOCAL
EVIDENCE: Postgres test instance unreachable on localhost:5432
REMAINING: Connection configuration and lock tests
UNVERIFIED: Concurrency lease expiration
BLOCKERS: Database service not responding
CHECKPOINT: Implementation paused awaiting database environment
"""
        valid, res, errs = parse_subagent_result(sample)
        self.assertTrue(valid, f"Expected valid, got errors: {errs}")
        self.assertEqual(res.status, "BLOCKED")

    def test_reject_pure_conversational_output(self):
        conversational_samples = [
            "Done! All tests passed and everything is implemented cleanly.",
            "I have finished migrating the Sub-LEGO. All 16 tests passed with exit code 0.",
            "Completed the task successfully. Ready for review.",
            "Fixed the issue in ports/lib.rs. Please check.",
        ]
        for sample in conversational_samples:
            valid, res, errs = parse_subagent_result(sample)
            self.assertFalse(valid, f"Conversational output should be rejected: '{sample}'")
            self.assertIn("conversational", " ".join(errs).lower())

    def test_reject_missing_header(self):
        sample = """
STATUS: COMPLETE
TASK: Some task
SCOPE: L00.S01
FILES: test.rs
TESTS: cargo test
EXIT CODES: 0
COMMIT: 1234567
LOCAL/REMOTE: LOCAL
EVIDENCE: All green
REMAINING: NONE
UNVERIFIED: NONE
BLOCKERS: NONE
CHECKPOINT: Done
"""
        valid, res, errs = parse_subagent_result(sample)
        self.assertFalse(valid)
        self.assertTrue(any("header" in e.lower() for e in errs))

    def test_reject_invalid_status(self):
        sample = """
SUB-AGENT RESULT
STATUS: SUCCESS
TASK: Some task
SCOPE: L00.S01
FILES: test.rs
TESTS: cargo test
EXIT CODES: 0
COMMIT: 1234567
LOCAL/REMOTE: LOCAL
EVIDENCE: All green
REMAINING: NONE
UNVERIFIED: NONE
BLOCKERS: NONE
CHECKPOINT: Done
"""
        valid, res, errs = parse_subagent_result(sample)
        self.assertFalse(valid)
        self.assertTrue(any("Invalid STATUS" in e for e in errs))

    def test_reject_unreplaced_placeholders(self):
        sample = """
SUB-AGENT RESULT
STATUS: COMPLETE
TASK: <Exact delegated task description>
SCOPE: L00.S01
FILES: test.rs
TESTS: cargo test
EXIT CODES: 0
COMMIT: 1234567
LOCAL/REMOTE: LOCAL
EVIDENCE: All green
REMAINING: NONE
UNVERIFIED: NONE
BLOCKERS: NONE
CHECKPOINT: Done
"""
        valid, res, errs = parse_subagent_result(sample)
        self.assertFalse(valid)
        self.assertTrue(any("placeholder" in e.lower() for e in errs))

    def test_reject_contradictory_complete_status(self):
        sample = """
SUB-AGENT RESULT
STATUS: COMPLETE
TASK: Some task
SCOPE: L00.S01
FILES: test.rs
TESTS: cargo test
EXIT CODES: 0
COMMIT: 1234567
LOCAL/REMOTE: LOCAL
EVIDENCE: All green
REMAINING: Need to finish writing 5 more functions
UNVERIFIED: NONE
BLOCKERS: NONE
CHECKPOINT: In progress
"""
        valid, res, errs = parse_subagent_result(sample)
        self.assertFalse(valid)
        self.assertTrue(any("Contradiction" in e for e in errs))

    def test_reject_invalid_locality(self):
        sample = """
SUB-AGENT RESULT
STATUS: COMPLETE
TASK: Some task
SCOPE: L00.S01
FILES: test.rs
TESTS: cargo test
EXIT CODES: 0
COMMIT: 1234567
LOCAL/REMOTE: REMOTE_SERVER
EVIDENCE: All green
REMAINING: NONE
UNVERIFIED: NONE
BLOCKERS: NONE
CHECKPOINT: Done
"""
        valid, res, errs = parse_subagent_result(sample)
        self.assertFalse(valid)
        self.assertTrue(any("Invalid LOCAL/REMOTE" in e for e in errs))

    def test_reject_empty_and_whitespace(self):
        valid1, _, errs1 = parse_subagent_result("")
        self.assertFalse(valid1)
        self.assertTrue(any("empty" in e.lower() for e in errs1))

        valid2, _, errs2 = parse_subagent_result("   \n\t  ")
        self.assertFalse(valid2)
        self.assertTrue(any("empty" in e.lower() for e in errs2))

    def test_reject_missing_required_field(self):
        sample = """
SUB-AGENT RESULT
STATUS: COMPLETE
TASK: Some task
SCOPE: L00.S01
FILES: test.rs
TESTS: cargo test
COMMIT: 1234567
LOCAL/REMOTE: LOCAL
EVIDENCE: All green
REMAINING: NONE
UNVERIFIED: NONE
BLOCKERS: NONE
CHECKPOINT: Done
"""
        valid, res, errs = parse_subagent_result(sample)
        self.assertFalse(valid)
        self.assertTrue(any("EXIT CODES" in e for e in errs))

    def test_multiline_fields_parsed_correctly(self):
        sample = """
SUB-AGENT RESULT
STATUS: COMPLETE
TASK: Multi-file update
SCOPE: L00.S01
FILES:
- lego/L00/S01/CONTRACT.md
- lego/L00/S01/ports/lib.rs
TESTS:
cargo check --workspace
cargo test -p n8n-port-contract
EXIT CODES: 0, 0
COMMIT: abcdef1234
LOCAL/REMOTE: LOCAL
EVIDENCE:
- 16 tests passed
- zero compilation warnings
REMAINING: NONE
UNVERIFIED: Performance stress under 100k workflows
BLOCKERS: NONE
CHECKPOINT: Completed and verified
"""
        valid, res, errs = parse_subagent_result(sample)
        self.assertTrue(valid, f"Expected valid, got errors: {errs}")
        self.assertIn("lego/L00/S01/CONTRACT.md", res.files)
        self.assertIn("cargo test -p n8n-port-contract", res.tests)
        self.assertEqual(res.exit_codes, [0, 0])
        self.assertIn("16 tests passed", res.evidence)

    def test_reject_tests_declared_but_no_exit_codes(self):
        sample = """
SUB-AGENT RESULT
STATUS: COMPLETE
TASK: Task with test
SCOPE: L00.S01
FILES: test.rs
TESTS: cargo test
EXIT CODES: NONE
COMMIT: 1234567
LOCAL/REMOTE: LOCAL
EVIDENCE: Green
REMAINING: NONE
UNVERIFIED: NONE
BLOCKERS: NONE
CHECKPOINT: Done
"""
        valid, res, errs = parse_subagent_result(sample)
        self.assertFalse(valid)
        self.assertTrue(any("EXIT CODES" in e for e in errs))


if __name__ == "__main__":
    unittest.main()
