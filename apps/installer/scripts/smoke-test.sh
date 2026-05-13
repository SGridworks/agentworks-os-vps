#!/usr/bin/env bash
#
# smoke-test.sh — end-to-end install verification for AgentWorks OS.
#
# Tests the substrate the way a real customer (and an agent) actually exercises
# it: create a tenant, ask the policy engine to evaluate an action, parse the
# response, assert the decision shape. Returns 0 if every step succeeds.
#
# Designed to be runnable by an AI agent: every step prints a single-line
# status, exits non-zero on the first failure, and the failure line tells the
# agent what to do next.
#
# Usage:
#   ./apps/installer/scripts/smoke-test.sh                # default daemon URL
#   AGENTOS_URL=http://localhost:7710 ./smoke-test.sh     # override URL
#
set -euo pipefail

readonly DAEMON_URL="${AGENTOS_URL:-http://127.0.0.1:7710}"
readonly TIMEOUT_SECS="${SMOKE_TIMEOUT_SECS:-90}"

if [[ -t 1 ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
fi

pass()  { echo -e "${GREEN}[PASS]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*" >&2; }
info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }

require_cmd() {
  if ! command -v "$1" &>/dev/null; then
    fail "Missing required command: $1"
    fail "Install $1 and re-run."
    exit 2
  fi
}

require_cmd curl
require_cmd python3

# -----------------------------------------------------------------------------
# Step 1 — daemon is reachable
# -----------------------------------------------------------------------------
info "Polling ${DAEMON_URL}/api/health (up to ${TIMEOUT_SECS}s)..."
elapsed=0
until curl -sf -m 3 "${DAEMON_URL}/api/health" >/dev/null 2>&1; do
  if (( elapsed >= TIMEOUT_SECS )); then
    fail "agentos-d did not respond at ${DAEMON_URL}/api/health within ${TIMEOUT_SECS}s."
    fail "Diagnose: docker compose logs agentos-d --tail 100"
    fail "Common causes: container OOMed, migration crash, or port 7710 blocked by another process."
    exit 1
  fi
  sleep 3
  elapsed=$(( elapsed + 3 ))
done
pass "agentos-d /api/health is up."

health_body=$(curl -sf "${DAEMON_URL}/api/health")
if ! echo "$health_body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  fail "Health endpoint returned without status=ok: $health_body"
  exit 1
fi

# -----------------------------------------------------------------------------
# Step 2 — allocate an ephemeral tenant id
# -----------------------------------------------------------------------------
tenant_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
pass "Using ephemeral tenant id for smoke policy check: ${tenant_id}"

# -----------------------------------------------------------------------------
# Step 3 — policy.check round-trip
# -----------------------------------------------------------------------------
info "POST ${DAEMON_URL}/api/policy/check — evaluating a benign action..."
policy_resp=$(curl -sS -X POST "${DAEMON_URL}/api/policy/check" \
  -H 'content-type: application/json' \
  -d "$(cat <<EOF
{
  "tenantId": "${tenant_id}",
  "actionKind": "smoke.test",
  "payload": {"sample": "value"},
  "actorId": "smoke-test",
  "actorLabel": "installer smoke test",
  "actorType": "system",
  "summary": "installer smoke test ping"
}
EOF
)" 2>&1) || {
  fail "POST /api/policy/check failed: $policy_resp"
  fail "Diagnose: docker compose logs agentos-d --tail 100"
  exit 1
}

decision=$(printf '%s' "$policy_resp" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("decision") or "")' 2>/dev/null) \
  || decision=""

case "$decision" in
  allow|block|route_to_review)
    pass "policy.check returned a valid decision: ${decision}"
    ;;
  "")
    fail "policy.check response had no decision field: $policy_resp"
    exit 1
    ;;
  *)
    fail "policy.check returned an unexpected decision: ${decision}"
    fail "Full response: $policy_resp"
    exit 1
    ;;
esac

