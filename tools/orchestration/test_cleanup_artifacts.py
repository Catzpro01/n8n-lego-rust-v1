"""Unit tests for ``tools/orchestration/cleanup_artifacts.py``.

Run with ``python3 -m pytest -q tools/orchestration/test_cleanup_artifacts.py``
(``python3 -m unittest`` works too).

No network and no secrets are involved: :func:`cleanup_artifacts.request` is the
single HTTP seam and every test replaces it with an in-memory stub that records
the calls it received. ``GITHUB_TOKEN`` is set to an obviously fake value so the
redaction test can prove the token never reaches stdout.

The property these tests exist to protect is narrow and deliberate: **the tool
deletes only what an exact commit SHA selected, and only under ``--apply``.** A
cleanup tool that can be talked into a repository-wide sweep is worse than no
cleanup tool, so most of the suite is about the cases where nothing may happen.
"""

from __future__ import annotations

import io
import os
import sys
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import cleanup_artifacts as ca  # noqa: E402

FAKE_TOKEN = "ghp_ThisIsObviouslyFakeForTestPurposes000"
HEAD_SHA = "a" * 40
OTHER_SHA = "b" * 40
MERGE_SHA = "c" * 40


def artifact(
    artifact_id: int,
    head_sha: str = HEAD_SHA,
    name: str = "n8n-lego-release",
    size: Any = 16_000_000,
    created: Optional[str] = None,
    expired: bool = False,
    head_branch: str = "some/pr-branch",
    run_name: str = "n8n-lego Gate",
) -> Dict[str, Any]:
    """One artifact payload, shaped the way the REST API returns it."""
    return {
        "id": artifact_id,
        "name": name,
        "size_in_bytes": size,
        "expired": expired,
        "created_at": created or datetime.now(timezone.utc).isoformat(),
        "workflow_run": {
            "id": 1000 + artifact_id,
            "head_branch": head_branch,
            "head_sha": head_sha,
            "name": run_name,
        },
    }


class StubHttp:
    """Replaces :func:`ca.request`. Records calls, replays canned responses."""

    def __init__(self, artifacts: List[Dict[str, Any]], per_page: int = ca.PER_PAGE):
        self.artifacts = artifacts
        self.per_page = per_page
        self.calls: List[Tuple[str, str]] = []
        self.deleted: List[int] = []
        self.list_status = 200
        self.delete_status = 204
        self.delete_fail_ids: set = set()
        self.raise_on: Optional[str] = None

    def __call__(self, method: str, url: str, token: str, timeout: float = 30.0):
        self.calls.append((method, url))
        if self.raise_on and self.raise_on in url:
            raise ca.ApiError(f"stubbed transport failure for {url}")
        if method == "GET":
            if self.list_status != 200:
                return self.list_status, {"message": "stubbed error"}
            page = 1
            if "page=" in url:
                page = int(url.rsplit("page=", 1)[1])
            start = (page - 1) * self.per_page
            batch = self.artifacts[start:start + self.per_page]
            return 200, {"total_count": len(self.artifacts), "artifacts": batch}
        if method == "DELETE":
            artifact_id = int(url.rsplit("/", 1)[1])
            if artifact_id in self.delete_fail_ids:
                return 403, {"message": "Resource not accessible by integration"}
            self.deleted.append(artifact_id)
            return self.delete_status, None
        raise AssertionError(f"unexpected method {method}")


class CleanupArtifactsTestCase(unittest.TestCase):
    """Base class: fake environment, stubbed HTTP, captured stdout."""

    def setUp(self):
        self._env = {k: os.environ.get(k) for k in ("GITHUB_TOKEN", "GITHUB_REPOSITORY")}
        os.environ["GITHUB_TOKEN"] = FAKE_TOKEN
        os.environ["GITHUB_REPOSITORY"] = "Catzpro01/n8n-rust-v.4"
        self._real_request = ca.request

    def tearDown(self):
        ca.request = self._real_request
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def stub(self, artifacts: List[Dict[str, Any]], **kwargs) -> StubHttp:
        http = StubHttp(artifacts, **kwargs)
        ca.request = http
        return http

    def run_main(self, argv: List[str]) -> Tuple[int, str]:
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = ca.main(argv)
        return code, buffer.getvalue()


