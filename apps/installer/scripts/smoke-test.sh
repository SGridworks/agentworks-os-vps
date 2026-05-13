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
require_cmd docker

extract_json_string() {
  local key="$1"
  sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

diagnose_service() {
  local service="$1"
  if command -v agentworks &>/dev/null; then
    fail "Diagnose: agentworks logs ${service}"
  else
    fail "Diagnose: cd ~/.agentworks/source && COMPOSE_PROJECT_NAME=${compose_project:-<project>} docker compose logs ${service} --tail 100"
  fi
}

compose_project="${SMOKE_COMPOSE_PROJECT:-}"
detect_compose_project() {
  if [[ -n "$compose_project" ]]; then
    return 0
  fi

  local compose_agentos_container
  compose_agentos_container="$(docker compose ps -q agentos-d 2>/dev/null | head -n 1 || true)"
  if [[ -n "$compose_agentos_container" ]]; then
    compose_project="$(docker inspect \
      --format '{{ index .Config.Labels "com.docker.compose.project" }}' \
      "$compose_agentos_container")"
    return 0
  fi

  local projects
  projects="$(docker ps \
    --filter 'label=com.docker.compose.service=agentos-d' \
    --format '{{.Label "com.docker.compose.project"}}' \
    | sort -u)"
  if [[ "$(printf '%s\n' "$projects" | sed '/^$/d' | wc -l | tr -d ' ')" != "1" ]]; then
    fail "Could not infer a single compose project for agentos-d. Set SMOKE_COMPOSE_PROJECT and re-run."
    exit 1
  fi
  compose_project="$projects"
}

service_container() {
  local service="$1"
  local args=(--filter "label=com.docker.compose.service=${service}")
  if [[ -n "$compose_project" ]]; then
    args+=(--filter "label=com.docker.compose.project=${compose_project}")
  fi
  docker ps "${args[@]}" --format '{{.ID}}' | head -n 1
}

smoke_tenant_id=""
cleanup_smoke_tenant() {
  if [[ -n "${smoke_tenant_id:-}" ]]; then
    curl -fsS -X DELETE "${DAEMON_URL}/api/tenants/${smoke_tenant_id}" >/dev/null 2>&1 \
      || warn "Could not delete disposable smoke tenant ${smoke_tenant_id}; remove it from the admin tenant registry."
  fi
}
trap cleanup_smoke_tenant EXIT

# -----------------------------------------------------------------------------
# Step 1 — daemon is reachable
# -----------------------------------------------------------------------------
info "Polling ${DAEMON_URL}/api/health (up to ${TIMEOUT_SECS}s)..."
elapsed=0
until curl -sf -m 3 "${DAEMON_URL}/api/health" >/dev/null 2>&1; do
  if (( elapsed >= TIMEOUT_SECS )); then
    fail "agentos-d did not respond at ${DAEMON_URL}/api/health within ${TIMEOUT_SECS}s."
    diagnose_service agentos-d
    fail "Common causes: container OOMed, migration crash, or port 7710 blocked by another process."
    exit 1
  fi
  sleep 3
  elapsed=$(( elapsed + 3 ))
done
pass "agentos-d /api/health is up."
detect_compose_project

health_body=$(curl -sf "${DAEMON_URL}/api/health")
if ! echo "$health_body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  fail "Health endpoint returned without status=ok: $health_body"
  exit 1
fi

# -----------------------------------------------------------------------------
# Step 2 — create a disposable tenant through the public API
# -----------------------------------------------------------------------------
info "POST ${DAEMON_URL}/api/tenants — creating disposable smoke tenant..."
tenant_resp=$(curl -fsS -X POST "${DAEMON_URL}/api/tenants" \
  -H 'content-type: application/json' \
  -d '{"name":"Installer Smoke Test","description":"Disposable tenant created by apps/installer/scripts/smoke-test.sh","industry":"other"}' 2>&1) || {
  fail "POST /api/tenants failed: $tenant_resp"
  diagnose_service agentos-d
  exit 1
}

tenant_id=$(printf '%s' "$tenant_resp" | extract_json_string id)
if [[ -z "$tenant_id" ]]; then
  fail "POST /api/tenants response had no id field: $tenant_resp"
  exit 1
fi
smoke_tenant_id="$tenant_id"
pass "Created disposable smoke tenant: ${tenant_id}"

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
  diagnose_service agentos-d
  exit 1
}