# -----------------------------------------------------------------------------
# Step 4 — scanner-worker /health (FATAL).
# Stub mode is the default in docker-compose.yml as of v0.1.7, so /health
# should respond in <1s. If it doesn't, the sidecar is genuinely broken
# and the install gate must fail loudly. Set SMOKE_SCANNER_OPTIONAL=1 to
# downgrade to a warning (the historical pre-v0.1.8 behavior) — useful
# only when running with EMBEDDING_MODE=real on a slow link.
# -----------------------------------------------------------------------------
scanner_optional="${SMOKE_SCANNER_OPTIONAL:-0}"
scanner_url="${SCANNER_URL:-http://127.0.0.1:3101}"
scanner_timeout="${SMOKE_SCANNER_TIMEOUT:-30}"

elapsed=0
until curl -sf -m 3 "${scanner_url}/health" >/dev/null 2>&1; do
  if (( elapsed >= scanner_timeout )); then
    if [[ "$scanner_optional" == "1" ]]; then
      warn "scanner-worker /health unreachable on ${scanner_url} after ${scanner_timeout}s. SMOKE_SCANNER_OPTIONAL=1, continuing."
      warn "Investigate: docker compose logs scanner-worker --tail 50"
      break
    fi
    fail "scanner-worker /health unreachable on ${scanner_url} after ${scanner_timeout}s."
    fail "Diagnose: docker compose logs scanner-worker --tail 100"
    fail "If you're running EMBEDDING_MODE=real, the sidecar may still be downloading model weights;"
    fail "re-run with SMOKE_SCANNER_OPTIONAL=1 to make this a warning instead of a failure."
    exit 1
  fi
  sleep 2
  elapsed=$(( elapsed + 2 ))
done
[[ "$scanner_optional" == "1" && $elapsed -ge $scanner_timeout ]] || pass "scanner-worker /health is up."

# -----------------------------------------------------------------------------
# Step 5 — n8n /healthz (FATAL by default).
# n8n is part of the installed stack. First boot can take 20-60s on a slow
# disk, so this gets a longer timeout than scanner-worker. Set
# SMOKE_N8N_OPTIONAL=1 to downgrade to a warning for daemon-only debugging.
# -----------------------------------------------------------------------------
n8n_optional="${SMOKE_N8N_OPTIONAL:-0}"
n8n_url="${N8N_URL:-http://127.0.0.1:5678}"
n8n_timeout="${SMOKE_N8N_TIMEOUT:-120}"

elapsed=0
until curl -sf -m 3 "${n8n_url}/healthz" >/dev/null 2>&1; do
  if (( elapsed >= n8n_timeout )); then
    if [[ "$n8n_optional" == "1" ]]; then
      warn "n8n /healthz unreachable on ${n8n_url} after ${n8n_timeout}s. SMOKE_N8N_OPTIONAL=1, continuing."
      break
    fi
    fail "n8n /healthz unreachable on ${n8n_url} after ${n8n_timeout}s."
    fail "Diagnose: docker compose logs n8n --tail 100"
    exit 1
  fi
  sleep 5
  elapsed=$(( elapsed + 5 ))
done
[[ "$n8n_optional" == "1" && $elapsed -ge $n8n_timeout ]] || pass "n8n /healthz is up."

# -----------------------------------------------------------------------------
# Step 6 — admin-ui route health (FATAL by default).
# The VPS-enabled release runs the browser dashboard in the default compose
# stack. A 500 here means the dashboard cannot proxy back to agentos-d.
# -----------------------------------------------------------------------------
admin_optional="${SMOKE_ADMIN_OPTIONAL:-0}"
admin_url="${ADMIN_URL:-http://127.0.0.1:3000}"
admin_timeout="${SMOKE_ADMIN_TIMEOUT:-60}"

elapsed=0
until curl -sf -m 5 "${admin_url}/mission-control" >/dev/null 2>&1; do
  if (( elapsed >= admin_timeout )); then
    if [[ "$admin_optional" == "1" ]]; then
      warn "admin-ui /mission-control unreachable on ${admin_url} after ${admin_timeout}s. SMOKE_ADMIN_OPTIONAL=1, continuing."
      break
    fi
    fail "admin-ui /mission-control unreachable on ${admin_url} after ${admin_timeout}s."
    fail "Diagnose: docker compose logs admin-ui --tail 100"
    exit 1
  fi
  sleep 5
  elapsed=$(( elapsed + 5 ))
