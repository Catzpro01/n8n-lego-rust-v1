#!/usr/bin/env python3
"""
Mechanical Parser and Validator for SUB-AGENT RESULT Protocol.
Enforces AGENTS.md Section 3 and ANTIGRAVITY-AGENTIC-EXECUTION-STANDARD.md.

Rejects conversational summaries (e.g. "Done", "Passed", "Fixed") and ensures
complete, structured, parseable evidence-first sub-agent reporting.
"""

import sys
import re
import os
import json
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Tuple, Any

VALID_STATUSES = {"COMPLETE", "PARTIAL", "BLOCKED", "FAILED", "NOT VERIFIED"}
VALID_LOCALITIES = {"LOCAL", "REMOTE"}

REQUIRED_FIELDS = [
    "STATUS",
    "TASK",
    "SCOPE",
    "FILES",
    "TESTS",
    "EXIT CODES",
    "COMMIT",
    "LOCAL/REMOTE",
    "EVIDENCE",
    "REMAINING",
    "UNVERIFIED",
    "BLOCKERS",
    "CHECKPOINT",
]


@dataclass
class SubAgentResult:
    status: str
    task: str
    scope: str
    files: str
    tests: str
    exit_codes: List[int]
    commit: str
    locality: str
    evidence: str
    remaining: str
    unverified: str
    blockers: str
    checkpoint: str
    raw_dict: Dict[str, str]

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        del d["raw_dict"]
        return d


