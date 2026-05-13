# MCP Integration Guide

Connect Claude Desktop, Cursor, and Codex to AgentWorks OS via the Model Context Protocol. Once connected, your agents can read and write vault memory, submit actions through the policy engine, and log activity to the audit trail.

**Last updated:** 2026-04-29  
**agentos-d minimum version:** 0.1.0

---

## What the MCP connection enables

After pairing, your agent tools can call four substrate functions directly:

| Tool | What it does |
|------|-------------|
| `memory.read` | Read a vault page by key for your tenant |
| `memory.write` | Append or replace a vault page |
| `policy.check` | Evaluate a proposed action against active rule packs |
| `activity.log` | Append an entry to the audit trail |

All four tools require your tenant ID and are authenticated via the same bearer token your Admin UI session uses.

---

## Prerequisites

- AgentWorks OS installed and running (`docker compose up` or the installer)
- `agentos-d` daemon reachable at the host/port from your install (default: `http://127.0.0.1:7710`)
- Claude Desktop installed on macOS, or Cursor, or Codex CLI
- Your AgentWorks tenant ID (shown in the Admin UI under Settings > Tenant Info)

---

## Finding your connection details

### Daemon URL

The `agentos-d` daemon listens on the host and port from your install. The default is:

```
http://127.0.0.1:7710
```

The default v0.1.x install uses port 7710. Custom install ports are not
supported by the installer yet.

### Tenant ID

1. List tenants from the daemon:

   ```bash
   curl -s http://127.0.0.1:7710/api/tenants
   ```

2. Copy the `id` for the tenant you want to connect — a UUID, for example `00000000-0000-4000-8000-000000000001`.

### Bearer token

If you are running a managed install through sgridworks, your token was provided during onboarding. Self-hosted token generation is not yet available via CLI; ask your sgridworks contact for a token.

> **Auth status:** the MCP bridge does not yet forward bearer tokens to the daemon. The `/api/mcp` route is currently open on localhost. This is acceptable for local-only installs but is not suitable for production exposure. Auth forwarding is tracked in AWO-152.

---

## Connecting Claude Desktop

Claude Desktop uses a JSON config file to declare MCP servers. AgentWorks ships a **stdio bridge** that translates between Claude Desktop's stdio protocol and the daemon's HTTP endpoint.

### Step 1 — Find the bridge binary

The bridge ships inside the `agentos-d` package:

```bash
ls packages/agentos-d/dist/bin/mcp-stdio-bridge.js
```

If you installed via Docker, the bridge is at the same path inside the container. Extract it to the host machine if needed:

```bash
docker cp agentos-d:/app/dist/bin/mcp-stdio-bridge.js \
  ~/agentworks-mcp-bridge.js
```

### Step 2 — Write the Claude Desktop config

Open the config file. Create it if it does not exist:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add the `agentworks` server entry:

```json
{
  "mcpServers": {
    "agentworks": {
      "command": "node",
      "args": ["/FULL/PATH/TO/mcp-stdio-bridge.js"],
      "env": {
        "AGENTOS_URL": "http://127.0.0.1:7710"
      }
    }
  }
}
```

Replace the following:

- `/FULL/PATH/TO/mcp-stdio-bridge.js` — absolute path to the bridge binary on your machine

### Step 3 — Restart Claude Desktop

```bash
killall Claude
```

Or quit and relaunch Claude Desktop.

### Step 4 — Confirm the connection

In Claude Desktop, run:

```
/mcp list
```

You should see `agentworks` listed as an active MCP server.

To confirm the tools are callable, try a read against your tenant vault:

```
Use the agentworks memory.read tool to read the page at key "welcome" for tenant 00000000-0000-4000-8000-000000000001
```

If the vault was seeded during onboarding, you will get back the welcome page content. If the vault is empty, you will get an empty response with `existed: false`.

---

## Connecting Cursor

Cursor uses the same MCP stdio protocol. Add to Cursor's MCP config file (typically `~/.cursor/mcp.json` or set via Cursor Settings > MCP):

```json
{
  "mcpServers": {
    "agentworks": {
      "command": "node",
      "args": ["/FULL/PATH/TO/mcp-stdio-bridge.js"],
      "env": {
        "AGENTOS_URL": "http://127.0.0.1:7710"
      }
    }
  }
}
```

Restart Cursor after saving. Use the Cursor MCP connection panel to verify the `agentworks` server shows green.

--

## Connecting Codex CLI

Codex CLI connects to MCP servers declared in its config. Add the `agentworks` entry:

```json
{
  "mcpServers": {
    "agentworks": {
      "command": "node",
      "args": ["/FULL/PATH/TO/mcp-stdio-bridge.js"],
      "env": {
        "AGENTOS_URL": "http://127.0.0.1:7710"
      }
    }
  }
}
```

