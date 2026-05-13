#!/usr/bin/env bash
# Launch agentos-d with the canonical out-of-repo data dir + vault.
# Set in this script (not in shell rc) so a stray `node dist/cli.js`
# without env still cannot fall back to ./data inside the repo.

set -euo pipefail

DAEMON_DATA_DIR="${HOME}/Library/Application Support/agentworks-os/data"
DAEMON_VAULT_ROOT="${HOME}/vault"
DAEMON_RULE_PACKS="$(cd "$(dirname "$0")/../.." && pwd)/rule-packs"

mkdir -p "${DAEMON_DATA_DIR}/keys"

cd "$(dirname "$0")"

export AGENTOS_DATA_DIR="${DAEMON_DATA_DIR}"
export VAULT_ROOT="${DAEMON_VAULT_ROOT}"
export RULE_PACKS_DIR="${DAEMON_RULE_PACKS}"
export AGENTOS_PORT="${AGENTOS_PORT:-7710}"

# KIMI_API_KEY (or MOONSHOT_API_KEY) is required for the daemon-side LLM
# adapters. Set it in the environment before invoking this script.

exec node dist/cli.js "$@"
