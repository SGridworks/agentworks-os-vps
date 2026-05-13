# AgentWorks OS VPS Blank-Slate Install

Use this runbook when the VPS must start clean: no operator vault, no local database, no local secrets, no imported agent artifacts, and no Git history copied to the server.

## Source rule

Deploy a sanitized source archive, not a workstation clone.

The archive must be built from a commit that has:

- no `agents/_imported/` directory
- no `.env`, `secrets.json`, SQLite DB, WAL, or SHM files
- no `agent-lanes.json`
- no operator-specific absolute paths or email addresses
- no `.git/` directory in the delivered payload

Build the archive from the sanitized source checkout:

```bash
git status --short
pnpm build
AGENTWORKS_SESSION_SECRET=dummy \
POSTGRES_PASSWORD=dummy \
POSTGRES_USER=agentworks \
POSTGRES_DB=agentworks \
AGENTWORKS_SOURCE_DIR="$PWD" \
AGENTWORKS_DATA_DIR=/tmp/agentworks-vps-data \
AGENTWORKS_CONFIG_DIR=/tmp/agentworks-vps-config \
docker compose build

git archive --format=tar.gz --prefix=agentworks-os/ HEAD > agentworks-os-vps.tar.gz
shasum -a 256 agentworks-os-vps.tar.gz
```

Archive boundary check:

```bash
python3 - <<'PY'
import tarfile

archive = 'agentworks-os-vps.tar.gz'
needles = [
    b'YOUR_PRIVATE_NAME',
    b'YOUR_PRIVATE_EMAIL',
    b'/path/to/private/vault',
    b'private-workstation-only',
]
violations = []
with tarfile.open(archive) as tf:
    names = tf.getnames()
    if any('/.git/' in name or name.endswith('/.git') for name in names):
        violations.append(('.git directory', 'archive structure'))
    if any(name.startswith('agentworks-os/agents/_imported/') for name in names):
        violations.append(('agents/_imported', 'archive structure'))
    if any(name.endswith('.db') or '.db-' in name for name in names):
        violations.append(('sqlite db', 'archive structure'))
    if any(name.endswith('agent-lanes.json') for name in names):
        violations.append(('agent-lanes.json', 'archive structure'))
    for member in tf.getmembers():
        if not member.isfile():
            continue
        data = tf.extractfile(member).read()
        for needle in needles:
            if needle in data:
                violations.append((member.name, needle.decode()))

if violations:
    for path, match in violations:
        print(f'FAIL {path}: {match}')
    raise SystemExit(1)
print('PASS archive boundary clean')
PY
```

## VPS bootstrap

Assume Ubuntu 22.04 LTS or Debian 12, a sudo-capable user, and at least 4 GB RAM / 40 GB disk.

Install Docker:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker
newgrp docker
```

Firewall for a locked-down default install:

```bash
sudo ufw allow 22/tcp
sudo ufw --force enable
```

Port policy:

- `7710`: AgentWorks API / MCP. Bound to `127.0.0.1` by default; do not expose directly.
- `3101`: scanner-worker health/findings API. Bound to `127.0.0.1` by default; do not expose directly.
- `5678`: n8n. Bound to `127.0.0.1` by default; use an SSH tunnel for admin work.
- `3000`: Admin UI. Bound to `127.0.0.1` by default; use an SSH tunnel or authenticated TLS reverse proxy.

For remote testing from a workstation, use SSH tunnels instead of opening the ports:

```bash
ssh -N \
  -L 17710:127.0.0.1:7710 \
  -L 13000:127.0.0.1:3000 \
  -L 13101:127.0.0.1:3101 \
  -L 15678:127.0.0.1:5678 \
  <user>@<vps-host>
```

## Copy and extract the sanitized archive

From the workstation:

```bash
scp agentworks-os-vps.tar.gz <user>@<vps-host>:/tmp/agentworks-os-vps.tar.gz
```

On the VPS:

```bash
rm -rf ~/.agentworks/source
mkdir -p ~/.agentworks
tar -xzf /tmp/agentworks-os-vps.tar.gz -C ~/.agentworks
mv ~/.agentworks/agentworks-os ~/.agentworks/source
cd ~/.agentworks/source
```

Verify the extracted source boundary before install:

```bash
test ! -d .git
test ! -d agents/_imported
test ! -f agent-lanes.json
find . -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm'
```

The `find` command should print nothing.

## Install blank slate

Run from the extracted source root:

```bash
cd ~/.agentworks/source
AGENTWORKS_DIR="$HOME/.agentworks" ./apps/installer/src/install.sh --unattended
```

The installer will generate fresh secrets on the VPS:

- `~/.agentworks/config/.env`
- `~/.agentworks/config/secrets.json`
- `~/.agentworks/data/`

Do not copy any workstation versions of those files.

## Verify

```bash
cd ~/.agentworks/source
docker compose --env-file ~/.agentworks/config/.env -f ~/.agentworks/source/docker-compose.yml ps
curl -fsS http://127.0.0.1:7710/api/health
curl -fsS http://127.0.0.1:3101/health
~/.agentworks/source/apps/installer/scripts/smoke-test.sh
```

Expected:

- `agentos-d` is up on `7710`
- `scanner-worker` is up on `3101`
- `n8n` is up on `5678` and `/healthz`
- `admin-ui` is up on `3000`
- smoke test exits zero
- `~/.agentworks/data/vault` starts empty except files created by first boot/onboarding

Admin UI check:

```bash
curl -fsSI http://127.0.0.1:3000/
curl -fsSI http://127.0.0.1:3000/mission-control
```

## Data-boundary verification after install

```bash
cd ~/.agentworks/source
python3 - <<'PY'
from pathlib import Path

root = Path('.').resolve()
forbidden_paths = [
    root / 'agents' / '_imported',
    root / 'agent-lanes.json',
    root / '.git',
]
for path in forbidden_paths:
    if path.exists():
        raise SystemExit(f'FAIL forbidden path exists: {path}')

for pattern in ('*.db', '*.db-wal', '*.db-shm', '.env', 'secrets.json'):
    matches = list(root.rglob(pattern))
    if matches:
        raise SystemExit(f'FAIL source contains {pattern}: {matches[:5]}')

print('PASS source contains no local data/secrets')
PY
```

Then verify generated VPS secrets live only under the VPS config directory:

```bash
test -f ~/.agentworks/config/.env
test -f ~/.agentworks/config/secrets.json
test -d ~/.agentworks/data
```

## Rollback

Stop services without deleting generated data:

```bash
cd ~/.agentworks/source
docker compose --env-file ~/.agentworks/config/.env -f ~/.agentworks/source/docker-compose.yml down
```

Full reset is destructive and should only be used when the VPS must be blank again:

```bash
docker compose --env-file ~/.agentworks/config/.env -f ~/.agentworks/source/docker-compose.yml down -v
rm -rf ~/.agentworks
```
