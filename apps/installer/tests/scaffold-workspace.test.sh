#!/usr/bin/env bash
#
# Smoke test for scaffold-workspace.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAFFOLD="$SCRIPT_DIR/../scripts/scaffold-workspace.sh"
TEST_DIR="/tmp/test-workspace-$$"
TENANT_ID="test-tenant-1234"
DAEMON_URL="http://localhost:9999"

cleanup() { rm -rf "$TEST_DIR"; }
trap cleanup EXIT

die() { echo "[FAIL] $*" >&2; exit 1; }
pass() { echo "[PASS] $*"; }
info() { echo "[INFO] $*"; }

info "Scaffolding into $TEST_DIR..."
bash "$SCAFFOLD" "$TEST_DIR" \
  --tenant-id="$TENANT_ID" \
  --daemon-url="$DAEMON_URL"

# Assert files exist
for f in AGENTS.md progress.md feature_list.json feature_list.schema.json; do
  [[ -f "$TEST_DIR/$f" ]] || die "Missing file: $f"
done
pass "All expected files present"

# Assert AGENTS.md references tenant id and daemon URL
grep -q "$TENANT_ID" "$TEST_DIR/AGENTS.md" || die "AGENTS.md missing tenantId"
grep -q "$DAEMON_URL" "$TEST_DIR/AGENTS.md" || die "AGENTS.md missing daemonUrl"
pass "AGENTS.md contains tenantId and daemonUrl"

# Assert AGENTS.md is well-formed Markdown (starts with H1, has sections)
head -1 "$TEST_DIR/AGENTS.md" | grep -q "^# " || die "AGENTS.md missing H1"
grep -q "^## " "$TEST_DIR/AGENTS.md" || die "AGENTS.md missing H2 sections"
pass "AGENTS.md is well-formed Markdown"

# Assert feature_list.json conforms to schema (basic structural check)
python3 -c "
import json, sys
with open('$TEST_DIR/feature_list.json') as f:
    data = json.load(f)
assert data['version'] == '1.0.0', 'version mismatch'
assert data['tenantId'] == '$TENANT_ID', 'tenantId mismatch'
assert isinstance(data['features'], list), 'features not a list'
print('[PASS] feature_list.json is valid JSON and structurally correct')
" || die "feature_list.json validation failed"

# Assert zero forbidden lineage names in customer-facing docs
FORBIDDEN="paperclip|obsidian|Hermes|OpenClaw|gstack"
if grep -riE "$FORBIDDEN" "$TEST_DIR"/*.md "$TEST_DIR"/*.json 2>/dev/null; then
  die "Customer-facing docs contain forbidden lineage names"
fi
pass "No forbidden lineage names in customer-facing docs"

info "All tests passed."
