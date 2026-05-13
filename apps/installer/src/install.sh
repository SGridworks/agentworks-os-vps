#!/usr/bin/env bash
#
# agentworks install — one-command setup for AgentWorks OS
# Usage:
#   curl -fsSL https://github.com/SGridworks/agentworks-os/releases/download/v0.1.9/install.sh | bash
#   curl -fsSL https://github.com/SGridworks/agentworks-os/releases/download/v0.1.9/install.sh | bash -s -- --unattended
#
# To install a different release, override INSTALLER_REF:
#   curl -fsSL https://github.com/SGridworks/agentworks-os/releases/download/v0.2.0/install.sh \
#     | INSTALLER_REF=v0.2.0 bash
#
set -euo pipefail

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------
readonly INSTALLER_VERSION="0.1.9"
readonly REPO="SGridworks/agentworks-os"
# Pin asset fetches to the release tag so v0.1.1 installer cannot silently
# pull future main-branch changes. Override with INSTALLER_REF=<branch|tag|sha>
# only for development.
readonly INSTALLER_REF="${INSTALLER_REF:-v${INSTALLER_VERSION}}"
readonly REPO_URL="https://github.com/${REPO}.git"
readonly AGENTWORKS_DIR="${AGENTWORKS_DIR:-$HOME/.agentworks}"
readonly DATA_DIR="${AGENTWORKS_DIR}/data"
readonly CONFIG_DIR="${AGENTWORKS_DIR}/config"
readonly LOG_DIR="${AGENTWORKS_DIR}/logs"
readonly ENV_FILE="${CONFIG_DIR}/.env"
readonly SECRETS_FILE="${CONFIG_DIR}/secrets.json"

# SOURCE_DIR holds the AgentWorks source tree. We need the source — not just
# docker-compose.yml — because compose has `build:` directives and v0.1
# publishes no public images. Either we clone, or (when run from a checkout)
# we use the checkout in place.
SOURCE_DIR="${AGENTWORKS_SOURCE_DIR:-${AGENTWORKS_DIR}/source}"

# Color codes (disabled if not a TTY)
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
# Dependency checks
# -----------------------------------------------------------------------------
check_docker() {
  if ! command -v docker &>/dev/null; then
    log_error "Docker is not installed. Visit: https://docs.docker.com/get-docker/"
    exit 1
  fi

  local docker_version
  # `grep -oP` is GNU-only — fall back to a sed pattern that runs on BSD too
  docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null || docker --version | sed -nE 's/.*[Vv]ersion[[:space:]]+([0-9]+\.[0-9]+).*/\1/p' | head -1)
  if [[ -z "$docker_version" ]]; then
    log_error "Could not determine Docker version. Is the Docker daemon running?"
    exit 1
  fi

  log_info "Docker version: ${docker_version}"
}

check_docker_compose() {
  if docker compose version &>/dev/null; then
    COMPOSE_CMD=(docker compose)
  elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD=(docker-compose)
  else
    log_error "Docker Compose is not installed."
    exit 1
  fi
  local compose_version
  compose_version=$("${COMPOSE_CMD[@]}" version --short 2>/dev/null \
    || "${COMPOSE_CMD[@]}" --version | sed -nE 's/.*[Vv]ersion[[:space:]]+([0-9]+\.[0-9]+).*/\1/p' | head -1)
  log_info "Docker Compose version: ${compose_version} (cli: ${COMPOSE_CMD[*]})"
}

check_curl() {
  if ! command -v curl &>/dev/null; then
    log_error "curl is not installed."
    exit 1
  fi
}

check_git() {
  if ! command -v git &>/dev/null; then
    log_error "git is required to fetch the AgentWorks source."
    log_error "Install git, or clone the repo manually and re-run from inside it:"
    log_error "  git clone ${REPO_URL} && cd agentworks-os && ./apps/installer/src/install.sh"
    exit 1
  fi
}

