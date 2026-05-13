#!/usr/bin/env bash
# Wrapper for agentos-d backup and restore commands
# Usage:
#   backup.sh backup [output.tar.gz]
#   backup.sh restore <input.tar.gz>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}") && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

node "$PROJECT_ROOT/dist/cli.js" "$@"