done
[[ "$admin_optional" == "1" && $elapsed -ge $admin_timeout ]] || pass "admin-ui /mission-control is up."

# Postgres health — without this the smoke gate can pass while a service has
# silently failed (you'd see it in `agentworks status`, but only if you check).
info "Checking postgres readiness..."
pg_container="$(docker ps --filter 'label=com.docker.compose.service=postgres' --format '{{.ID}}' | head -1)"
if [[ -z "$pg_container" ]]; then
  fail "postgres container not running (compose label lookup returned nothing)."
  fail "Diagnose: agentworks status ; agentworks logs postgres"
  exit 1
fi
if ! docker exec "$pg_container" pg_isready -U agentworks -d agentworks &>/dev/null; then
  fail "postgres pg_isready returned non-zero."
  fail "Diagnose: agentworks logs postgres"
  exit 1
fi
pass "postgres is accepting connections."

# Sanity-check the admin BFF endpoints that back documented first-run features.
# A 500 here means the admin shell renders but the page returns broken data.
if [[ "$admin_optional" != "1" ]]; then
  for endpoint in /api/admin/vault-graph; do
    if ! curl -fsS -m 5 "${admin_url}${endpoint}" >/dev/null 2>&1; then
      fail "admin-ui BFF endpoint ${endpoint} returned non-200."
      fail "Diagnose: curl -i ${admin_url}${endpoint} ; agentworks logs admin-ui"
      exit 1
    fi
  done
  pass "admin-ui BFF endpoints respond 200."
fi

# -----------------------------------------------------------------------------
# Step 8 — n8n custom nodes are actually loadable
#
# /healthz only verifies n8n is alive; it doesn't verify the AgentWorks
# Policy/Memory/Dispatch nodes are present and discoverable. The package
# layout is fragile (Dockerfile install path × N8N_CUSTOM_EXTENSIONS env);
# a regression in either silently breaks every workflow.
# -----------------------------------------------------------------------------
n8n_optional="${SMOKE_N8N_OPTIONAL:-0}"
if [[ "$n8n_optional" != "1" ]]; then
  info "Checking n8n custom nodes load..."
  N8N_NODE_FILES=(
    "/opt/agentworks-extensions/node_modules/@agentworks/n8n-nodes/dist/policy-check/PolicyCheck.node.js"
    "/opt/agentworks-extensions/node_modules/@agentworks/n8n-nodes/dist/memory/MemoryRead.node.js"
    "/opt/agentworks-extensions/node_modules/@agentworks/n8n-nodes/dist/memory/MemoryWrite.node.js"
    "/opt/agentworks-extensions/node_modules/@agentworks/n8n-nodes/dist/dispatch/Dispatch.node.js"
  )
  # Find the n8n container by image label, regardless of compose project name.
  n8n_container="$(docker ps --filter 'label=com.docker.compose.service=n8n' --format '{{.ID}}' | head -1)"
  if [[ -z "$n8n_container" ]]; then
    warn "Could not locate n8n container (compose label lookup failed); skipping nodes check."
  else
    missing=0
    for nf in "${N8N_NODE_FILES[@]}"; do
      if ! docker exec "$n8n_container" test -f "$nf" 2>/dev/null; then
        warn "n8n node missing in container: $nf"
        missing=$((missing + 1))
      fi
    done
    if (( missing > 0 )); then
      fail "${missing} AgentWorks n8n node file(s) not present in n8n container."
      fail "Diagnose: docker exec ${n8n_container} ls -R /opt/agentworks-extensions"
      exit 1
    fi
    pass "AgentWorks n8n nodes load (4/4 .node.js files present)."
  fi
fi

echo ""
echo "=============================================================================="
echo -e "${GREEN}AgentWorks OS smoke test PASSED${NC}"
echo "=============================================================================="
echo "  Daemon URL:  ${DAEMON_URL}"
echo "  Tenant ID:   ${tenant_id}"
echo "  Decision:    ${decision}"
echo ""
echo "The substrate is responding to writes and the policy engine is online."
echo "Next: wire an MCP client. See README.md."
exit 0