check_openssl() {
  if ! command -v openssl &>/dev/null; then
    log_error "openssl is required to generate install secrets."
    log_error "Install: 'brew install openssl' (macOS) or 'apt install openssl' (Debian/Ubuntu)."
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# Pre-flight checks
#
# Each check below tells the agent (or human) exactly what is wrong AND what
# to do about it. We exit non-zero on any unrecoverable check so that an LLM
# agent reading the output knows to surface the failure rather than silently
# continuing into a broken build.
# -----------------------------------------------------------------------------
check_ports_free() {
  local in_use=()
  for port in 7710 3101 5678 3000; do
    # lsof is on macOS by default; ss is on most Linux. Fall back to /dev/tcp.
    if command -v lsof &>/dev/null; then
      if lsof -i ":${port}" -sTCP:LISTEN -t &>/dev/null; then
        in_use+=("$port")
      fi
    elif command -v ss &>/dev/null; then
      if ss -ltn "sport = :${port}" 2>/dev/null | grep -q ":${port}"; then
        in_use+=("$port")
      fi
    else
      if (echo > "/dev/tcp/127.0.0.1/${port}") &>/dev/null; then
        in_use+=("$port")
      fi
    fi
  done

  if (( ${#in_use[@]} > 0 )); then
    # Idempotency: if AGENTWORKS_DIR already has a compose file, the
    # ports are almost certainly in use BY a previous AgentWorks install.
    # Tell the operator to use `agentworks update` instead of failing
    # with a generic port-busy error and confusing them into killing
    # their own daemon.
    if [[ -f "${AGENTWORKS_DIR}/source/docker-compose.yml" ]]; then
      log_warn "Required ports already in use: ${in_use[*]}"
      log_warn "An existing AgentWorks install was detected at ${AGENTWORKS_DIR}."
      log_warn "Re-running installer behaves as 'agentworks update' — handing off now."

      # Refresh the on-disk source clone to ${INSTALLER_REF} BEFORE exec'ing
      # its update script. Without this we would run the previously-installed
      # wrapper bytes — which on a v0.1.8 install still has `readonly
      # AGENTWORKS_VERSION` and aborts under set -e when cmd_update tries to
      # reassign it inline (Codex R3 BLOCKER, fixed in PR #18). Pulling the
      # v0.1.9 wrapper first guarantees the fix is what runs.
      local existing_source="${AGENTWORKS_DIR}/source"
      if [[ -d "${existing_source}/.git" ]]; then
        log_info "Refreshing source clone to ${INSTALLER_REF} before update..."
        if ! git -C "${existing_source}" fetch --tags --depth=1 origin "${INSTALLER_REF}" 2>&1 | sed 's/^/  /'; then
          log_error "Failed to fetch ${INSTALLER_REF} into ${existing_source}."
          log_error "Run manually:"
          log_error "  git -C ${existing_source} fetch --tags origin ${INSTALLER_REF} && git -C ${existing_source} checkout FETCH_HEAD"
          log_error "Then: bash ${existing_source}/apps/installer/src/agentworks.sh update"
          exit 1
        fi
        git -C "${existing_source}" checkout -q FETCH_HEAD
      else
        log_warn "Existing source at ${existing_source} is not a git clone — cannot refresh."
        log_warn "Falling back to whatever wrapper bytes are on disk."
      fi

      local update_script="${existing_source}/apps/installer/src/agentworks.sh"
      if [[ -r "$update_script" ]]; then
        exec bash "$update_script" update
      fi
      if command -v agentworks &>/dev/null; then
        exec agentworks update
      fi
      log_error "Existing install detected but update entry point not found:"
      log_error "  ${update_script}"
      log_error "Run manually:"
      log_error "  bash ${update_script} update"
      log_error "Or to start fresh (destructive — deletes data + config):"
      log_error "  agentworks uninstall && curl -fsSL <install-url> | bash"
      exit 1
    fi
    log_error "Required ports already in use: ${in_use[*]}"
    log_error "Substrate needs:"
    log_error "  7710  agentos-d daemon (REST + MCP)"
    log_error "  3101  scanner-worker"
    log_error "  5678  n8n"
    log_error "  3000  admin-ui"
    log_error "To find the process: lsof -i :<port>"
    log_error "Stop the process and re-run. Custom ports are not supported in v0.1.x"
    log_error "(every health check, doc URL, and CLI command hardcodes these ports)."
    exit 1
  fi
  log_info "Ports 7710, 3101, 5678, 3000 free."
}

check_disk_space() {
  # Need ~10GB: ~3.5GB for images, ~1GB for source clone, the rest for SQLite,
  # vault writes, and docker layer build cache.
  local need_kb=$((10 * 1024 * 1024))
  local avail_kb
  avail_kb=$(df -k "$HOME" | awk 'NR==2 {print $4}')
  if [[ -z "$avail_kb" ]] || (( avail_kb < need_kb )); then
    local avail_gb=$(( avail_kb / 1024 / 1024 ))
    log_error "Need >= 10 GB free under \$HOME; only ${avail_gb} GB available."
    log_error "Free disk space and re-run."
    exit 1
  fi
  log_info "Disk: $(( avail_kb / 1024 / 1024 )) GB free under \$HOME."
}

check_memory() {
  local mem_gb=0
  if [[ "$(uname -s)" == "Darwin" ]]; then
    local bytes
    bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
    mem_gb=$(( bytes / 1024 / 1024 / 1024 ))
  elif [[ -r /proc/meminfo ]]; then
    local kb
    kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
    mem_gb=$(( kb / 1024 / 1024 ))
  fi
  if (( mem_gb > 0 )) && (( mem_gb < 4 )); then
    log_error "System has only ${mem_gb} GB RAM; substrate needs >= 4 GB (8 GB recommended)."
    log_error "agentos-d, scanner-worker (with sentence-transformers), and n8n will OOM under 4 GB."
    exit 1
  fi
  log_info "Memory: ${mem_gb} GB total."
}

check_internet() {
  # github.com is the source clone target and the GHCR auth path.
  if ! curl -fsSL -m 10 -o /dev/null https://github.com/ 2>/dev/null; then
    log_error "Cannot reach https://github.com — install needs internet access to clone the source."
    log_error "If the host is behind a proxy, set HTTPS_PROXY and re-run."
    exit 1
  fi
  log_info "Internet reachable."
}

preflight_check() {
  log_step "Running pre-flight checks..."
  check_curl
  check_git
  check_openssl
  check_docker
  check_docker_compose

  if ! docker info &>/dev/null; then
    # Distinguish 'daemon not running' from 'permission denied' on Linux.
    # The 'docker info' exit code is the same; check the stderr text.
    local docker_err
    docker_err=$(docker info 2>&1 >/dev/null || true)
    if echo "$docker_err" | grep -qiE "permission denied|cannot connect.*sock"; then
      log_error "Docker daemon is reachable but the current user lacks permission."
      log_error "On Linux, add yourself to the docker group:"
      log_error "  sudo usermod -aG docker \$USER && newgrp docker"
      log_error "Or re-run this installer in a new shell after the group change takes effect."
      log_error "Do NOT 'sudo ./install.sh' — it leaves ~/.agentworks/ owned by root."
    else
      log_error "Docker daemon is not running."
      log_error "  macOS: open Docker Desktop (or 'open -a OrbStack') and wait for it to start."
      log_error "  Linux: sudo systemctl start docker"
    fi
    log_error "Then re-run this installer."
    exit 1
  fi

  check_ports_free
  check_disk_space
  check_memory
  check_internet

  local platform arch
  platform=$(uname -s)
  arch=$(uname -m)
  log_info "Platform: ${platform}/${arch}"

  log_info "Pre-flight checks passed."
}

# -----------------------------------------------------------------------------
# Create directories
# -----------------------------------------------------------------------------
create_directories() {
  log_step "Creating AgentWorks directories..."
  mkdir -p "${DATA_DIR}" "${CONFIG_DIR}" "${LOG_DIR}"

  # n8n runs inside its container as uid 1000 (`node`); the scanner-worker
  # writes as root. Both bind-mount subdirs of $DATA_DIR. If the host process
  # creating $DATA_DIR has a different uid (always true on Linux + WSL), the
  # containers can't write. Permissive perms on these two subdirs sidesteps
  # the cross-platform uid mismatch.
  mkdir -p "${DATA_DIR}/n8n" "${DATA_DIR}/scanner"
  chmod 777 "${DATA_DIR}/n8n" "${DATA_DIR}/scanner"

  log_info "Data directory: ${DATA_DIR}"
  log_info "Config directory: ${CONFIG_DIR}"
  log_info "Log directory: ${LOG_DIR}"
}

# -----------------------------------------------------------------------------
# Acquire source tree (clone, or use the local checkout we're running from)
# -----------------------------------------------------------------------------
acquire_source() {
  log_step "Resolving AgentWorks source tree..."

  # If we're being run from inside a checkout, prefer it over re-cloning.
  # Sentinel: the AWOS docker-compose.yml has a build directive for the
  # agentos-d package; an unrelated docker-compose.yml in the cwd will not.
  if [[ -f "$(pwd)/docker-compose.yml" ]] \
      && [[ -d "$(pwd)/packages/agentos-d" ]] \
      && grep -qE "packages/agentos-d/Dockerfile|agentos-d:" "$(pwd)/docker-compose.yml" 2>/dev/null; then
    SOURCE_DIR="$(pwd)"
    log_info "Using local checkout: ${SOURCE_DIR}"
    return 0
  fi

  if [[ -d "${SOURCE_DIR}/.git" ]]; then
    log_info "Updating existing source clone at ${SOURCE_DIR}"
    git -C "${SOURCE_DIR}" fetch --tags --depth=1 origin "${INSTALLER_REF}" 2>&1 | sed 's/^/  /'
    git -C "${SOURCE_DIR}" checkout -q FETCH_HEAD
  else
    log_info "Cloning ${REPO_URL} (${INSTALLER_REF}) -> ${SOURCE_DIR}"
    rm -rf "${SOURCE_DIR}"
    mkdir -p "$(dirname "${SOURCE_DIR}")"
    git clone --depth=1 --branch "${INSTALLER_REF}" "${REPO_URL}" "${SOURCE_DIR}" 2>&1 | sed 's/^/  /'
  fi

  log_info "Source ready: ${SOURCE_DIR}"
}

# -----------------------------------------------------------------------------
# compose() runs `docker compose` from the source root with the absolute data
# and config dirs exported, so bind-mount paths in docker-compose.yml resolve
# under $AGENTWORKS_DIR rather than relative to the source checkout.
#
# COMPOSE_PROJECT_NAME is derived from AGENTWORKS_DIR so two installs on the
# same host (different AGENTWORKS_DIR) don't collide on container/network
# names. Docker normalizes project names: lowercase, [a-z0-9_-] only.
# -----------------------------------------------------------------------------
awos_compose_project_name() {
  local raw
  raw="$(basename "${AGENTWORKS_DIR}")"
  printf '%s' "${raw}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | sed 's/^-*//;s/-*$//'
}

compose() {
  ( cd "${SOURCE_DIR}" \
    && AGENTWORKS_DATA_DIR="${DATA_DIR}" \
       AGENTWORKS_CONFIG_DIR="${CONFIG_DIR}" \
       COMPOSE_PROJECT_NAME="$(awos_compose_project_name)" \
       "${COMPOSE_CMD[@]}" --env-file "${ENV_FILE}" "$@" )
}

# -----------------------------------------------------------------------------
# Generate secrets
# -----------------------------------------------------------------------------
generate_secrets() {
  log_step "Generating secrets..."

  # Idempotency: if a previous run already generated credentials, reuse them.
  # Re-running install.sh after a partial failure (e.g. ports were busy) must
  # not invalidate the admin password the operator already saved.
  if [[ -f "${ENV_FILE}" ]] \
      && grep -q '^POSTGRES_PASSWORD=' "${ENV_FILE}" \
      && grep -q '^AGENTWORKS_SESSION_SECRET=' "${ENV_FILE}" \
      && [[ -f "${SECRETS_FILE}" ]]; then
    log_info "Reusing existing secrets at ${ENV_FILE} (re-install detected)"
    return 0
  fi

  # Admin password (32 chars, base64 with URL-unsafe chars stripped)
  local admin_password
  admin_password=$(openssl rand -base64 32 | tr -d '=\n/+' | head -c 32)

  # Session secret (32 bytes, hex)
  local session_secret
  session_secret=$(openssl rand -hex 32)

  # Database password — must be hex/alphanumeric so it can be embedded in the
  # postgres connection string without percent-encoding. base64 with `/` or
  # `+` corrupts the URL and the daemon fails to connect.
  local db_password
  db_password=$(openssl rand -hex 16)

  cat > "${ENV_FILE}" <<EOF
# Auto-generated on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# DO NOT COMMIT THIS FILE
AGENTWORKS_VERSION=${INSTALLER_VERSION}
AGENTWORKS_DATA_DIR=${DATA_DIR}
AGENTWORKS_CONFIG_DIR=${CONFIG_DIR}
AGENTWORKS_SESSION_SECRET=${session_secret}
POSTGRES_PASSWORD=${db_password}
POSTGRES_USER=agentworks
POSTGRES_DB=agentworks
AGENTOS_LOG_LEVEL=info
AGENTOS_AWCP_VERSION=awcp/v0.1
# AGENTOS_HOST and AGENTOS_PORT used to be written here, but compose
# hardcodes them in agentos-d's environment block (the daemon binds
# inside the container, the host doesn't reach in). Removed in v0.1.9 to
# avoid pretending they're tunable from .env.
#
# Override the default rule pack assigned at tenant creation by
# uncommenting one of these:
#   AGENTWORKS_DEFAULT_PACK_ID=utility-distribution-starter
#   AGENTWORKS_DEFAULT_PACK_ID=                # disables auto-assignment
EOF
  chmod 600 "${ENV_FILE}"

  cat > "${SECRETS_FILE}" <<EOF
{
  "admin_password": "${admin_password}",
  "session_secret": "${session_secret}",
  "db_password": "${db_password}"
}
EOF
  chmod 600 "${SECRETS_FILE}"

  log_info "Secrets written to ${SECRETS_FILE} (mode 600)"
  log_info ".env written to ${ENV_FILE}"
}

# -----------------------------------------------------------------------------
# Pull images (best-effort — v0.1 ships nothing pullable on Docker Hub)
# -----------------------------------------------------------------------------
pull_images() {
  log_step "Pulling Docker images (will fall through to local build on miss)..."
  # `|| true` because v0.1 publishes nothing under the docker-compose `image:`
  # paths. The build path below covers the failure.
  compose pull 2>&1 | tee "${LOG_DIR}/docker-pull.log" || true
}

# -----------------------------------------------------------------------------
# Start services
# -----------------------------------------------------------------------------
start_services() {
  log_step "Building and starting AgentWorks services (first build ~5-15 min)..."

  docker volume create agentworks-postgres-data &>/dev/null || true

  # --build forces a fresh local build for any image that wasn't pullable.
  if ! compose up -d --build 2>&1 | tee "${LOG_DIR}/docker-up.log"; then
    log_error "Failed to start services. Check ${LOG_DIR}/docker-up.log"
    exit 1
  fi

  log_info "Services started."
}

# -----------------------------------------------------------------------------
# Wait for services to be healthy
# -----------------------------------------------------------------------------
wait_for_services() {
  log_step "Waiting for services to be healthy..."

  local max_wait=120
  local elapsed=0
  local interval=5

  while [[ $elapsed -lt $max_wait ]]; do
    # Check agentos-d health
    local health_status
    health_status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:7710/api/health 2>/dev/null || echo "000")

    if [[ "$health_status" == "200" ]]; then
      log_info "agentos-d is healthy (HTTP ${health_status})"
      break
    fi

    echo -n "."
    sleep $interval
    elapsed=$((elapsed + interval))
  done
  echo ""

  if [[ $elapsed -ge $max_wait ]]; then
    log_warn "Services did not become healthy within ${max_wait} seconds."
    log_warn "Check status with: docker compose ps"
    log_warn "Logs: docker compose logs"
  fi
}

# -----------------------------------------------------------------------------
# Verify installation
# -----------------------------------------------------------------------------
verify_install() {
  log_step "Verifying installation..."

  local all_up=true

  # Check agentos-d
  local agentos_health
  agentos_health=$(curl -s http://localhost:7710/api/health 2>/dev/null || true)
  if [[ -n "$agentos_health" ]] && echo "$agentos_health" | grep -q '"status"'; then
    log_info "agentos-d: ${GREEN}UP${NC}"
  else
    log_error "agentos-d: ${RED}DOWN${NC}"
    all_up=false
  fi

  # Check postgres
  if compose ps postgres 2>/dev/null | grep -q "Up"; then
    if compose exec -T postgres pg_isready &>/dev/null; then
      log_info "postgres: ${GREEN}UP${NC}"
    else
      log_warn "postgres: ${YELLOW}DOWN${NC}"
    fi
  else
    log_warn "postgres: ${YELLOW}NOT STARTED${NC}"
  fi

  # Check scanner-worker
  if compose ps scanner-worker 2>/dev/null | grep -q "Up"; then
    log_info "scanner-worker: ${GREEN}UP${NC}"
  else
    log_warn "scanner-worker: ${YELLOW}DOWN or not running${NC}"
  fi

  # Check n8n
  local n8n_status
  n8n_status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5678 2>/dev/null || echo "000")
  if [[ "$n8n_status" == "200" ]] || [[ "$n8n_status" == "302" ]]; then
    log_info "n8n: ${GREEN}UP${NC} (HTTP ${n8n_status})"
  else
    log_warn "n8n: ${YELLOW}DOWN${NC} (HTTP ${n8n_status})"
  fi

  # Check admin-ui
  local admin_status
  admin_status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/mission-control 2>/dev/null || echo "000")
  if [[ "$admin_status" == "200" ]] || [[ "$admin_status" == "307" ]] || [[ "$admin_status" == "308" ]]; then
    log_info "admin-ui: ${GREEN}UP${NC} (HTTP ${admin_status})"
  else
    log_error "admin-ui: ${RED}DOWN${NC} (HTTP ${admin_status})"
    all_up=false
  fi

  if [[ "$all_up" == "false" ]]; then
    log_error "Some services failed to start. Run 'docker compose logs' for details."
    return 1
  fi

  log_info "All critical services are up."
}

# -----------------------------------------------------------------------------
# Install the agentworks CLI wrapper on PATH so the next-steps banner does not
# tell the operator (or an agent) to run a command that does not exist.
# Tries /usr/local/bin first (writable on most macOS, not on most Linux without
# sudo); falls back to ~/.local/bin and warns if it is not on PATH.
# Idempotent — replaces an existing symlink that points at our wrapper.
# -----------------------------------------------------------------------------
install_cli_wrapper() {
  local wrapper="${SOURCE_DIR}/apps/installer/src/agentworks.sh"
  if [[ ! -x "$wrapper" ]]; then
    log_warn "agentworks wrapper not found at ${wrapper} — skipping PATH install"
    return 0
  fi

  local target=""
  if [[ -w /usr/local/bin ]]; then
    target=/usr/local/bin/agentworks
  else
    mkdir -p "${HOME}/.local/bin"
    target="${HOME}/.local/bin/agentworks"
  fi

  ln -sf "$wrapper" "$target"
  chmod +x "$target" 2>/dev/null || true
  AGENTWORKS_CLI_PATH="$target"

  if command -v agentworks &>/dev/null; then
    log_info "agentworks CLI installed: ${target}"
    return 0
  fi

  # CLI is not on PATH — try to add ~/.local/bin to the user's shell rc so
  # the next shell picks it up automatically. Only touches the rc the
  # current shell points at; idempotent (skips if the line already exists).
  local rc=""
  case "${SHELL:-}" in
    *zsh)  rc="${HOME}/.zshrc" ;;
    *bash)
      if [[ -f "${HOME}/.bashrc" ]]; then rc="${HOME}/.bashrc"
      elif [[ -f "${HOME}/.bash_profile" ]]; then rc="${HOME}/.bash_profile"
      fi
      ;;
  esac

  local path_line='export PATH="$HOME/.local/bin:$PATH"  # added by AgentWorks installer'
  if [[ -n "$rc" ]] && [[ -w "$rc" || ! -e "$rc" ]]; then
    if ! grep -qsF '$HOME/.local/bin:$PATH' "$rc" 2>/dev/null; then
      printf '\n%s\n' "$path_line" >> "$rc"
      log_info "agentworks CLI installed: ${target}"
      log_info "Added ~/.local/bin to PATH in ${rc} — open a new shell, or run:"
      log_info "  source ${rc}"
      return 0
    fi
  fi

  log_warn "Installed agentworks at ${target}, but it is not on PATH."
  log_warn "Add to your shell rc:  export PATH=\"${HOME}/.local/bin:\$PATH\""
  log_warn "Or invoke directly: ${target} status"
}