class SubAgentResultValidator:
    """Parses and validates SUB-AGENT RESULT output blocks."""

    # Matches key: at start of line
    FIELD_PATTERN = re.compile(r"^([A-Z/ ]+):\s*(.*)$")

    @classmethod
    def parse_and_validate(cls, text: str) -> Tuple[bool, Optional[SubAgentResult], List[str]]:
        """
        Parses text and validates against the rigid sub-agent schema.
        Returns: (is_valid, parsed_result_or_none, list_of_errors)
        """
        errors: List[str] = []

        if not text or not text.strip():
            return False, None, ["Input is completely empty; sub-agent produced no output."]

        clean_text = text.strip()

        # Check for SUB-AGENT RESULT block header
        header_match = re.search(r"SUB-AGENT RESULT", clean_text)
        if not header_match:
            # Check if this is conversational output
            conversational_indicators = ["done", "tests passed", "implemented", "completed", "i have", "fixed"]
            lower_text = clean_text.lower()
            if any(ind in lower_text for ind in conversational_indicators):
                return False, None, [
                    "REJECTED: Informal conversational output detected without 'SUB-AGENT RESULT' header. "
                    "Agents must report strictly using the parseable SUB-AGENT RESULT schema."
                ]
            return False, None, ["Missing mandatory 'SUB-AGENT RESULT' block header."]

        # Slice text starting from SUB-AGENT RESULT
        block_text = clean_text[header_match.start():]

        # Extract fields
        lines = block_text.splitlines()
        extracted: Dict[str, List[str]] = {}
        current_field: Optional[str] = None

        for line in lines[1:]:  # skip 'SUB-AGENT RESULT' header line
            # Check if line marks a known field
            field_matched = None
            for req in REQUIRED_FIELDS:
                prefix = f"{req}:"
                stripped = line.strip()
                if stripped.startswith(prefix):
                    field_matched = req
                    value_part = stripped[len(prefix):].strip()
                    break

            if field_matched:
                current_field = field_matched
                extracted[current_field] = [value_part] if value_part else []
            elif current_field is not None:
                # Continuation of current field
                # Stop if end of block or delimiter encountered
                if line.strip().startswith("---") or line.strip().startswith("```") or line.strip().startswith("##"):
                    current_field = None
                else:
                    extracted[current_field].append(line.rstrip())

        # Consolidate multiline values
        field_values: Dict[str, str] = {}
        for req in REQUIRED_FIELDS:
            if req in extracted:
                val = "\n".join(extracted[req]).strip()
                field_values[req] = val

        # Check for missing required fields
        for req in REQUIRED_FIELDS:
            if req not in field_values:
                errors.append(f"Missing required field: '{req}'")
            elif not field_values[req]:
                errors.append(f"Required field '{req}' cannot be empty.")

        if errors:
            return False, None, errors

        # Check for unreplaced template placeholders e.g. <...>
        for req, val in field_values.items():
            if re.match(r"^<.*>$", val.strip()):
                errors.append(f"Field '{req}' contains unreplaced template placeholder: '{val}'")

        # 1. Validate STATUS
        status_val = field_values.get("STATUS", "").strip().upper()
        # Strip brackets if user included <COMPLETE>
        status_val = status_val.strip("<> ")
        if status_val not in VALID_STATUSES:
            errors.append(
                f"Invalid STATUS: '{field_values.get('STATUS')}'. Must be one of: {sorted(VALID_STATUSES)}"
            )

        # 2. Validate LOCAL/REMOTE
        locality_val = field_values.get("LOCAL/REMOTE", "").strip().upper()
        locality_val = locality_val.strip("<> ")
        if locality_val not in VALID_LOCALITIES:
            errors.append(
                f"Invalid LOCAL/REMOTE: '{field_values.get('LOCAL/REMOTE')}'. Must be exactly 'LOCAL' or 'REMOTE'."
            )

        # 3. Validate EXIT CODES
        exit_codes_raw = field_values.get("EXIT CODES", "").strip()
        exit_codes: List[int] = []
        tests_val = field_values.get("TESTS", "").strip().upper()

        if exit_codes_raw.upper() in ("NONE", "N/A", "EMPTY", "[]", ""):
            if tests_val not in ("NONE", "N/A", "0", ""):
                errors.append(f"TESTS were declared ('{field_values.get('TESTS')}'), but EXIT CODES is '{exit_codes_raw}'. Concrete exit codes must be provided.")
        else:
            # Parse integers from raw exit codes string, e.g. "0", "0, 0", "[0, 0]", "Exit code 0"
            found_ints = re.findall(r"\b\d+\b", exit_codes_raw)
            if not found_ints:
                errors.append(f"Invalid EXIT CODES: '{exit_codes_raw}'. Expected integer exit codes (e.g. 0).")
            else:
                exit_codes = [int(x) for x in found_ints]

        # 4. Validate COMMIT
        commit_val = field_values.get("COMMIT", "").strip()
        commit_upper = commit_val.upper()
        if commit_upper not in ("UNCOMMITTED", "NONE", "N/A", "WORKTREE"):
            # Should look like a valid hex SHA (7 to 40 hex characters)
            sha_clean = re.sub(r"[^0-9a-fA-F]", "", commit_val)
            if len(sha_clean) < 7:
                errors.append(f"Invalid COMMIT SHA: '{commit_val}'. Expected git commit SHA (minimum 7 hex characters) or 'UNCOMMITTED'.")

        # 5. Check anti-premature completion rules
        if status_val == "COMPLETE":
            remaining_val = field_values.get("REMAINING", "").strip().upper()
            if remaining_val not in ("NONE", "N/A", "0", "NOTHING", "NIL") and not remaining_val.startswith("NONE"):
                # If remaining work exists, status should be PARTIAL
                errors.append(
                    f"Contradiction: STATUS is COMPLETE, but REMAINING specifies remaining work: '{field_values.get('REMAINING')}'. Use PARTIAL."
                )

            blockers_val = field_values.get("BLOCKERS", "").strip().upper()
            if blockers_val not in ("NONE", "N/A", "0", "NIL") and not blockers_val.startswith("NONE"):
                errors.append(
                    f"Contradiction: STATUS is COMPLETE, but BLOCKERS specifies active blockers: '{field_values.get('BLOCKERS')}'. Use BLOCKED."
                )

        if errors:
            return False, None, errors

        result = SubAgentResult(
            status=status_val,
            task=field_values["TASK"],
            scope=field_values["SCOPE"],
            files=field_values["FILES"],
            tests=field_values["TESTS"],
            exit_codes=exit_codes,
            commit=commit_val,
            locality=locality_val,
            evidence=field_values["EVIDENCE"],
            remaining=field_values["REMAINING"],
            unverified=field_values["UNVERIFIED"],
            blockers=field_values["BLOCKERS"],
            checkpoint=field_values["CHECKPOINT"],
            raw_dict=field_values,
        )

        return True, result, []


def parse_subagent_result(text: str) -> Tuple[bool, Optional[SubAgentResult], List[str]]:
    return SubAgentResultValidator.parse_and_validate(text)


def main():
    if len(sys.argv) < 2:
        # Read from stdin if available
        if not sys.stdin.isatty():
            content = sys.stdin.read()
        else:
            print("Usage: python subagent_result_validator.py <file_path | text>")
            sys.exit(1)
    else:
        arg = sys.argv[1]
        if os.path.isfile(arg):
            with open(arg, "r", encoding="utf-8") as f:
                content = f.read()
        else:
            content = arg

    valid, res, errs = parse_subagent_result(content)
    if valid and res:
        print(f"[VALID] Sub-Agent Result complies with schema.")
        print(json.dumps(res.to_dict(), indent=2))
        sys.exit(0)
    else:
        print(f"[INVALID] Sub-Agent Result failed schema validation:")
        for err in errs:
            print(f"  - {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
