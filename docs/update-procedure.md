# Update Procedure

AgentWorks OS updates are operator-controlled. There is no forced auto-update.

## Check the installed version

```bash
agentworks --help | head -1
```

The wrapper banner includes the installed CLI version.

If `agentworks` is not on PATH, invoke the installed wrapper directly:

```bash
~/.agentworks/source/apps/installer/src/agentworks.sh --help | head -1
```

## Check for updates

```bash
agentworks update --check
```

This reads the latest GitHub release tag and compares it with the installed wrapper version.

## Pre-update checklist

1. Create a backup:

   ```bash
   agentworks backup ~/.agentworks/data/backups/pre-update-$(date +%Y%m%d-%H%M%S).tar.gz
   ```

2. Confirm disk space:

   ```bash
   df -h "$HOME"
   ```

3. Confirm the current stack is healthy:

   ```bash
   agentworks status
   ~/.agentworks/source/apps/installer/scripts/smoke-test.sh
   ```

4. Read the target release notes in [CHANGELOG.md](../CHANGELOG.md).

## Apply an update

```bash
agentworks update
```

In v0.1.9, update:

1. fetches the latest semver tag from GitHub
2. updates `~/.agentworks/source` to that tag
3. refreshes non-git archive installs by replacing `~/.agentworks/source` with a shallow clone of the release tag
4. pulls published `agentos-d`, `scanner-worker`, and `admin-ui` images from GHCR
5. starts those runtime images without rebuilding, then builds and starts the local n8n custom-node image

After update:

```bash
agentworks status
~/.agentworks/source/apps/installer/scripts/smoke-test.sh
```

## Reverting a failed update

If the update fails before migrations or data changes, return to the previous tag from the source clone and restart:

```bash
cd ~/.agentworks/source
git tag --sort=-version:refname | head
git checkout <previous-good-tag>
agentworks restart
~/.agentworks/source/apps/installer/scripts/smoke-test.sh
```

If data changed or migrations failed, restore the pre-update backup:

```bash
agentworks restore ~/.agentworks/data/backups/<pre-update-backup>.tar.gz
agentworks status
~/.agentworks/source/apps/installer/scripts/smoke-test.sh
```

Preserve logs before deleting containers or data:

```bash
agentworks support-bundle agentworks-support-update-failure-$(date +%Y%m%d-%H%M%S).tar.gz
```

## Rule packs and updates

Rule packs are data, not container images. They persist across updates and are included in backups when stored under the AgentWorks data/config directories.

After any update that touches policy behavior:

```bash
curl -fsS http://127.0.0.1:7710/api/policy/packs
curl -fsS -X POST http://127.0.0.1:7710/api/policy/packs/reload
~/.agentworks/source/apps/installer/scripts/smoke-test.sh
```
