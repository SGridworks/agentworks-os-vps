#!/usr/bin/env bash
# Backup → wipe → restore full-cycle test.
#
# Exercises `agentworks backup` and `agentworks restore` end-to-end against
# a fake AGENTWORKS_DIR. Verifies vault content, SQLite DB byte-equality,
# and config restoration after a wipe.
#
# Docker is PATH-mocked because the CLI invokes `docker compose down/up`
# during restore. The test cares about data round-trip, not container
# lifecycle.
#
# Run from repo root:
#   bash apps/installer/tests/backup-restore.test.sh
#
# Exits 0 on full-cycle success, non-zero with a diagnostic on failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI="$REPO_ROOT/apps/installer/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo "FAIL: built CLI not found at $CLI"
  echo "Run: pnpm --dir apps/installer build"
  exit 1
fi

# Ephemeral sandbox so we never touch the user's real ~/.agentworks
SANDBOX="$(mktemp -d -t awo-backup-test-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

export AGENTWORKS_DIR="$SANDBOX/agentworks"
export AGENTWORKS_VAULT_PATH="$SANDBOX/vault"
export AGENTWORKS_BACKUP_PASSPHRASE="test-passphrase-do-not-use"

mkdir -p "$AGENTWORKS_DIR/config" "$AGENTWORKS_DIR/data" "$AGENTWORKS_VAULT_PATH"

# Seed: env file (marks isInstalled), vault content, sqlite db
echo "AGENTOS_PORT=7710" > "$AGENTWORKS_DIR/config/.env"
echo "RULE_PACKS_DIR=/opt/agentworks/rule-packs" >> "$AGENTWORKS_DIR/config/.env"
echo "tenant-001 onboarding notes" > "$AGENTWORKS_VAULT_PATH/notes.md"
echo "deeper" > "$AGENTWORKS_VAULT_PATH/sub.md"
mkdir -p "$AGENTWORKS_VAULT_PATH/tenant-001"
echo "## TCPA exposure log" > "$AGENTWORKS_VAULT_PATH/tenant-001/log.md"
# Tiny but real SQLite file
sqlite3 "$AGENTWORKS_DIR/data/agentworks.db" "CREATE TABLE t (k TEXT); INSERT INTO t VALUES ('hello');" 2>/dev/null || \
  printf 'SQLite format 3\x00' > "$AGENTWORKS_DIR/data/agentworks.db"
DB_HASH_BEFORE="$(shasum -a 256 "$AGENTWORKS_DIR/data/agentworks.db" | awk '{print $1}')"

# Mock docker: any invocation succeeds with no-op stdout. Restore needs this.
DOCKER_STUB="$SANDBOX/bin"
mkdir -p "$DOCKER_STUB"
cat > "$DOCKER_STUB/docker" <<'EOF'
#!/usr/bin/env bash
# Docker stub for full-cycle backup test.
# Logs args to a file so the test can verify the CLI made the calls.
echo "$@" >> "${DOCKER_LOG:-/tmp/docker-stub.log}"
exit 0
EOF
chmod +x "$DOCKER_STUB/docker"
export DOCKER_LOG="$SANDBOX/docker-stub.log"
export PATH="$DOCKER_STUB:$PATH"

BACKUP_FILE="$SANDBOX/backup.tar.gz.enc"

echo "==> backup phase"
node "$CLI" backup --output "$BACKUP_FILE" --passphrase "$AGENTWORKS_BACKUP_PASSPHRASE"

if [[ ! -s "$BACKUP_FILE" ]]; then
  echo "FAIL: backup file not produced or empty: $BACKUP_FILE"
  exit 1
fi
BACKUP_BYTES="$(wc -c < "$BACKUP_FILE" | tr -d ' ')"
echo "    backup OK: $BACKUP_BYTES bytes"

echo "==> wipe phase"
rm -rf "$AGENTWORKS_VAULT_PATH" "$AGENTWORKS_DIR/data/agentworks.db"
rm -f "$AGENTWORKS_DIR/config/.env"
# Re-seed the .env so isInstalled() passes for restore
echo "AGENTOS_PORT=7710" > "$AGENTWORKS_DIR/config/.env"

if [[ -f "$AGENTWORKS_VAULT_PATH/notes.md" ]]; then
  echo "FAIL: wipe did not remove vault content"
  exit 1
fi

echo "==> restore phase"
node "$CLI" restore "$BACKUP_FILE" --passphrase "$AGENTWORKS_BACKUP_PASSPHRASE"

echo "==> verify phase"
fail=0

if [[ ! -f "$AGENTWORKS_VAULT_PATH/notes.md" ]]; then
  echo "FAIL: vault/notes.md not restored"
  fail=1
fi
if [[ ! -f "$AGENTWORKS_VAULT_PATH/tenant-001/log.md" ]]; then
  echo "FAIL: nested vault/tenant-001/log.md not restored"
  fail=1
fi
if [[ ! -f "$AGENTWORKS_DIR/data/agentworks.db" ]]; then
  echo "FAIL: data/agentworks.db not restored"
  fail=1
fi

if [[ -f "$AGENTWORKS_DIR/data/agentworks.db" ]]; then
  DB_HASH_AFTER="$(shasum -a 256 "$AGENTWORKS_DIR/data/agentworks.db" | awk '{print $1}')"
  if [[ "$DB_HASH_BEFORE" != "$DB_HASH_AFTER" ]]; then
    echo "FAIL: SQLite content changed across backup/restore"
    echo "  before: $DB_HASH_BEFORE"
    echo "  after:  $DB_HASH_AFTER"
    fail=1
  fi
fi

if [[ -f "$AGENTWORKS_VAULT_PATH/notes.md" ]]; then
  if ! grep -q "tenant-001 onboarding notes" "$AGENTWORKS_VAULT_PATH/notes.md"; then
    echo "FAIL: vault content corrupted"
    fail=1
  fi
fi

if ! grep -qE "compose.*(down|up)" "$DOCKER_LOG"; then
  echo "FAIL: restore did not call docker compose down/up"
  cat "$DOCKER_LOG"
  fail=1
fi

if [[ $fail -ne 0 ]]; then
  echo ""
  echo "Backup/restore full-cycle test FAILED."
  exit 1
fi

echo ""
echo "Backup/restore full-cycle test PASSED."
echo "  vault round-trip:  ok"
echo "  sqlite round-trip: ok ($DB_HASH_BEFORE)"
echo "  docker compose:    invoked"
exit 0
