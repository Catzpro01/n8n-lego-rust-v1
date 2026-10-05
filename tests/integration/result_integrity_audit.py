#!/usr/bin/env python3
"""Agent 5 — task-result integrity audit (Stage 2c of run_gate.sh).

A `results/TASK-*.md` file is an ASSERTION that work happened. This audit checks the
assertion against the repository, because a status line costs nothing to write:

  T1  STATUS: SUCCESS with an EMPTY "Pipeline Operations Summary" table
      -> the pipeline recorded no operation, so SUCCESS is unsupported.
  T2  WITHDRAWN before shipping. It flagged "the result's commit touched only
      results/" as a missing deliverable. Verified false: the Arena Gateway commits
      result files SEPARATELY from the agent's work (e.g. TASK-201's result is commit
      6ce9df42, results-only, while its deliverable docs/isolation/workflow.md was
      committed in 6dc25f44). T2 fired on 10 of 17 results, nearly all of them real
      work. A check that indicts correct behaviour is worse than no check.

Reported, never auto-fixed: Agent 5 documents and reassigns, it does not own other
agents' LEGO internals.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RESULTS = os.path.join(ROOT, "results")

def ops_rows(text):
    rows, in_table = 0, False
    for line in text.splitlines():
        if re.match(r"^\|\s*:?-+", line):
            in_table = True
            continue
        if in_table:
            if line.startswith("|"):
                rows += 1
            elif line.strip() == "" or line.startswith("#"):
                in_table = False
    return rows


def audit():
    print("=== [AGENT 5] TASK RESULT INTEGRITY AUDIT ===")
    if not os.path.isdir(RESULTS):
        print("  no results/ directory — nothing to audit")
        return 0

    findings = []
    files = sorted(f for f in os.listdir(RESULTS) if f.endswith(".md"))
    for name in files:
        path = os.path.join(RESULTS, name)
        text = open(path, encoding="utf8", errors="replace").read()
        status = re.search(r"\*\*STATUS\*\*:\s*`([A-Z]+)`", text)
        status = status.group(1) if status else "?"
        if status != "SUCCESS":
            continue

        if ops_rows(text) == 0:
            findings.append((name, "T1 SUCCESS but the operations table is empty "
                                   "— no operation was recorded"))

    for name, msg in findings:
        print(f"  [FAIL] {name}: {msg}")
    ok = len(files) - len({n for n, _ in findings})
    print(f"\nRESULT: {ok}/{len(files)} task results are self-consistent")
    if findings:
        print("TASK RESULT INTEGRITY: FAIL")
        return 1
    print("TASK RESULT INTEGRITY: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(audit())
