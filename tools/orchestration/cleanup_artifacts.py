#!/usr/bin/env python3
"""Delete the workflow artifacts a merged pull request left behind.

Companion to :mod:`cleanup_runner` (same workflow, ``.github/workflows/cleanup.yml``).
That tool frees the *branch*; this one frees the *storage*, and it exists because
artifact retention alone was not enough:

    2026-09-29  1681 live artifacts, 8.07 GB of a 10 GB quota, 0 expired
                "Failed to CreateArtifact: Artifact storage quota has been hit"
                -> three green jobs turned red, every merge on main blocked
                   under DEC-0015, while every test step in them had passed.

The workflows were fixed in the same change (short retention, uploads made
non-fatal, the 16 MB release tarball no longer uploaded per pull request). This
tool is the other half: it removes artifacts whose purpose is over. An artifact
uploaded to *prove a pull request was green* has proved it once that pull request
is merged, so the merge is the natural collection point.

In order it

1. resolves owner/repo from ``--owner``/``--repo`` or ``GITHUB_REPOSITORY``,
2. pages ``GET /repos/{o}/{r}/actions/artifacts`` and selects the artifacts whose
   ``workflow_run.head_sha`` equals one of the ``--sha`` values given (normally the
   PR head SHA and the merge commit SHA). Nothing else is ever selected: selection
   is by exact SHA, never by branch name, artifact-name pattern or date guesswork,
3. optionally also selects artifacts older than ``--max-age-days``, as a backstop
   for storage accumulated before this tool existed (off unless the flag is passed),
4. prints every candidate with its size, workflow run and the reason it matched,
   then deletes with ``DELETE .../actions/artifacts/{id}`` -- but only under
   ``--apply``. Without that flag the run is a dry run and changes nothing.

Exit codes: ``0`` success or nothing to do, ``1`` failure (partial deletes are
reported, never retried blindly), ``2`` usage error.

No secret is read from the command line, written to a file or printed. The token
comes from the ``GITHUB_TOKEN`` environment variable; every output line passes
through :func:`redact`. The workflow grants ``actions: write`` for the DELETE.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

LOG_PREFIX = "[cleanup_artifacts]"

SHA_LENGTH = 40
# Ceiling on how many SHAs one run may select on, so a bad invocation cannot turn
# into a repository-wide sweep.
MAX_SHAS = 40
PER_PAGE = 100
# Hard ceiling on pages walked, so a runaway listing cannot loop forever.
DEFAULT_MAX_PAGES = 200
API_BASE = "https://api.github.com"
USER_AGENT = "n8n-rust-cleanup-artifacts/1.0"
TOKEN_PREFIXES = ("ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_")


class ApiError(RuntimeError):
    """Transport-level failure (DNS, timeout, connection reset, unparseable body)."""


# --------------------------------------------------------------------------- #
# output
# --------------------------------------------------------------------------- #
def redact(text: str) -> str:
    """Remove anything that looks like a GitHub token from ``text``."""
    token = os.environ.get("GITHUB_TOKEN", "")
    if token:
        text = text.replace(token, "***")
    # Defence in depth: also catch a token that arrived by another route.
    for prefix in TOKEN_PREFIXES:
        while True:
            start = text.find(prefix)
            if start < 0:
                break
            end = start + len(prefix)
            while end < len(text) and (text[end].isalnum() or text[end] == "_"):
                end += 1
            text = text[:start] + "***" + text[end:]
    return text


def log(message: str) -> None:
    """Print one prefixed line, with any bearer token scrubbed out first."""
    print(f"{LOG_PREFIX} {redact(message)}", flush=True)


def fail(message: str) -> int:
    log(f"ERROR: {message}")
    return 1


def usage_error(message: str) -> int:
    log(f"USAGE ERROR: {message}")
    return 2


# --------------------------------------------------------------------------- #
# HTTP -- one seam, so the tests never touch the network
# --------------------------------------------------------------------------- #
def request(method: str, url: str, token: str, timeout: float = 30.0) -> Tuple[int, Any]:
    """Perform one API call; return ``(status, parsed_json_or_None)``.

    ``204`` (delete succeeded) yields ``(204, None)``. Transport errors are raised
    as :class:`ApiError` so every caller reports them the same way.
    """
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", USER_AGENT)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            status = response.status
            body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:  # non-2xx still carries a usable body
        status = exc.code
        body = exc.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ApiError(f"{method} {url} failed: {exc}") from exc

    if not body.strip():
        return status, None
    try:
        return status, json.loads(body)
    except json.JSONDecodeError as exc:
        raise ApiError(f"{method} {url} returned unparseable JSON: {exc}") from exc


# --------------------------------------------------------------------------- #
# selection
# --------------------------------------------------------------------------- #
def is_sha(value: str) -> bool:
    """True for a full or abbreviated lowercase hex commit SHA."""
    return 7 <= len(value) <= SHA_LENGTH and all(c in "0123456789abcdef" for c in value)


def parse_created_at(value: Optional[str]) -> Optional[datetime]:
    """Parse an artifact ``created_at`` timestamp; ``None`` when unusable."""
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def artifact_size(artifact: Dict[str, Any]) -> int:
    """``size_in_bytes`` as an int, tolerating strings and missing values."""
    try:
        return int(artifact.get("size_in_bytes"))
    except (TypeError, ValueError):
        return 0


def human_size(size_bytes: int) -> str:
    """Render a byte count the way the quota report does."""
    value = float(size_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024:
            return f"{int(value)} B" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def matches(
    artifact: Dict[str, Any],
    shas: Sequence[str],
    cutoff: Optional[datetime],
) -> Tuple[bool, str]:
    """Decide whether ``artifact`` is a candidate, and say why.

    The reason is printed for every candidate so a reviewer can audit the
    selection without re-deriving it.
    """
    run = artifact.get("workflow_run") or {}
    head_sha = str(run.get("head_sha") or "")
    for sha in shas:
        if head_sha and (head_sha == sha or head_sha.startswith(sha)):
            return True, f"head_sha={head_sha[:12]} matches --sha {sha[:12]}"
    if cutoff is not None:
        created = parse_created_at(artifact.get("created_at"))
        if created is not None and created < cutoff:
            return True, f"created_at={created:%Y-%m-%d} older than cutoff"
    return False, ""


def select_artifacts(
    artifacts: Iterable[Dict[str, Any]],
    shas: Sequence[str],
    cutoff: Optional[datetime],
) -> List[Tuple[Dict[str, Any], str]]:
    """Return ``(artifact, reason)`` pairs for every candidate, in input order."""
    selected: List[Tuple[Dict[str, Any], str]] = []
    for artifact in artifacts:
        hit, reason = matches(artifact, shas, cutoff)
        if hit:
            selected.append((artifact, reason))
    return selected


def list_artifacts(owner: str, repo: str, token: str, max_pages: int) -> List[Dict[str, Any]]:
    """Page the artifact listing. Expired artifacts are dropped."""
    collected: List[Dict[str, Any]] = []
    page = 1
    while page <= max_pages:
        url = f"{API_BASE}/repos/{owner}/{repo}/actions/artifacts?per_page={PER_PAGE}&page={page}"
        status, payload = request("GET", url, token)
        if status != 200:
            raise ApiError(f"listing artifacts failed with HTTP {status}: {payload}")
        if not isinstance(payload, dict):
            raise ApiError("artifact listing returned an unexpected payload shape")
        batch = payload.get("artifacts") or []
        collected.extend(a for a in batch if isinstance(a, dict) and not a.get("expired"))
        if len(batch) < PER_PAGE:
            return collected
        page += 1
    log(f"WARNING: stopped after {max_pages} pages; the listing may be incomplete")
    return collected


def delete_artifact(owner: str, repo: str, artifact_id: Any, token: str) -> Tuple[bool, str]:
    """Delete one artifact. Never raises; reports the outcome instead."""
    url = f"{API_BASE}/repos/{owner}/{repo}/actions/artifacts/{artifact_id}"
    try:
        status, payload = request("DELETE", url, token)
    except ApiError as exc:
        return False, str(exc)
    if status in (200, 204):
        return True, f"HTTP {status}"
    if status == 404:
        # Already gone: retention collected it, or a concurrent run deleted it.
        return True, "HTTP 404 - already deleted"
    return False, f"HTTP {status}: {payload}"


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Delete the workflow artifacts left behind by a merged pull request.",
    )
    parser.add_argument("--sha", action="append", default=[], metavar="SHA",
                        help="commit SHA whose artifacts should be deleted (repeatable)")
    parser.add_argument("--pr", metavar="N", help="pull request number, for the log line only")
    parser.add_argument("--owner", help="repository owner (default: from GITHUB_REPOSITORY)")
    parser.add_argument("--repo", help="repository name (default: from GITHUB_REPOSITORY)")
    parser.add_argument("--max-age-days", type=int, metavar="D",
                        help="also delete artifacts older than D days (backstop; off by default)")
    parser.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES,
                        help=f"listing pages to walk at {PER_PAGE} per page (default {DEFAULT_MAX_PAGES})")
    parser.add_argument("--apply", action="store_true",
                        help="actually delete; without this flag the run is a dry run")
    return parser


def resolve_owner_repo(args: argparse.Namespace) -> Tuple[Optional[str], Optional[str]]:
    """Take owner/repo from the flags, else from ``GITHUB_REPOSITORY``."""
    owner, repo = args.owner, args.repo
    if owner and repo:
        return owner, repo
    slug = os.environ.get("GITHUB_REPOSITORY", "")
    if "/" in slug:
        env_owner, env_repo = slug.split("/", 1)
        return owner or env_owner, repo or env_repo
    return owner, repo


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token:
        return usage_error(
            "GITHUB_TOKEN is not set (it must come from the environment, never the command line)"
        )

    owner, repo = resolve_owner_repo(args)
    if not owner or not repo:
        return usage_error("could not resolve owner/repo: pass --owner/--repo or set GITHUB_REPOSITORY")

    shas = [s.strip().lower() for s in args.sha if s.strip()]
    cutoff: Optional[datetime] = None
    if args.max_age_days is not None:
        if args.max_age_days < 0:
            return usage_error("--max-age-days must not be negative")
        cutoff = datetime.now(timezone.utc) - timedelta(days=args.max_age_days)

    if not shas and cutoff is None:
        return usage_error("nothing selected: pass at least one --sha or --max-age-days")
    for sha in shas:
        if not is_sha(sha):
            return usage_error(f"'{sha}' is not a commit SHA")
    if len(shas) > MAX_SHAS:
        return usage_error(f"refusing to select on more than {MAX_SHAS} SHAs in one run")

    criteria = ", ".join(
        [f"sha={s[:12]}" for s in shas]
        + ([f"older than {args.max_age_days} days"] if cutoff is not None else [])
    )
    log(f"target={owner}/{repo} pr={args.pr or 'n/a'} criteria=[{criteria}] "
        f"mode={'APPLY' if args.apply else 'DRY RUN'}")

    try:
        artifacts = list_artifacts(owner, repo, token, args.max_pages)
    except ApiError as exc:
        return fail(str(exc))

    total_bytes = sum(artifact_size(a) for a in artifacts)
    log(f"listed {len(artifacts)} live artifact(s), {human_size(total_bytes)} total")

    candidates = select_artifacts(artifacts, shas, cutoff)
    if not candidates:
        log("no artifact matched - nothing to do")
        return 0

    selected_bytes = sum(artifact_size(a) for a, _ in candidates)
    share = f" ({100.0 * selected_bytes / total_bytes:.1f}% of live storage)" if total_bytes else ""
    log(f"matched {len(candidates)} artifact(s), {human_size(selected_bytes)}{share}")

    for artifact, reason in candidates:
        run = artifact.get("workflow_run") or {}
        # The artifacts endpoint does not always populate workflow_run.name, but it
        # always carries the run id - which is what a reviewer needs to audit a delete.
        run_label = run.get("name") or (f"run {run['id']}" if run.get("id") else "?")
        log("  candidate id={id} name={name} size={size} run={run} created={created} :: {why}".format(
            id=artifact.get("id"), name=artifact.get("name"),
            size=human_size(artifact_size(artifact)), run=run_label,
            created=(artifact.get("created_at") or "?")[:10], why=reason))

    if not args.apply:
        log("dry run: nothing deleted. Re-run with --apply to delete the candidates above.")
        return 0

    deleted = freed = 0
    failures: List[str] = []
    for artifact, _ in candidates:
        artifact_id = artifact.get("id")
        if artifact_id is None:
            failures.append(f"artifact with no id: {artifact.get('name')}")
            continue
        ok, detail = delete_artifact(owner, repo, artifact_id, token)
        if ok:
            deleted += 1
            freed += artifact_size(artifact)
            log(f"  deleted id={artifact_id} name={artifact.get('name')} ({detail})")
        else:
            failures.append(f"id={artifact_id} name={artifact.get('name')}: {detail}")
            log(f"  FAILED id={artifact_id} name={artifact.get('name')}: {detail}")

    log(f"deleted {deleted}/{len(candidates)} artifact(s), freed {human_size(freed)}")
    if failures:
        return fail(f"{len(failures)} artifact(s) could not be deleted: {'; '.join(failures[:5])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
