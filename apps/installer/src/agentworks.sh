#!/usr/bin/env bash
#
# agentworks — AgentWorks OS CLI
# Wraps docker compose and the installer for common operations.
#
# Usage:
#   agentworks status
#   agentworks logs [service]
#   agentworks restart [service ...]
#   agentworks update
#   agentworks update --check
#   agentworks backup --output <file.tar.gz>
#   agentworks restore --input <file.tar.gz>
#   agentworks uninstall
#   agentworks mcp configure
#   agentworks support-bundle
#   agentworks install
#
set -euo pipefail

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------
readonly AGENTWORKS_DIR="${AGENTWORKS_DIR:-$HOME/.agentworks}"
readonly CONFIG_DIR="${AGENTWORKS_DIR}/config"
readonly ENV_FILE="${CONFIG_DIR}/.env"
readonly SECRETS_FILE="${CONFIG_DIR}/secrets.json"
readonly LOG_DIR="${AGENTWORKS_DIR}/logs"
readonly DATA_DIR="${AGENTWORKS_DIR}/data"
readonly SOURCE_DIR="${AGENTWORKS_SOURCE_DIR:-${AGENTWORKS_DIR}/source}"
readonly COMPOSE_FILE="${SOURCE_DIR}/docker-compose.yml"
# Bumped on every release. `agentworks update --check` compares this to the
# GitHub releases API; a stale value means every fresh install reports
# "update available" even when fully current. RELEASE CHECKLIST: bump.
#
# NOT readonly: `cmd_update` re-exports it inline (`AGENTWORKS_VERSION=$x compose pull`)
# so compose pulls the new tag's image. With `readonly` + `set -e`, that inline
# assignment aborts the script before the pull, breaking re-install handoff.
AGENTWORKS_VERSION="${AGENTWORKS_VERSION:-0.1.9}"
readonly REPO="SGridworks/agentworks-os"
readonly GITHUB_RELEASES="https://api.github.com/repos/${REPO}/releases"

# Color codes
if [[ -t 1 ]]; then
  readonly RED='\033[0;31m'
  readonly GREEN='\033[0;32m'
  readonly YELLOW='\033[0;33m'
  readonly BLUE='\033[0;34m'
  readonly NC='\033[0m'
else
  readonly RED=''
  readonly GREEN=''
  readonly YELLOW=''
  readonly BLUE=''
  readonly NC=''
fi

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------
log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $*"; }

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
is_installed() {
  [[ -f "$COMPOSE_FILE" ]]
}

require_installed() {
  if ! is_installed; then
    log_error "AgentWorks OS is not installed. Run: agentworks install"
    exit 1
  fi
}

get_compose_cmd() {
  # Use whichever docker compose variant is available
  if docker compose version &>/dev/null; then
    echo "docker compose"
  elif command -v docker-compose &>/dev/null; then
    echo "docker-compose"
  else
    log_error "docker compose not found"
    exit 1
  fi
}

# compose() runs docker compose from the source root with the absolute data
# and config dirs exported, matching what install.sh does. Bind mounts in
# docker-compose.yml resolve under $AGENTWORKS_DIR rather than the source dir.
compose() {
  local cc
  cc=$(get_compose_cmd)
  local env_args=()
  [[ -f "$ENV_FILE" ]] && env_args=(--env-file "$ENV_FILE")
  ( cd "$SOURCE_DIR" \
    && AGENTWORKS_DATA_DIR="$DATA_DIR" \
       AGENTWORKS_CONFIG_DIR="$CONFIG_DIR" \
       $cc "${env_args[@]}" "$@" )
}

