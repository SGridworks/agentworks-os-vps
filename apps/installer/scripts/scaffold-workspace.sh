#!/usr/bin/env bash
#
# scaffold-workspace.sh — emit a harness-style agent workspace into target-dir
# Usage: scaffold-workspace.sh <target-dir> --tenant-id=<id> --daemon-url=<url>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="${SCRIPT_DIR}/../templates/customer-workspace"

TENANT_ID=""
DAEMON_URL=""
MCP_ENDPOINT=""
VAULT_PATH=""

die() { echo "[ERROR] $*" >&2; exit 1; }
info() { echo "[INFO] $*"; }

usage() {
  cat <<EOF
Usage: $(basename "$0") <target-dir> --tenant-id=<id> --daemon-url=<url> [options]

Required:
  --tenant-id=<uuid>     Tenant identifier
  --daemon-url=<url>     Base URL of the agentos-d daemon

Optional:
  --mcp-endpoint=<url>   MCP server URL (default: \${DAEMON_URL}/mcp)
  --vault-path=<path>    Tenant vault directory (default: \${target-dir}/vault)
EOF
}

parse_args() {
  if [[ $# -lt 3 ]]; then
    usage
    exit 1
  fi

  TARGET_DIR="$1"
  shift

  for arg in "$@"; do
    case "$arg" in
      --tenant-id=*) TENANT_ID="${arg#*=}" ;;
      --daemon-url=*) DAEMON_URL="${arg#*=}" ;;
      --mcp-endpoint=*) MCP_ENDPOINT="${arg#*=}" ;;
      --vault-path=*) VAULT_PATH="${arg#*=}" ;;
      --help|-h) usage; exit 0 ;;
      *) die "Unknown argument: $arg" ;;
    esac
  done

  [[ -n "$TENANT_ID" ]] || die "--tenant-id is required"
  [[ -n "$DAEMON_URL" ]] || die "--daemon-url is required"

  MCP_ENDPOINT="${MCP_ENDPOINT:-${DAEMON_URL}/mcp}"
  VAULT_PATH="${VAULT_PATH:-${TARGET_DIR}/vault}"
}

scaffold() {
  local target="$1"
  mkdir -p "$target"

  if [[ ! -d "$TEMPLATE_DIR" ]]; then
    die "Template directory not found: $TEMPLATE_DIR"
  fi

  # Copy templates and substitute variables
  for tmpl in "$TEMPLATE_DIR"/*; do
    local basename
    basename=$(basename "$tmpl")
    local outname

    # Strip .template suffix if present
    if [[ "$basename" == *.template ]]; then
      outname="${basename%.template}"
    else
      outname="$basename"
    fi

    info "Writing $outname"
    sed \
      -e "s|{{TENANT_ID}}|$TENANT_ID|g" \
      -e "s|{{DAEMON_URL}}|$DAEMON_URL|g" \
      -e "s|{{MCP_ENDPOINT}}|$MCP_ENDPOINT|g" \
      -e "s|{{VAULT_PATH}}|$VAULT_PATH|g" \
      "$tmpl" > "$target/$outname"
  done

  # Seed an empty feature_list.json conforming to the schema
  cat > "$target/feature_list.json" <<EOF
{
  "version": "1.0.0",
  "tenantId": "$TENANT_ID",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "features": []
}
EOF

  info "Workspace scaffolded at $target"
  info "  AGENTS.md           — agent briefing"
  info "  progress.md         — task progress log"
  info "  feature_list.json   — structured task list"
  info "  feature_list.schema.json — task list schema"
}

main() {
  parse_args "$@"
  scaffold "$TARGET_DIR"
}

main "$@"