# -----------------------------------------------------------------------------
# Extract the MCP stdio bridge out of the running agentos-d container so the
# wrapper's `agentworks mcp configure` step has a real file to point Claude
# Desktop / Cursor / Codex at. The bridge is shipped inside the image; this is
# a one-time copy, not a runtime dependency.
# -----------------------------------------------------------------------------
extract_mcp_bridge() {
  local target="${CONFIG_DIR}/mcp-stdio-bridge.js"
  if compose cp agentos-d:/app/dist/bin/mcp-stdio-bridge.js "$target" 2>/dev/null; then
    chmod +x "$target" 2>/dev/null || true
    log_info "MCP stdio bridge extracted: ${target}"
  else
    log_warn "Could not extract MCP bridge from agentos-d container — agentworks mcp configure may need manual setup"
  fi
}

# -----------------------------------------------------------------------------
# Print next steps
# -----------------------------------------------------------------------------
print_next_steps() {
  local cli="${AGENTWORKS_CLI_PATH:-${SOURCE_DIR}/apps/installer/src/agentworks.sh}"

  echo ""
  echo "=============================================================================="
  echo -e "${GREEN}AgentWorks OS installation complete!${NC}"
  echo "=============================================================================="
  echo ""
  echo "Substrate:"
  echo "  agentos-d API:  http://localhost:7710  (REST + MCP)"
  echo "  scanner-worker: http://localhost:3101  (security scanner)"
  echo "  n8n workflows:  http://localhost:5678  (self-hosted only — see licenses/SUL_NOTICE.md)"
  echo "  admin-ui:       http://localhost:3000  (operator dashboard)"
  echo ""
  echo "Admin password is in ${SECRETS_FILE} (mode 600). DO NOT print it to chat."
  echo "  Read with: cat ${SECRETS_FILE}"
  echo ""
  echo "Next steps:"
  echo "  1. Connect a coding agent: ${cli} mcp configure"
  echo "  2. Tail logs while you test: ${cli} logs"
  echo "  3. Take a baseline backup:  ${cli} backup"
  echo ""
  echo "Commands:"
  echo "  ${cli} status        # Show service status"
  echo "  ${cli} logs          # Tail service logs"
  echo "  ${cli} update        # Update to latest version"
  echo "  ${cli} uninstall     # Remove AgentWorks"
  echo ""
  echo "=============================================================================="
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
  echo ""
  echo "AgentWorks OS Installer v${INSTALLER_VERSION}"
  echo "============================================="
  echo ""

  # Check for --unattended flag (skip prompts)
  local unattended=false
  if [[ "${1:-}" == "--unattended" ]]; then
    unattended=true
  fi

  if [[ "$unattended" != "true" ]]; then
    echo "This will install AgentWorks OS on this machine."
    echo "Docker is required. The installer will:"
    echo "  1. Create ~/.agentworks/ directory"
    echo "  2. Clone the AgentWorks OS source (~50 MB) into ~/.agentworks/source"
    echo "  3. Generate secure credentials"
    echo "  4. Build and start AgentWorks Docker services"
    echo ""
    echo -n "Press Enter to continue, or Ctrl+C to cancel: "
    read -r
  fi

  preflight_check
  create_directories
  acquire_source
  generate_secrets
  pull_images
  start_services
  wait_for_services
  verify_install || true
  install_cli_wrapper
  extract_mcp_bridge
  run_smoke_test
  print_next_steps
}

# -----------------------------------------------------------------------------
# Run the end-to-end smoke test (POST tenant + policy.check + assertions).
# Always runs — the install isn't "done" if the substrate can't take a write.
# -----------------------------------------------------------------------------
run_smoke_test() {
  local smoke="${SOURCE_DIR}/apps/installer/scripts/smoke-test.sh"
  if [[ ! -x "$smoke" ]]; then
    log_warn "Smoke test script not found at ${smoke} — skipping."
    log_warn "Manual verification: curl http://localhost:7710/api/health"
    return 0
  fi

  log_step "Running end-to-end smoke test..."
  if AGENTOS_URL="http://127.0.0.1:7710" "$smoke"; then
    log_info "Smoke test PASSED — substrate is healthy and responding to writes."
  else
    log_error "Smoke test FAILED. The substrate booted but is not behaving correctly."
    log_error "Above output points at the failed step. After fixing, re-run only the smoke test:"
    log_error "  ${smoke}"
    return 1
  fi
}

main "$@"