# -----------------------------------------------------------------------------
# Command: status
# -----------------------------------------------------------------------------
cmd_status() {
  require_installed

  echo ""
  echo "AgentWorks OS — Service Status"
  echo "================================"
  echo ""

  compose ps

  echo ""
  local health
  health=$(curl -s http://localhost:7710/api/health 2>/dev/null || true)
  if [[ -n "$health" ]] && echo "$health" | grep -q '"status"'; then
    echo -e "agentos-d API: ${GREEN}UP${NC} — $health"
  else
    echo -e "agentos-d API: ${RED}DOWN${NC}"
  fi
}

# -----------------------------------------------------------------------------
# Command: logs
# -----------------------------------------------------------------------------
cmd_logs() {
  require_installed
  local service="${1:-}"
  if [[ -n "$service" ]]; then
    compose logs -f "$service"
  else
    compose logs -f
  fi
}

# -----------------------------------------------------------------------------
# Command: restart [service ...]
# `agentworks restart` with no args recreates every service.
# `agentworks restart agentos-d` (or any subset) recreates only those.
#
# Why `up -d --force-recreate --remove-orphans` instead of `restart`:
# `compose restart` does not pick up edits to docker-compose.yml — health
# checks, env, bind mounts, image tags. Pre-v0.1.9 we used `restart`, which
# meant changes silently never took effect and orphaned containers from
# removed services lingered. `up -d --force-recreate --remove-orphans`
# applies the current compose file's intent and cleans up stale containers,
# at the cost of a slightly longer restart.
# -----------------------------------------------------------------------------
cmd_restart() {
  require_installed
  if (( $# > 0 )); then
    log_info "Recreating: $*"
    compose up -d --force-recreate --remove-orphans "$@"
  else
    log_info "Recreating all services..."
    compose up -d --force-recreate --remove-orphans
  fi
}

# -----------------------------------------------------------------------------
# Command: update
# -----------------------------------------------------------------------------
cmd_update() {
  require_installed

  local check_only=false
  if [[ "${1:-}" == "--check" ]]; then
    check_only=true
  fi

  log_step "Checking for updates..."

  local latest_version
  # POSIX-portable extract: `grep -oP` (PCRE) is GNU-only — BSD grep on macOS
  # does not have -P, so the original silently returned empty on every Mac.
  latest_version=$(curl -s "$GITHUB_RELEASES/latest" 2>/dev/null | sed -n 's/.*"tag_name":[[:space:]]*"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' | head -1 || true)

  if [[ -z "$latest_version" ]]; then
    log_warn "Could not fetch latest version from GitHub."
    return 1
  fi

  if [[ "$check_only" == "true" ]]; then
    if [[ "$latest_version" == "$AGENTWORKS_VERSION" ]]; then
      echo "You are on the latest version: ${latest_version}"
    else
      echo "Current: ${AGENTWORKS_VERSION}  Latest: ${latest_version}"
    fi
    return 0
  fi

  log_info "Latest version: ${latest_version}"
  log_info "Current version: ${AGENTWORKS_VERSION}"

  if [[ "$latest_version" == "$AGENTWORKS_VERSION" ]]; then
    log_info "Already on the latest version."
    return 0
  fi

  log_step "Updating source clone to v${latest_version}..."
  git -C "$SOURCE_DIR" fetch --tags --depth=1 origin "v${latest_version}" 2>&1 | sed 's/^/  /'
  git -C "$SOURCE_DIR" checkout -q FETCH_HEAD

  log_step "Pulling and rebuilding services..."
  AGENTWORKS_VERSION="$latest_version" compose pull || true
  AGENTWORKS_VERSION="$latest_version" compose up -d --build

  log_info "Update complete."
}

# -----------------------------------------------------------------------------
# Command: backup
# -----------------------------------------------------------------------------
cmd_backup() {
  require_installed
  local output="${1:-}"
  local encrypt="${BACKUP_ENCRYPT:-true}"

  if [[ -z "$output" ]]; then
    output="agentworks-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    log_info "No output specified, using: ${output}"
  fi

  log_step "Creating backup: ${output}"

  # Create a temp dir for the backup
  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf $tmpdir" EXIT

  # Collect data dirs
  mkdir -p "$tmpdir/data" "$tmpdir/config"
  cp -r "$DATA_DIR/." "$tmpdir/data/"
  cp -r "$CONFIG_DIR/." "$tmpdir/config/"

  # chmod secrets to readable only
  chmod 600 "$tmpdir/config"/*.json 2>/dev/null || true

  # Database dump
  if compose ps -q postgres &>/dev/null; then
    log_step "Dumping database..."
    mkdir -p "$tmpdir/db"
    compose exec -T postgres pg_dump -U agentworks -d agentworks > "$tmpdir/db/agentworks.sql" 2>/dev/null || true
  fi

  # Create tarball
  tar -czf "$output" -C "$tmpdir" data config db

  # Encrypt if openssl is available and encrypt is enabled
  if [[ "$encrypt" == "true" ]] && command -v openssl &>/dev/null; then
    local passphrase="${BACKUP_PASSPHRASE:-}"
    if [[ -z "$passphrase" ]]; then
      log_warn "BACKUP_PASSPHRASE not set — skipping encryption (backup is still tarball)"
    else
      log_step "Encrypting backup..."
      local enc_output="${output%.tar.gz}.enc"
      openssl enc -aes-256-cbc -salt -pbkdf2 -pass pass:"$passphrase" -in "$output" -out "$enc_output"
      rm -f "$output"
      output="$enc_output"
    fi
  fi

  log_info "Backup saved to: ${output}"
}

# -----------------------------------------------------------------------------
# Command: restore
# -----------------------------------------------------------------------------
cmd_restore() {
  require_installed
  local input="${1:-}"

  if [[ -z "$input" ]]; then
    log_error "Usage: agentworks restore --input <file.tar.gz>"
    exit 1
  fi

  if [[ ! -f "$input" ]]; then
    log_error "File not found: ${input}"
    exit 1
  fi

  log_warn "This will overwrite current data. Ctrl+C to abort."
  sleep 3

  log_step "Restoring from: ${input}"

  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf $tmpdir" EXIT

  tar -xzf "$input" -C "$tmpdir"

  compose stop

  # Restore data
  rm -rf "$DATA_DIR"/* && cp -r "$tmpdir/data/"* "$DATA_DIR/"
  rm -rf "$CONFIG_DIR"/* && cp -r "$tmpdir/config/"* "$CONFIG_DIR/"

  compose up -d

  log_info "Restore complete."
}

# -----------------------------------------------------------------------------
# Command: uninstall
# -----------------------------------------------------------------------------
cmd_uninstall() {
  require_installed

  log_warn "This will remove ALL AgentWorks OS data and containers."
  log_warn "Ctrl+C to abort."
  sleep 5

  log_step "Stopping services..."
  compose down -v 2>/dev/null || true

  log_step "Removing data directories..."
  rm -rf "$DATA_DIR" "$CONFIG_DIR" "$LOG_DIR" "$SOURCE_DIR"

  log_info "AgentWorks OS has been removed."
}

# -----------------------------------------------------------------------------
# Command: mcp configure [--target claude-desktop|claude-code|both]
#
# Writes an MCP server entry for AgentWorks OS into the chosen client's
# config file. Detects WSL (via `uname -r` containing "microsoft") and
# adjusts both the spawn command and the destination path accordingly,
# because Claude on Windows must reach into WSL via `wsl -e <node> <bridge>`
# rather than running `node` directly.
#
# Default target: claude-desktop. Pass --target claude-code or --target both
# to write to Claude Code's `~/.claude.json` instead, or both files at once.
# -----------------------------------------------------------------------------
cmd_mcp_configure() {
  # ---- Parse args ----------------------------------------------------------
  # Arg validation and --help run before require_installed so that
  #   `agentworks mcp configure --help`
  # prints help on a fresh box where the install hasn't finished yet.
  local target="claude-desktop"
  while (( $# > 0 )); do
    case "$1" in
      --target)
        shift
        target="${1:-}"
        case "$target" in
          claude-desktop|claude-code|both) ;;
          *)
            log_error "Invalid --target: '${target}'. Must be one of: claude-desktop, claude-code, both."
            exit 1
            ;;
        esac
        ;;
      --target=*)
        target="${1#--target=}"
        ;;
      -h|--help)
        cat <<USAGE
Usage: agentworks mcp configure [--target claude-desktop|claude-code|both]

Writes an AgentWorks MCP server entry to the chosen client's config file.

  --target claude-desktop  (default) write to Claude Desktop's config
  --target claude-code     write to ~/.claude.json (Claude Code CLI)
  --target both            write to both
USAGE
        return 0
        ;;
      *)
        log_error "Unknown argument: $1"
        exit 1
        ;;
    esac
    shift
  done

  require_installed

  # ---- Detect platform / WSL ----------------------------------------------
  local platform
  platform=$(uname -s)
  local is_wsl="false"
  if [[ "$platform" == "Linux" ]]; then
    local kernel
    kernel=$(uname -r 2>/dev/null || echo "")
    # The standard signal for WSL2 is "microsoft" (case-insensitive) in the
    # kernel string, e.g. "5.15.167.4-microsoft-standard-WSL2".
    if printf '%s' "$kernel" | grep -qi "microsoft"; then
      is_wsl="true"
    fi
  fi

  # ---- Resolve Node + bridge ----------------------------------------------
  local node_path=""
  if command -v node &>/dev/null; then
    node_path=$(command -v node)
  fi
  if [[ -z "$node_path" || ! -x "$node_path" ]]; then
    log_error "node executable not found on PATH."
    log_error "Install Node.js (>=18) and re-run, or set node on PATH for the user that runs Claude."
    exit 1
  fi

  # Bridge resolution order:
  #   1. install.sh extracts the bridge from the running container into
  #      ${CONFIG_DIR}/mcp-stdio-bridge.js — preferred (no source build needed).
  #   2. A developer's local checkout (./packages/agentos-d/dist/bin/...) when
  #      we're running from one.
  #   3. The source clone under ${SOURCE_DIR} as a fallback.
  local bridge_path=""
  if [[ -f "${CONFIG_DIR}/mcp-stdio-bridge.js" ]]; then
    bridge_path="${CONFIG_DIR}/mcp-stdio-bridge.js"
  elif [[ -f "$(pwd)/packages/agentos-d/dist/bin/mcp-stdio-bridge.js" ]]; then
    bridge_path="$(pwd)/packages/agentos-d/dist/bin/mcp-stdio-bridge.js"
  elif [[ -f "${SOURCE_DIR}/packages/agentos-d/dist/bin/mcp-stdio-bridge.js" ]]; then
    bridge_path="${SOURCE_DIR}/packages/agentos-d/dist/bin/mcp-stdio-bridge.js"
  fi

  if [[ -z "$bridge_path" || ! -f "$bridge_path" ]]; then
    log_error "MCP stdio bridge not found."
    log_error "Expected at one of:"
    log_error "  ${CONFIG_DIR}/mcp-stdio-bridge.js (install.sh extracts it here)"
    log_error "  ${SOURCE_DIR}/packages/agentos-d/dist/bin/mcp-stdio-bridge.js"
    log_error "Re-run install.sh, or build packages/agentos-d locally."
    exit 1
  fi

  # ---- Resolve destination paths ------------------------------------------
  local desktop_path="" code_path=""
  case "$platform" in
    Darwin)
      desktop_path="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
      code_path="$HOME/.claude.json"
      ;;
    Linux)
      if [[ "$is_wsl" == "true" ]]; then
        # Try to find the Windows-side user profile under /mnt/c/Users.
        # cmd.exe is reliable when interop is enabled. wslvar is sometimes
        # available too. Fall back to scanning /mnt/c/Users for a single
        # non-system directory.
        local win_user=""
        if command -v cmd.exe &>/dev/null; then
          win_user=$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r\n' || true)
        fi
        if [[ -z "$win_user" ]] && command -v wslvar &>/dev/null; then
          win_user=$(wslvar USERNAME 2>/dev/null | tr -d '\r\n' || true)
        fi
        if [[ -z "$win_user" && -d /mnt/c/Users ]]; then
          # Heuristic: pick the only non-system Users entry if there's exactly one.
          local candidates
          candidates=$(find /mnt/c/Users -mindepth 1 -maxdepth 1 -type d \
            ! -name 'Default*' ! -name 'Public' ! -name 'All Users' \
            ! -name 'WDAGUtilityAccount' ! -name 'desktop.ini' 2>/dev/null \
            | head -2)
          if [[ "$(echo "$candidates" | wc -l)" -eq 1 && -n "$candidates" ]]; then
            win_user=$(basename "$candidates")
          fi
        fi
        if [[ -n "$win_user" && -d "/mnt/c/Users/${win_user}" ]]; then
          desktop_path="/mnt/c/Users/${win_user}/AppData/Roaming/Claude/claude_desktop_config.json"
          code_path="/mnt/c/Users/${win_user}/.claude.json"
        else
          # Cannot resolve Windows-side path — print snippet and bail later.
          desktop_path=""
          code_path=""
        fi
      else
        desktop_path="$HOME/.config/Claude/claude_desktop_config.json"
        code_path="$HOME/.claude.json"
      fi
      ;;
    *)
      log_error "Unsupported platform: ${platform}"
      exit 1
      ;;
  esac

  # ---- Build the MCP server entry -----------------------------------------
  # Two flavors:
  #   normal:  {"command": "<node>",         "args": ["<bridge>"]}
  #   WSL:     {"command": "wsl", "args": ["-e", "<node>", "<bridge>"]}
  # The WSL form is required when the consumer is a Windows process (Claude
  # Desktop or Claude Code on Windows) — Windows cannot run a WSL-side
  # `node` binary directly. The Linux-side `node` is invoked through `wsl -e`.
  local mcp_command mcp_args_json
  if [[ "$is_wsl" == "true" ]]; then
    mcp_command="wsl"
    mcp_args_json="$(printf '["-e", %s, %s]' \
      "$(printf '%s' "$node_path"   | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
      "$(printf '%s' "$bridge_path" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"
  else
    mcp_command="$node_path"
    mcp_args_json="$(printf '[%s]' \
      "$(printf '%s' "$bridge_path" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"
  fi

  local mcp_url="http://localhost:7710"

  # ---- Writer (idempotent merge) ------------------------------------------
  # Helper: write the MCP entry into a JSON config file's mcpServers map.
  # Reads existing JSON if present, replaces only the "agentworks" key,
  # writes back with 2-space indent. If config_file is empty, prints the
  # snippet to stdout instead.
  _write_mcp_config() {
    local cfg="$1"
    local label="$2"
    if [[ -z "$cfg" ]]; then
      log_warn "${label}: cannot resolve a config path automatically — printing snippet to paste manually:"
      cat <<JSON
{
  "mcpServers": {
    "agentworks": {
      "command": "${mcp_command}",
      "args": ${mcp_args_json},
      "env": { "AGENTOS_URL": "${mcp_url}" }
    }
  }
}
JSON
      return 0
    fi
    mkdir -p "$(dirname "$cfg")"
    AGENTWORKS_MCP_CFG="$cfg" \
    AGENTWORKS_MCP_COMMAND="$mcp_command" \
    AGENTWORKS_MCP_ARGS_JSON="$mcp_args_json" \
    AGENTWORKS_MCP_URL="$mcp_url" \
    python3 - <<'PY'
import json, os
cfg = os.environ["AGENTWORKS_MCP_CFG"]
command = os.environ["AGENTWORKS_MCP_COMMAND"]
args = json.loads(os.environ["AGENTWORKS_MCP_ARGS_JSON"])
url = os.environ["AGENTWORKS_MCP_URL"]
try:
    with open(cfg) as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}
config.setdefault("mcpServers", {})
config["mcpServers"]["agentworks"] = {
    "command": command,
    "args": args,
    "env": {"AGENTOS_URL": url},
}
os.makedirs(os.path.dirname(cfg), exist_ok=True)
with open(cfg, "w") as f:
    json.dump(config, f, indent=2)
print("ok:", cfg)
PY
    log_info "${label} MCP configured: ${cfg}"
  }

  log_step "Configuring MCP (target=${target}${is_wsl:+, wsl=$is_wsl})..."
  log_info "Spawn: ${mcp_command} ${mcp_args_json}"

  case "$target" in
    claude-desktop) _write_mcp_config "$desktop_path" "Claude Desktop" ;;
    claude-code)    _write_mcp_config "$code_path"    "Claude Code"    ;;
    both)
      _write_mcp_config "$desktop_path" "Claude Desktop"
      _write_mcp_config "$code_path"    "Claude Code"
      ;;
  esac

  log_info "Restart the Claude client(s) to activate."
}

# -----------------------------------------------------------------------------
# Command: support-bundle
# -----------------------------------------------------------------------------
cmd_support_bundle() {
  require_installed
  local output="${1:-agentworks-support-$(date +%Y%m%d-%H%M%S).tar.gz}"

  log_step "Collecting support bundle: ${output}"

  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf $tmpdir" EXIT

  # Service logs (last 500 lines each)
  mkdir -p "$tmpdir/logs"
  for svc in agentos-d scanner-worker n8n admin-ui postgres; do
    compose logs --tail=500 "$svc" > "$tmpdir/logs/${svc}.log" 2>&1 || true
  done

  # Docker compose config (sanitized)
  compose config > "$tmpdir/docker-compose.yml" 2>/dev/null || true

  # Health endpoint output
  curl -s http://localhost:7710/api/health > "$tmpdir/health.json" 2>/dev/null || true

  # Database stats (if accessible)
  compose exec -T postgres psql -U agentworks -d agentworks -c "SELECT 1" &>/dev/null && \
    compose exec -T postgres pg_dump -U agentworks &>/dev/null > "$tmpdir/db.sql" || true

  tar -czf "$output" -C "$tmpdir" .

  log_info "Support bundle saved to: ${output}"
}

# -----------------------------------------------------------------------------
# Command: install
# -----------------------------------------------------------------------------
cmd_install() {
  if is_installed; then
    log_warn "AgentWorks OS is already installed at ${AGENTWORKS_DIR}"
    log_info "Run 'agentworks status' to check services."
    return 0
  fi

  local installer_url="${INSTALLER_URL:-https://get.agentworks.os/install.sh}"
  log_info "Downloading installer from: ${installer_url}"

  if command -v curl &>/dev/null; then
    curl -fsSL "$installer_url" | bash -s -- --unattended
  else
    log_error "curl is required to install AgentWorks OS"
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# Main dispatcher
# -----------------------------------------------------------------------------
show_help() {
  cat <<EOF
AgentWorks OS CLI — ${AGENTWORKS_VERSION}

Usage: agentworks <command> [options]

Commands:
  agentworks install            Download and run the installer
  agentworks status            Show service status
  agentworks logs [service]    Tail service logs (all or a specific service)
  agentworks restart [svc...]  Restart one or more services (default: all)
  agentworks update            Update to the latest version
  agentworks update --check    Check for available updates
  agentworks backup [file]     Create a backup tarball (default: agentworks-backup-YYYYMMDD.tar.gz)
  agentworks restore --input <file>   Restore from a backup tarball
  agentworks uninstall         Remove AgentWorks OS and all data
  agentworks mcp configure [--target claude-desktop|claude-code|both]
                              Configure MCP connection (default: claude-desktop)
  agentworks support-bundle [file]   Collect diagnostics bundle

Examples:
  agentworks install
  agentworks status
  agentworks logs agentos-d
  agentworks update --check
  agentworks backup
  agentworks restore --input agentworks-backup-20260427.tar.gz

For more help: https://docs.agentworks.os
EOF
}

main() {
  local cmd="${1:-}"
  shift 2>/dev/null || true

  case "$cmd" in
    status)       cmd_status "$@" ;;
    logs)         cmd_logs "$@" ;;
    restart)      cmd_restart "$@" ;;
    update)       cmd_update "$@" ;;
    backup)       cmd_backup "$@" ;;
    restore)      cmd_restore "$@" ;;
    uninstall)    cmd_uninstall ;;
    mcp)
      local subcmd="${1:-configure}"
      shift 2>/dev/null || true
      case "$subcmd" in
        configure) cmd_mcp_configure "$@" ;;
        *) log_error "Unknown mcp subcommand: $subcmd"; exit 1 ;;
      esac
      ;;
    configure)    cmd_mcp_configure "$@" ;;
    support-bundle) cmd_support_bundle "$@" ;;
    install)      cmd_install ;;
    -h|--help|help) show_help ;;
    *)            show_help ;;
  esac
}

main "$@"