# --------------------------------------------------------------------------- #
# 1. nothing may happen without a valid, deliberate invocation
# --------------------------------------------------------------------------- #
class TestUsageGuards(CleanupArtifactsTestCase):

    def test_missing_token_is_a_usage_error_and_mentions_the_environment(self):
        os.environ.pop("GITHUB_TOKEN", None)
        code, out = self.run_main(["--sha", HEAD_SHA])
        self.assertEqual(code, 2)
        self.assertIn("USAGE ERROR", out)
        self.assertIn("never the command line", out)

    def test_no_selection_criteria_refuses_to_run(self):
        """Without --sha or --max-age-days the tool would match everything by age."""
        code, out = self.run_main([])
        self.assertEqual(code, 2)
        self.assertIn("nothing selected", out)

    def test_a_malformed_sha_is_rejected_before_any_request(self):
        http = self.stub([artifact(1)])
        for bad in ("not-a-sha", "ZZZ1234", "abc", "a" * 41, "P2-S07"):
            code, out = self.run_main(["--sha", bad])
            self.assertEqual(code, 2, bad)
            self.assertIn("is not a commit SHA", out)
        self.assertEqual(http.calls, [], "no API call is made for an invalid invocation")

    def test_negative_max_age_is_rejected(self):
        code, out = self.run_main(["--max-age-days", "-1"])
        self.assertEqual(code, 2)
        self.assertIn("must not be negative", out)

    def test_too_many_shas_is_rejected(self):
        shas = []
        for i in range(ca.MAX_SHAS + 1):
            shas += ["--sha", f"{i:07x}"]
        code, out = self.run_main(shas)
        self.assertEqual(code, 2)
        self.assertIn(f"more than {ca.MAX_SHAS} SHAs", out)

    def test_unresolvable_owner_repo_is_a_usage_error(self):
        os.environ.pop("GITHUB_REPOSITORY", None)
        code, out = self.run_main(["--sha", HEAD_SHA])
        self.assertEqual(code, 2)
        self.assertIn("could not resolve owner/repo", out)

    def test_owner_and_repo_resolve_from_the_environment(self):
        http = self.stub([])
        self.run_main(["--sha", HEAD_SHA])
        self.assertTrue(http.calls[0][1].startswith(
            "https://api.github.com/repos/Catzpro01/n8n-rust-v.4/actions/artifacts"), http.calls[0])

    def test_explicit_owner_repo_override_the_environment(self):
        http = self.stub([])
        self.run_main(["--sha", HEAD_SHA, "--owner", "acme", "--repo", "widget"])
        self.assertIn("/repos/acme/widget/actions/artifacts", http.calls[0][1])


# --------------------------------------------------------------------------- #
# 2. selection is by exact SHA, and by nothing else
# --------------------------------------------------------------------------- #
class TestSelection(CleanupArtifactsTestCase):

    def test_matches_on_the_full_head_sha(self):
        hits = [artifact(1, head_sha=HEAD_SHA)]
        misses = [artifact(2, head_sha=OTHER_SHA)]
        selected = ca.select_artifacts(hits + misses, [HEAD_SHA], None)
        self.assertEqual([a["id"] for a, _ in selected], [1])
        self.assertIn("head_sha=", selected[0][1])

    def test_matches_on_an_abbreviated_sha(self):
        selected = ca.select_artifacts([artifact(1, head_sha=HEAD_SHA)], [HEAD_SHA[:8]], None)
        self.assertEqual([a["id"] for a, _ in selected], [1])

    def test_never_selects_by_branch_name_even_when_it_matches(self):
        """Selection by head_branch would sweep every artifact of a reused branch name."""
        payload = artifact(1, head_sha=OTHER_SHA, head_branch="gov/vocabulary-separation")
        selected = ca.select_artifacts([payload], [], None)
        self.assertEqual(selected, [])
        selected = ca.select_artifacts([payload], [HEAD_SHA], None)
        self.assertEqual(selected, [], "a different SHA on the same branch is not selected")

    def test_never_selects_by_artifact_name_pattern(self):
        payload = artifact(1, head_sha=OTHER_SHA, name="n8n-lego-release")
        self.assertEqual(ca.select_artifacts([payload], [HEAD_SHA], None), [])

    def test_both_head_and_merge_sha_may_be_given(self):
        payloads = [artifact(1, head_sha=HEAD_SHA), artifact(2, head_sha=MERGE_SHA),
                    artifact(3, head_sha=OTHER_SHA)]
        selected = ca.select_artifacts(payloads, [HEAD_SHA, MERGE_SHA], None)
        self.assertEqual([a["id"] for a, _ in selected], [1, 2])

    def test_an_artifact_without_a_workflow_run_is_never_selected(self):
        payload = artifact(1)
        payload.pop("workflow_run")
        self.assertEqual(ca.select_artifacts([payload], [HEAD_SHA], None), [])

    def test_max_age_selects_only_older_artifacts_and_is_off_by_default(self):
        old = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        new = datetime.now(timezone.utc).isoformat()
        payloads = [artifact(1, head_sha=OTHER_SHA, created=old),
                    artifact(2, head_sha=OTHER_SHA, created=new)]
        self.assertEqual(ca.select_artifacts(payloads, [], None), [], "off unless requested")
        cutoff = datetime.now(timezone.utc) - timedelta(days=7)
        selected = ca.select_artifacts(payloads, [], cutoff)
        self.assertEqual([a["id"] for a, _ in selected], [1])
        self.assertIn("older than cutoff", selected[0][1])

    def test_an_unparseable_created_at_never_matches_the_age_cutoff(self):
        payload = artifact(1, head_sha=OTHER_SHA, created="not a timestamp")
        cutoff = datetime.now(timezone.utc) + timedelta(days=1)
        self.assertEqual(ca.select_artifacts([payload], [], cutoff), [])

    def test_sha_shaped_tokens_from_other_namespaces_are_rejected(self):
        for token in ("P2-S07", "Priority-04", "UI-PHASE-05", "Milestone-03"):
            self.assertFalse(ca.is_sha(token), token)
        self.assertTrue(ca.is_sha(HEAD_SHA))
        self.assertTrue(ca.is_sha(HEAD_SHA[:7]))


