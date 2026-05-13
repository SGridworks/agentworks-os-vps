#!/usr/bin/env bash
# Wrapper for agentos-d backup/restore commands
# Usage:
#   backup.sh backup [output.tar.gz]
#   backup.sh restore <input.tar.gz>

set -euo pipefail

# Resolve project root relative to this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}") && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Ensure node binary via npm package
node "$PROJECT_ROOT/dist/cli.js" "$@"