Restart Codex. Verify with:

```
codex --mcp list
```

---

## Tool reference

All four tools accept JSON arguments. The MCP protocol wraps them in a `tools/call` envelope. The bridge handles the wire format — you pass plain arguments.

### memory.read

```json
{
  "tenantId": "00000000-0000-4000-8000-000000000001",
  "key": "projects/my-project"
}
```

Returns: `{ tenantId, key, body, updatedAt, sha256, existed }`

- `key` — dot-notation path within your vault, e.g. `projects/sgridworks` or `context/contacts`
- `body` — markdown content of the page
- `existed` — `false` if the key has never been written

### memory.write

```json
{
  "tenantId": "00000000-0000-4000-8000-000000000001",
  "key": "projects/my-project",
  "body": "# My Project\n\nContent here.",
  "mode": "replace"
}
```

`mode` is optional. `replace` (default) overwrites the page. `append` adds a timestamped entry to the end.

Returns: `{ tenantId, key, bytesWritten, updatedAt, sha256 }`

### policy.check

```json
{
  "tenantId": "00000000-0000-4000-8000-000000000001",
  "actor": {
    "id": "agent-001",
    "type": "agent",
    "label": "lead-enrichment-agent"
  },
  "proposedAction": {
    "kind": "outbound.sms",
    "summary": "Send SMS offer to lead at +1555XXXXXXXX"
  },
  "evidenceSnapshot": {
    "dnc_status": false,
    "consent_source": "web_form",
    "phone_type": "mobile"
  }
}
```

Returns: `{ decisionId, actionId, decision, decisionReason, shadowMode, rulePackId, rulePackVersion, approvalQueueId, createdAt }`

- `decision` — `allow`, `block`, or `route_to_review`
- `shadowMode` — `true` if the check was advisory-only (see Shadow mode below)
- `approvalQueueId` — present only when `decision` is `route_to_review` in enforce mode

### activity.log

```json
{
  "tenantId": "00000000-0000-4000-8000-000000000001",
  "actor": {
    "id": "agent-001",
    "type": "agent",
    "label": "lead-enrichment-agent"
  },
  "actionKind": "lead.enrich",
  "payloadSnapshot": {
    "leadId": "lead-123",
    "source": "zillow"
  },
  "vaultRefs": [],
  "conversationRefs": [],
  "projectRefs": []
}
```

Returns: `{ id, tenantId, loggedAt }`

---

## Shadow mode

By default, the MCP `policy.check` call runs in whatever mode your tenant is configured for — shadow (advisory-only) or enforce (blocking).

To force advisory-only evaluation for a specific call, pass:

```json
{ "shadowMode": true }
```

This is useful when you want to preview what the policy engine would decide before a live action runs.

---

## Error codes

| Code | Meaning |
|------|---------|
| `-32000` | `agentos-d` is unreachable — check that the daemon is running and `AGENTOS_URL` is correct |
| `-32602` | Invalid arguments — check the schema for the tool you are calling |
| `-32601` | Unknown tool — the tool name is not recognized |

---

## Troubleshooting

### Claude Desktop does not show the agentworks server

1. Confirm the config file path is correct: `~/Library/Application Support/Claude/claude_desktop_config.json`
2. Confirm the bridge binary exists at the path you specified
3. Run `killall Claude` (not just close the window)
4. Check the macOS Console app for Claude Desktop crash logs if the server still does not appear

### Tools return "not_implemented"

You are running an older version of `agentos-d` before the MCP tool implementations were completed. Update to the latest release and restart the daemon:

```bash
docker compose pull agentworks
docker compose up -d
```

### Policy check returns block with no reason

The active rule packs matched the action but did not provide a human-readable reason. This is a rule-pack authoring issue — contact whoever maintains your rule packs. The decision is logged in the Admin UI under Policy Decisions.

### Tenant ID not recognized

Confirm the tenant ID from the Admin UI matches exactly. The tenant ID in the MCP call must match the tenant the daemon is managing. If you have multiple tenants, each MCP connection is scoped to one.

---

## Security notes

- The default `http://127.0.0.1:7710` endpoint is localhost-only. Do not expose it to the internet without a TLS terminator and auth layer in front.
- Bearer-token auth for MCP connections is not yet implemented (see AWO-152). The bridge currently makes unauthenticated requests to `/api/mcp`. Do not expose the daemon port directly on a network interface other than localhost until AWO-152 is resolved.
- If you are using Cursor or Codex on the same machine as `agentos-d`, the localhost connection is sufficient. For remote connections, use a VPN or SSH tunnel.
- Claude Desktop, Cursor, and Codex all store MCP config files on disk in plain text. Treat these config files the same as API keys.