# --------------------------------------------------------------------------- #
# 3. dry run by default -- the single most important property
# --------------------------------------------------------------------------- #
class TestDryRun(CleanupArtifactsTestCase):

    def test_dry_run_deletes_nothing_but_prints_every_candidate(self):
        http = self.stub([artifact(1), artifact(2, name="n8n-lego-clean-clone-evidence", size=400_000),
                          artifact(3, head_sha=OTHER_SHA)])
        code, out = self.run_main(["--sha", HEAD_SHA])
        self.assertEqual(code, 0)
        self.assertEqual(http.deleted, [], "a dry run issues no DELETE")
        self.assertIn("DRY RUN", out)
        self.assertNotIn("mode=APPLY", out)
        self.assertIn("matched 2 artifact(s)", out)
        self.assertIn("id=1", out)
        self.assertIn("id=2", out)
        self.assertNotIn("id=3", out)
        self.assertIn("dry run: nothing deleted", out)
        self.assertEqual([m for m, _ in http.calls if m == "DELETE"], [])

    def test_apply_deletes_exactly_the_candidates(self):
        http = self.stub([artifact(1), artifact(2), artifact(3, head_sha=OTHER_SHA)])
        code, out = self.run_main(["--sha", HEAD_SHA, "--apply"])
        self.assertEqual(code, 0)
        self.assertEqual(sorted(http.deleted), [1, 2])
        self.assertIn("deleted 2/2 artifact(s)", out)
        self.assertIn("freed", out)

    def test_no_match_exits_zero_and_deletes_nothing(self):
        http = self.stub([artifact(1, head_sha=OTHER_SHA)])
        code, out = self.run_main(["--sha", HEAD_SHA, "--apply"])
        self.assertEqual(code, 0)
        self.assertEqual(http.deleted, [])
        self.assertIn("no artifact matched - nothing to do", out)


# --------------------------------------------------------------------------- #
# 4. listing
# --------------------------------------------------------------------------- #
class TestListing(CleanupArtifactsTestCase):

    def test_expired_artifacts_are_dropped(self):
        http = self.stub([artifact(1), artifact(2, expired=True)])
        code, out = self.run_main(["--sha", HEAD_SHA, "--apply"])
        self.assertEqual(code, 0)
        self.assertEqual(http.deleted, [1])
        self.assertIn("listed 1 live artifact(s)", out)

    def test_pagination_walks_every_page_and_stops_on_a_short_one(self):
        payloads = [artifact(i) for i in range(1, 251)]  # 2 full pages + 1 short
        http = self.stub(payloads, per_page=100)
        code, out = self.run_main(["--sha", HEAD_SHA])
        self.assertEqual(code, 0)
        gets = [u for m, u in http.calls if m == "GET"]
        self.assertEqual(len(gets), 3, gets)
        self.assertIn("page=3", gets[-1])
        self.assertIn("listed 250 live artifact(s)", out)

    def test_the_page_ceiling_is_respected_and_warned_about(self):
        payloads = [artifact(i) for i in range(1, 401)]
        http = self.stub(payloads, per_page=100)
        code, out = self.run_main(["--sha", HEAD_SHA, "--max-pages", "2"])
        self.assertEqual(code, 0)
        self.assertIn("stopped after 2 pages", out)
        self.assertEqual(len([u for m, u in http.calls if m == "GET"]), 2)

    def test_a_listing_error_is_reported_and_deletes_nothing(self):
        http = self.stub([artifact(1)])
        http.list_status = 403
        code, out = self.run_main(["--sha", HEAD_SHA, "--apply"])
        self.assertEqual(code, 1)
        self.assertEqual(http.deleted, [])
        self.assertIn("ERROR", out)
        self.assertIn("HTTP 403", out)

    def test_a_transport_failure_is_reported_not_raised(self):
        http = self.stub([artifact(1)])
        http.raise_on = "/actions/artifacts?"
        code, out = self.run_main(["--sha", HEAD_SHA, "--apply"])
        self.assertEqual(code, 1)
        self.assertIn("stubbed transport failure", out)
        self.assertNotIn("Traceback", out)


