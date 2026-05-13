# Backup and Restore

## When to back up

- Before upgrading AgentWorks OS
- Before changing rule-pack configuration
- Before reseeding or bulk-writing vault content
- Before restarting services for maintenance
- Weekly as part of normal operations

## What gets backed up

The v0.1.9 `agentworks backup` command archives:

- `~/.agentworks/data/` including the vault, SQLite data, scanner state, and n8n data
- `~/.agentworks/config/` including `.env`, `secrets.json`, and MCP bridge config
- a best-effort Postgres dump when the Postgres service is reachable

It does not include:

- container images
- the source checkout under `~/.agentworks/source`
- Docker build cache
- agent-side config files that live outside the AgentWorks host

Treat every backup as sensitive. It can contain customer data and generated secrets.

## Create a backup

Basic backup:

```bash
agentworks backup ~/.agentworks/data/backups/agentworks-backup-$(date +%Y%m%d-%H%M%S).tar.gz
```

If `agentworks` is not on PATH:

```bash
~/.agentworks/source/apps/installer/src/agentworks.sh backup \
  ~/.agentworks/data/backups/agentworks-backup-$(date +%Y%m%d-%H%M%S).tar.gz
```

Optional encryption uses `BACKUP_PASSPHRASE`. The passphrase is not stored by AgentWorks.

```bash
BACKUP_PASSPHRASE='use-a-long-operator-held-passphrase' \
  agentworks backup ~/.agentworks/data/backups/agentworks-backup-$(date +%Y%m%d-%H%M%S).tar.gz
```

With encryption enabled, the command writes a `.enc` file and removes the unencrypted tarball.

## Verify a backup

```bash
ls -lh ~/.agentworks/data/backups/
tar -tzf ~/.agentworks/data/backups/<backup>.tar.gz | head
```

For encrypted backups, verify that the file can be decrypted with the operator-held passphrase before relying on it:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 \
  -pass pass:'use-the-operator-held-passphrase' \
  -in /path/to/agentworks-backup.enc \
  -out /tmp/agentworks-backup-verify.tar.gz
tar -tzf /tmp/agentworks-backup-verify.tar.gz | head
rm -f /tmp/agentworks-backup-verify.tar.gz
```

## Restore from a backup

Restore is destructive: it replaces the current data and config directories with the archive contents.

If the backup is encrypted, decrypt it first:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 \
  -pass pass:'use-the-operator-held-passphrase' \
  -in /path/to/agentworks-backup.enc \
  -out /tmp/agentworks-backup.tar.gz
```

```bash
agentworks restore /path/to/agentworks-backup.tar.gz
# or, for the decrypted example above:
agentworks restore /tmp/agentworks-backup.tar.gz
```

Known v0.1.9 CLI limit: `agentworks restore --input <file>` appears in the CLI help, but the wrapper currently accepts the backup path as the first positional argument.

After restore:

```bash
agentworks status
curl -fsS http://127.0.0.1:7710/api/health
~/.agentworks/source/apps/installer/scripts/smoke-test.sh
```

## Test a restore

Before you need a restore to work, test it on a non-production host:

1. Create a backup.
2. Copy the backup to a clean test machine.
3. Install AgentWorks OS.
4. Run `agentworks restore <backup>`.
5. Run the E2E smoke test.

Do not practice restore by overwriting production unless the operator explicitly approves the maintenance window.

## Retention

| Environment | Recommended retention |
|---|---|
| Production | 30 days, at least one per week |
| Staging / test | 7 days |
| Before upgrades | one backup per upgrade |

Keep at least one pre-upgrade backup after every update. Store backups somewhere other than the same machine running AgentWorks OS.

## Off-machine copy

```bash
scp ~/.agentworks/data/backups/<backup>.tar.gz user@backup-server:/path/to/backups/
```

For encrypted backups, do not transmit the passphrase over the same channel as the backup file.

## Not included and why

- **Container images:** re-pull or rebuild from the release source.
- **Source checkout:** restore data onto a clean install of the same release, then update normally.
- **Agent configs:** Claude, Cursor, Codex, and other client configs live on the agent machines and should be backed up there.
