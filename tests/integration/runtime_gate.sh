#!/usr/bin/env bash
# W3 — TypeScript runtime gate (single entry point for CI and the laptop runner).
#
#   Stage 1  engine LEGO unit tests          (packages/reconstructed-engine)
#   Stage 2  runtime unit tests              (apps/n8n-ts)
#   Stage 3  typecheck                       (tsc --noEmit)
#   Stage 4  real-process runtime suite      (tests/runtime: health, execution,
#            malformed, empty, unknown node, restart, configuration, regression)
#   Stage 5  single-engine integration audit (tests/integration)
#
# Exit 0 only when every stage passes. No stage is ever skipped silently.
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
fail=0
declare -a SUMMARY=()

stage() {
  local name="$1"; shift
  echo
  echo "######## ${name} ########"
  if "$@"; then
    SUMMARY+=("PASS  ${name}")
  else
    SUMMARY+=("FAIL  ${name}")
    fail=1
  fi
}

stage_engine_unit() {
  node --test packages/reconstructed-engine/test/*.test.mjs
}

stage_runtime_unit() {
  node --test apps/n8n-ts/test/*.test.mjs
}

stage_typecheck() {
  local tsc="$ROOT/apps/n8n-ts/node_modules/.bin/tsc"
  if [ ! -x "$tsc" ]; then
    echo "[gate] typescript not installed — installing dev dependencies for apps/n8n-ts"
    npm --prefix "$ROOT/apps/n8n-ts" ci --no-audit --no-fund >/dev/null 2>&1 \
      || npm --prefix "$ROOT/apps/n8n-ts" install --no-audit --no-fund >/dev/null 2>&1
  fi
  if [ ! -x "$tsc" ]; then
    echo "[gate] tsc is unavailable — typecheck cannot run (this is a failure, not a skip)"
    return 1
  fi
  ( cd "$ROOT" && "$tsc" --noEmit -p apps/n8n-ts/tsconfig.json )
}

stage_runtime_suite() {
  node --test tests/runtime/*.test.mjs
}

stage_integration_audit() {
  node tests/integration/runtime_lego_integration.mjs
}

stage "STAGE 1/5 engine LEGO unit tests" stage_engine_unit
stage "STAGE 2/5 runtime unit tests" stage_runtime_unit
stage "STAGE 3/5 typecheck (tsc --noEmit)" stage_typecheck
stage "STAGE 4/5 real-process runtime suite" stage_runtime_suite
stage "STAGE 5/5 single-engine integration audit" stage_integration_audit

echo
echo "======================================================="
for line in "${SUMMARY[@]}"; do echo "  ${line}"; done
echo "======================================================="
if [ "$fail" -ne 0 ]; then
  echo ">>> TYPESCRIPT RUNTIME GATE: BLOCKED <<<"
  exit 1
fi
echo ">>> TYPESCRIPT RUNTIME GATE: PASS <<<"