# --------------------------------------------------------------------------- #
# 5. delete outcomes
# --------------------------------------------------------------------------- #
class TestDeleteOutcomes(CleanupArtifactsTestCase):

    def test_404_counts_as_already_deleted(self):
        http = self.stub([artifact(1)])
        ok, detail = ca.delete_artifact("o", "r", 1, FAKE_TOKEN)
        self.assertTrue(ok)
        http.delete_status = 404
        ok, detail = ca.delete_artifact("o", "r", 1, FAKE_TOKEN)
        self.assertTrue(ok, "retention may have collected it first")
        self.assertIn("already deleted", detail)

    def test_a_refused_delete_fails_the_run_but_the_rest_is_still_attempted(self):
        http = self.stub([artifact(1), artifact(2), artifact(3)])
        http.delete_fail_ids = {2}
        code, out = self.run_main(["--sha", HEAD_SHA, "--apply"])
        self.assertEqual(code, 1)
        self.assertEqual(sorted(http.deleted), [1, 3], "one refusal does not abort the run")
        self.assertIn("deleted 2/3 artifact(s)", out)
        self.assertIn("FAILED id=2", out)
        self.assertIn("could not be deleted", out)

    def test_an_artifact_with_no_id_is_reported_not_crashed_on(self):
        payload = artifact(1)
        payload.pop("id")
        http = self.stub([payload])
        code, out = self.run_main(["--sha", HEAD_SHA, "--apply"])
        self.assertEqual(code, 1)
        self.assertIn("artifact with no id", out)

    def test_odd_sizes_are_tolerated(self):
        for size in (None, "16000000", "not-a-number"):
            payload = artifact(1, size=size)
            self.assertIsInstance(ca.artifact_size(payload), int)
        self.assertEqual(ca.artifact_size(artifact(1, size="2048")), 2048)
        self.assertEqual(ca.artifact_size(artifact(1, size=None)), 0)


# --------------------------------------------------------------------------- #
# 6. secrets and formatting
# --------------------------------------------------------------------------- #
class TestRedactionAndFormatting(CleanupArtifactsTestCase):

    def test_the_token_never_reaches_stdout(self):
        self.stub([artifact(1), artifact(2)])
        for argv in (["--sha", HEAD_SHA], ["--sha", HEAD_SHA, "--apply"]):
            _, out = self.run_main(argv)
            self.assertNotIn(FAKE_TOKEN, out)
            self.assertNotIn("ghp_", out)

    def test_redact_also_scrubs_a_token_that_arrived_by_another_route(self):
        self.assertNotIn("ghp_", ca.redact("leaked ghp_ABCdef0123456789 in a message"))
        self.assertNotIn("github_pat_", ca.redact("x github_pat_11ABCDEFGH abc"))
        self.assertEqual(ca.redact("no token here"), "no token here")

    def test_human_size_matches_the_quota_report_format(self):
        self.assertEqual(ca.human_size(0), "0 B")
        self.assertEqual(ca.human_size(512), "512 B")
        self.assertEqual(ca.human_size(2400), "2.3 KB")
        self.assertEqual(ca.human_size(16_000_000), "15.3 MB")
        self.assertEqual(ca.human_size(8_631_000_000), "8.0 GB")
        self.assertEqual(ca.human_size(3 * 1024 ** 4), "3.0 TB")

    def test_the_share_line_survives_a_zero_byte_listing(self):
        http = self.stub([artifact(1, size=0)])
        code, out = self.run_main(["--sha", HEAD_SHA])
        self.assertEqual(code, 0)
        self.assertIn("matched 1 artifact(s)", out)
        self.assertNotIn("% of live storage", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