decision=$(printf '%s' "$policy_resp" | extract_json_string decision)

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
      warn "Investigate: agentworks logs scanner-worker"
      break
    fi
    fail "scanner-worker /health unreachable on ${scanner_url} after ${scanner_timeout}s."
    diagnose_service scanner-worker
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
    diagnose_service n8n
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
    diagnose_service admin-ui
    exit 1
  fi
  sleep 5
  elapsed=$(( elapsed + 5 ))
done
[[ "$admin_optional" == "1" && $elapsed -ge $admin_timeout ]] || pass "admin-ui /mission-control is up."

# Postgres health — without this the smoke gate can pass while a service has
# silently failed (you'd see it in `agentworks status`, but only if you check).
info "Checking postgres readiness..."
pg_container="$(service_container postgres)"
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

# Sanity-check the admin BFF endpoint that backs documented vault graph data.
# It must see a real note for the disposable tenant, not merely return HTTP 200
# with an empty graph.
if [[ "$admin_optional" != "1" ]]; then
  smoke_key="smoke/admin-vault-graph"
  write_resp=$(curl -fsS -X POST "${DAEMON_URL}/api/memory/write" \
    -H 'content-type: application/json' \
    -d "{\"tenantId\":\"${tenant_id}\",\"key\":\"${smoke_key}\",\"body\":\"# Admin Vault Graph Smoke\\n\\nLinked from installer smoke.\",\"mode\":\"replace\"}" 2>&1) || {
    fail "POST /api/memory/write failed: $write_resp"
    diagnose_service agentos-d
    exit 1
  }
  graph_resp=$(curl -fsS -m 5 "${admin_url}/api/admin/vault-graph?tenantId=${tenant_id}" 2>&1) || {
    fail "admin-ui BFF endpoint /api/admin/vault-graph returned non-200: $graph_resp"
    fail "Diagnose: curl -i ${admin_url}/api/admin/vault-graph?tenantId=${tenant_id} ; agentworks logs admin-ui"
    exit 1
  }
  if ! printf '%s' "$graph_resp" | grep -q "\"id\":\"${smoke_key}\""; then
    fail "admin-ui vault graph did not include the smoke memory page."
    fail "Response: $graph_resp"
    exit 1
  fi
  pass "admin-ui vault graph sees tenant memory data."
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
    "/opt/agentworks-extensions/node_modules/@agentworks/n8n-nodes/dist/automation/AutomationAction.node.js"
  )
  n8n_container="$(service_container n8n)"
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
    automation_node="/opt/agentworks-extensions/node_modules/@agentworks/n8n-nodes/dist/automation/AutomationAction.node.js"
    if ! docker exec "$n8n_container" node -e "const fs=require('fs');const file='${automation_node}';const source=fs.readFileSync(file,'utf8');if(!source.includes('http://agentos-d:7710')){console.error('Automation node default daemon URL is not http://agentos-d:7710');process.exit(1);}fetch('http://agentos-d:7710/api/health').then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);const body=await r.json();if(body.status!=='ok')throw new Error('health status is not ok');}).catch(e=>{console.error(e.message);process.exit(1);})"; then
      fail "Automation n8n node cannot reach the daemon at its Docker default URL."
      fail "Diagnose: docker exec ${n8n_container} node -e \"fetch('http://agentos-d:7710/api/health').then(r=>console.log(r.status))\""
      exit 1
    fi
    pass "AgentWorks n8n nodes load (5/5 .node.js files present; automation default URL works)."
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
