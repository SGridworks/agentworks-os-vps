# Migration Guide

**Audience:** Users with an existing agent setup (Claude Desktop, Cursor, Codex, or custom agents) who are moving to AgentWorks OS and want to bring their existing memory, context, and conventions with them.

This guide covers migrating:
1. Vault memory from a previous memory system
2. Agent configuration files (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`)
3. Rule pack knowledge from any existing policy logic
4. Historical audit or activity data (optional)

If you are doing a greenfield install, go to the [Install Runbook](./install-runbook.md) instead.

---

## Before You Start

Run the installer on your target machine before beginning migration:

```bash
curl -fsSL https://github.com/SGridworks/agentworks-os-vps/releases/download/v0.1.9/install.sh | bash
```

Make sure all services show `Up` before proceeding. The default stack starts the Admin UI at `http://localhost:3000`; REST/MCP checks below remain the canonical automation path.

---

## Migrating Vault Memory

The AgentWorks OS vault is a tenant-scoped directory of markdown files on disk. It lives at:

```
~/.agentworks/data/vault/{tenant_id}/
```

Each file is a vault page. The filename (without `.md`) is the page key.

### Exporting from Your Existing System

#### From a markdown-vault system

If your current setup is a directory of markdown files (Obsidian-style or similar), the simplest path is to copy the vault directory into the AgentWorks vault structure.

1. Find your existing vault directory
2. Copy all `.md` files into your tenant's vault directory:

```bash
# Create the tenant vault directory if it doesn't exist
mkdir -p ~/.agentworks/data/vault/{YOUR_TENANT_ID}

# Copy markdown files from an existing vault only when intentionally migrating data.
# Blank-slate installs should skip this step.
cp /path/to/existing/vault/wiki/**/*.md ~/.agentworks/data/vault/{YOUR_TENANT_ID}/
```

3. The admin UI will pick up the new files on next page refresh. Or trigger a re-index:

```bash
curl -X POST http://localhost:7710/api/memory/reindex \
  -H "Content-Type: application/json" \
  -d '{ "tenantId": "YOUR_TENANT_ID" }'
```

#### From a structured-record system

If your existing system stores memory as structured records (JSON, SQLite, etc.), write a one-shot migration script:

```python
import json, os
from pathlib import Path

VAULT_ROOT = Path("/home/ubuntu/.agentworks/data/vault/YOUR_TENANT_ID")
VAULT_ROOT.mkdir(parents=True, exist_ok=True)

# Example: structured memory records
records = [
    {"key": "company/overview", "body": "# Acme Corp\n\nWe sell widgets..."},
    {"key": "context/contacts/jane-doe", "body": "# Jane Doe\n\nVP of Sales..."},
    {"key": "projects/q1-launch", "body": "# Q1 Product Launch\n\n..."},
]

for rec in records:
    key = rec["key"].replace("/", os.sep)  # nested folders
    file_path = VAULT_ROOT / f"{key}.md"
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(rec["body"])
    print(f"Wrote: {key}")
```

Adjust the `records` structure to match however your source system stores memory.

#### From Claude Desktop memory or similar

If you have context files or memory prompts you paste into Claude, collect them into a directory first, then copy them as vault pages. Name pages after their subject matter.

### Seeding Conventions and Agent Instructions

The most valuable things to migrate into the vault are:

| Page key | What to put there |
|---|---|
| `company/overview.md` | Company name, industry, size, jurisdictions, products |
| `company/brand-voice.md` | How outbound messages should sound, what to avoid |
| `context/contacts/*.md` | Key people — customers, vendors, compliance contacts |
| `context/conventions.md` | How you want things done, approval thresholds, who decides |
| `context/compliance.md` | Regulatory requirements, attorney contacts, DNC list location |
| `projects/*.md` | Active workstreams with current status |

### Verifying the Migration

In Claude Desktop (connected to AgentWorks OS):

```
/memory read key=company/overview
```

You should see the content you wrote. If the vault was seeded from onboarding answers, you may see existing pages — merge by overwriting with your migrated content.

---

## Migrating Agent Configuration Files

Your existing agent configuration files (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`) encode institutional knowledge and behavioral instructions. These need to be preserved and connected to the scanner.

### CLAUDE.md and .cursorrules

1. Find your existing files:

```bash
find ~ -name "CLAUDE.md" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null
find ~ -name ".cursorrules" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null
```

2. Copy them to the AgentWorks config directory:

```bash
mkdir -p ~/.agentworks/config/claude
mkdir -p ~/.agentworks/config/cursor

cp ~/path/to/your/CLAUDE.md ~/.agentworks/config/claude/
cp ~/path/to/your/.cursorrules ~/.agentworks/config/cursor/
```

3. Register them with the scanner. Scheduled watch scans are disabled by
   default; add explicit container-visible watch paths to
   `~/.agentworks/config/.env`. The host config directory is mounted into the
   scanner container at `/config`, so use `/config/...` paths here, not
   `$HOME/.agentworks/config/...` host paths:

```bash
printf '\nSCANNER_WATCH_DIRS=%s\n' "/config/claude:/config/cursor" \
  >> ~/.agentworks/config/.env
agentworks restart scanner-worker
```

To confirm scanner submission works:

```bash
# Trigger a manual scan to see the watched paths
curl -X POST http://localhost:7710/api/scanner/submit \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "YOUR_TENANT_ID",
    "pasteContent": "# Contents of your CLAUDE.md file",
    "policyMode": "shadow"
  }'
```

4. The scanner will surface any security concerns (exposed secrets, excessive permissions, prompt injection risks) in the Admin UI under **Security → Scanner Findings**.

### AGENTS.md and Custom Instructions

If you have per-agent `AGENTS.md` files that encode your conventions and operational patterns:

1. Extract the conventions into `context/conventions.md` in the vault (see above)
2. Extract company facts into `company/overview.md`
3. Keep agent-specific behavioral instructions in the agent's own `AGENTS.md` — the scanner audits these automatically

---

## Migrating Rule Logic from Existing Systems

If your current agent setup has policy logic encoded as prompts, conditional checks, or external scripts, translate that logic into an AgentWorks OS rule pack.

### What Rule Packs Do

A rule pack evaluates every action against your compliance rules and returns `allow`, `block`, or `route_to_review`. Any logic that currently lives in a prompt ("don't send SMS before 8pm", "always verify consent before outreach") is a candidate for a rule pack.

### Translating Prompt-Based Rules

Example: your current CLAUDE.md says "Do not cold-call before 9am or after 6pm."

In a rule pack, this becomes:

```yaml
- rule_id: MY-001
  name: "Restrict calling hours"
  required_data:
    - call_scheduled_at
  disposition_when_missing: route_to_review
  conditions:
    - when:
        call_scheduled_at: "< 09:00"
      then:
        decision: block
        reason: "Cold calls before 9am are prohibited by company policy"
    - when:
        call_scheduled_at: "> 18:00"
      then:
        decision: block
        reason: "Cold calls after 6pm are prohibited by company policy"
```

### Translating External Script Checks

If you have a script that checks DNC lists, consent records, or other data before allowing an action, wire it into the rule pack's `required_data`:

1. Ensure your data source exposes a field the rule pack can reference
2. Declare that field in `required_data`
3. Write the condition that checks the value

For integration help, see [Rule Pack Authoring](./rule-pack-authoring.md).

---

## Migrating Historical Audit Data

AgentWorks OS stores activity records in an append-only, hash-chained log. If you have existing logs from a prior system, you can import them as reference material but they cannot be merged into the native audit chain (the hash chain is per-deployment).

**What to do with historical logs:**
- Keep them in their original system or export to a PDF/archive
- Reference them in the vault under `context/audit-history.md`
- Generate new AgentWorks OS activity from this point forward

To export existing logs for reference:

```bash
# Your existing audit data (format will vary by system)
# Convert to a vault page
cat /path/to/your/audit.log \
  | jq -r '.[] | {key: ("audit/" + .date), body: (. | tojson)}' \
  > /tmp/audit_import.json
```

Then write those entries to the vault as reference material.

---

## Post-Migration Checklist

After migration, verify each piece is working:

- [ ] Daemon health returns HTTP 200 at `http://localhost:7710/api/health`
- [ ] Claude Desktop connected — `/memory read` returns vault content
- [ ] Vault pages visible — key pages (company/overview, context/conventions) readable
- [ ] Scanner findings — no critical findings on migrated agent configs
- [ ] Test policy decision — submit a test action and confirm a decision is returned
- [ ] n8n connected — workflows visible at `http://localhost:5678`
- [ ] Vault conventions correct — agents referencing the right pages for operational guidance

---

## Common Problems After Migration

### Agent's MCP session has stale vault content

The MCP client may have cached the old empty vault. Have the agent run:

```
/memory refresh
```

Or restart the agent application.

### Migrated files not appearing in the admin UI

The vault is read from disk on each request. If you copied files directly:

```bash
curl -X POST http://localhost:7710/api/memory/reindex \
  -H "Content-Type: application/json" \
  -d '{ "tenantId": "YOUR_TENANT_ID" }'
```

### Scanner not picking up agent configs

Confirm watch paths are configured:

```bash
grep '^SCANNER_WATCH_DIRS=' ~/.agentworks/config/.env
agentworks logs scanner-worker
```

The scanner does not watch `/config/claude/` or `/config/cursor/` by default
in v0.1.9. Copy configs into your chosen host paths under
`~/.agentworks/config`, set `SCANNER_WATCH_DIRS` to the matching container
paths under `/config`, restart `scanner-worker`, then trigger a manual scan.

---

## Getting Help

If your migration hits a case not covered here:

1. Collect a support bundle: see [Support Bundle](./support-bundle.md)
2. Include your tenant ID and a description of what you migrated
3. Run the support bundle command and attach the output

The combination of your tenant ID and the support bundle is the fastest path to useful support.
