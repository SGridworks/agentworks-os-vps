# Error Messages

Every error visible to the customer has a plain-English explanation here. If you see an error not listed, report it to sgridworks support.

## Installer Errors

### "Docker is not running"

The install script couldn't talk to Docker. Docker Desktop (or Docker Engine on Linux) needs to be running before you run the install command.

**Fix:** Open Docker Desktop. Wait for the whale icon in the menu bar to stop animating. Then run the install command again.

---

### "Port 7710 is already in use"

The agentos-d daemon couldn't start because something else is using port 7710.

**Fix:** Find what's on port 7710:

```
lsof -i :7710
```

Stop the conflicting process and re-run the installer. Custom host ports are not supported in v0.1.x.

---

### "GHCR image pull failed: unauthorized"

The installer couldn't pull the container image from GitHub Container Registry. Your Docker client might not be logged in to GHCR, or the image isn't published yet.

**Fix:** Log in to GHCR:

```
echo $GITHUB_TOKEN | docker login ghcr.io -u GITHUB_USERNAME --password-stdin
```

If you don't have a GitHub token with read:packages scope, contact sgridworks support.

---

### "Temporary password not found in output"

The installer no longer relies on parsing the password from output. Generated secrets are stored on the host.

**Fix:** read `~/.agentworks/config/secrets.json` locally on the AgentWorks host.

---

## MCP / Agent Connection Errors

### "MCP connection refused"

Claude Desktop (or another MCP client) can't reach the AgentWorks OS MCP server.

**Causes and fixes:**

1. **AgentWorks OS isn't running.** Run `agentworks status` and confirm `agentos-d` shows `Up`.

2. **Wrong URL in Claude Desktop config.** The MCP server URL in your Claude Desktop config must exactly match the daemon URL. By default the daemon listens on `http://127.0.0.1:7710`. No trailing slash.

3. **Different machines.** If Claude Desktop runs on a different machine than AgentWorks OS, use the server's IP address instead of `agentworks.local`. Example: `http://192.168.1.100:7710` not `http://agentworks.local:7710`.

4. **Firewall or tunnel blocking port 7710.** On a VPS, keep the port loopback-bound and connect through an SSH tunnel or authenticated reverse proxy.

---

### "/memory read: command not found"

The agent doesn't have the AgentWorks OS MCP tools loaded.

**Fix:** Check that the `agentworks` MCP server is in your Claude Desktop config and that the URL points to the correct port (7710 by default):

```json
{
  "mcpServers": {
    "agentworks": {
      "url": "http://agentworks.local:7710"
    }
  }
}
```

If the entry is there but the tools aren't loading, restart Claude Desktop.

---

## Policy Engine Errors

### "Pack invalid: syntax error at line X"

The rule pack YAML has a syntax error. The policy engine couldn't parse it.

**Fix:** Validate the pack with the CLI:

```
pnpm --filter @agentworks/policy-engine test -- /path/to/pack.yaml
```

Or check the pack in the admin UI at **Policy** -> **Rule Packs**. The invalid pack shows an error badge.

See [rule-pack-authoring.md](./rule-pack-authoring.md) for the schema.

---

### "Pack invalid: rule 'X' references undefined field 'Y'"

A rule condition references a field that doesn't exist in the canonical action schema.

**Fix:** Check the AWCP spec for the correct field name. Field names in rule conditions must match the schema exactly.

---

### "Pack invalid: missing required field"

A rule in the pack is missing a required field. The error message names the specific field.

**Fix:** Check the rule against the schema in [rule-pack-authoring.md](./rule-pack-authoring.md). Every rule needs `rule_id`, `name`, `conditions`, and `disposition_when_missing`. Rules that reference fields that don't exist in the action schema also produce this error.

---

### "Eval timeout: rule 'X' exceeded 5s"

A rule took longer than 5 seconds to evaluate. This usually means the condition references a data provider that's slow or unreachable.

**Fix:** Check that any external data providers (DNC lookup, consent records) are responding. If a condition depends on network calls, add a timeout or switch to a cached result.

---

### "Route to review: required data missing"

A rule returned `route_to_review` because the action is missing a field the rule needs. The data might be in your CRM or consent system but not passed through the action payload.

**Fix:** Route to the approval queue. The reviewer has the context to decide manually. To fix permanently, update the integration that submits actions to include the missing field.

---

### "Decision unavailable: no packs loaded"

The policy engine is running but no rule packs are active.

**Fix:** Go to **Policy** -> **Rule Packs** -> **Add Pack** in the admin UI. Select a template or load a custom pack.

---

## Scanner Errors

### "Scanner: sidecar unreachable"

The main daemon can't talk to the scanner-worker sidecar.

**Fix:** Check if the scanner container is running:

```
docker compose ps scanner-worker
```

If it's down, restart it:

```
docker compose up -d scanner-worker
```

If it keeps going down, check the logs:

```
docker compose logs scanner-worker
```

---

### "Scanner: no configs found"

The scanner ran but didn't find any agent configs to scan.

**Fix:** The scanner watches the configured config directory. By default, it looks in `~/.claude/` and the project directories you specify in the admin UI at **Security** -> **Scanner Settings**.

Add the paths to your agent config directories.

---

## n8n Workflow Errors

### "Substrate unreachable from n8n node"

An n8n workflow using a substrate-aware node can't reach `agentos-d`.

**Fixes:**

1. Confirm `agentos-d` is running: `docker compose ps agentos-d`
2. Check the n8n container can reach the API: `docker exec n8n curl http://agentos-d:7710/health`
3. If they run on different Docker networks, check the docker-compose.yml network configuration

---

## Admin UI Errors

### "Session expired"

Your admin session timed out after 8 hours of inactivity.

**Fix:** Log in again at `http://agentworks.local:7710`.

---

### "Error loading vault"

The vault partition is unreadable or corrupt.

**Fix:** Check disk space. Run `df -h` on the machine running AgentWorks OS. If disk is full, free up space and restart:

```
docker compose restart agentos-d
```

---

## Backup / Restore Errors

### "Restore: checksum mismatch"

The restore archive is corrupt or was modified after creation.

**Fix:** Re-create the backup. Do not attempt to use a corrupt archive.

---

### "Restore: version mismatch"

The archive was created with a different version of AgentWorks OS.

**Fix:** Upgrade AgentWorks OS to the version that created the archive before restoring. See [update-procedure.md](./update-procedure.md).

---

## Update Errors

### "Update: unable to stop services"

The updater couldn't cleanly shut down the running services.

**Fix:** Stop services manually:

```
docker compose down
```

Then retry the update.

---

### "Update: migration failed"

A database migration failed during the update.

**Fix:** Contact sgridworks support. Do not attempt to bypass the migration or restore from backup without consulting support first.
