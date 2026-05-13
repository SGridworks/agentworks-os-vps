# AgentWorks OS

The AI compliance firewall for regulated small businesses.

## What it does

Agents (Claude Desktop, Cursor, Codex, ChatGPT via browser extension in v2) connect to AgentWorks OS over a local API. Every action the agent takes passes through a policy engine that checks it against rule packs you configure. Violations are either blocked with a plain‑English explanation or routed to a human approval queue.

The substrate also gives agents persistent memory of your business, a durable system of record for their outputs, and an embedded security scanner that audits agent configurations nightly.

## Who it's for

Regulated SMBs running AI lead‑gen, outreach, or workflow automation—real‑estate brokerages, health‑adjacent services, insurance agencies, financial advisors. Teams where the user of AI isn’t the same person who set it up.

If your lawyer has ever asked “who approved that outbound?” or “how do we prove that message was TCPA‑compliant?”, this is the substrate that lets you answer.

## Quick install

Requires Docker Desktop (macOS) or Docker Engine (Linux), git, ~10 GB free disk, and ~4 GB RAM. About 10‑20 minutes on a clean machine, mostly the first build.

**One-liner (recommended):**

```bash
curl -fsSL https://github.com/SGridworks/agentworks-os-vps/releases/download/v0.1.9/install.sh | bash
```

Add `-s -- --unattended` to skip the confirmation prompt:

```bash
curl -fsSL https://github.com/SGridworks/agentworks-os-vps/releases/download/v0.1.9/install.sh | bash -s -- --unattended
```

**From source clone (equivalent):**

```bash
git clone --depth=1 --branch v0.1.9 https://github.com/SGridworks/agentworks-os-vps.git
cd agentworks-os-vps
./apps/installer/src/install.sh --unattended \
  && ./apps/installer/scripts/smoke-test.sh
```

If both scripts exit 0 — done. The installer prints `Smoke test PASSED` at the end; the standalone smoke run is a second gate that POSTs a tenant and a `policy.check` end‑to‑end.

**Admin dashboard included.** Default install starts the daemon, scanner, n8n, Postgres, and the browser dashboard at `http://localhost:3000`. All host ports are loopback-bound by default; on a VPS, use an SSH tunnel or authenticated TLS reverse proxy instead of opening service ports directly.

**Clean VPS install.** For a public VPS, do not copy a workstation clone or local data directory. Build and transfer a sanitized source archive, then run the installer on the VPS so secrets, database files, and vault content are generated there. See [VPS blank-slate install](./docs/vps-blank-slate-install.md).

**Installing through an AI coding agent?** Point Claude Code (or Codex, or Cursor) at this repo and tell it to follow [`docs/AI-AGENT-INSTALL-GUIDE.md`](./docs/AI-AGENT-INSTALL-GUIDE.md). The guide is written for an LLM: numbered steps, explicit verify commands, enumerated failure modes with fixes, and a final report template. Pre‑flight in `install.sh` catches the things an agent can’t reason about (port conflicts, disk pressure, no internet, Docker daemon down) before wasting 10 minutes on a build.

Other agent‑readable runbooks:

- [Install Guide](./docs/AI-AGENT-INSTALL-GUIDE.md) — the canonical install playbook above
- [Rule‑Pack Authoring](./docs/AI-AGENT-RULE-PACK-GUIDE.md) — draft, validate, ship a rule pack safely
- [Operator Runbook](./docs/AI-AGENT-OPERATOR-RUNBOOK.md) — daily ops, triage, incident response
- [MCP Debug](./docs/AI-AGENT-MCP-DEBUG.md) — five‑layer diagnosis when MCP isn’t connecting
- [Vault Hygiene](./docs/AI-AGENT-VAULT-HYGIENE.md) — lint, dedupe, prune the vault

For a human‑oriented walk‑through: [docs/install-runbook.md](./docs/install-runbook.md).

## What’s in the box

| Pillar | What it does |
|---|---|
| Memory | Persistent vault that agents read and write. Survives restarts. Seeds from your onboarding answers. |
| Orchestration | Cross‑agent task coordination. One agent can hand off to another with full context. |
| System of record | Append‑only audit log of every action: who did what, when, and the policy decision. |
| Compliance engine | YAML rule packs with allow / block / route‑to‑review outcomes. Ships with TCPA and fair‑housing packs for real estate. |
| Human approval queue | Rule packs can return “route to review.” Approvers can inspect queued actions through the API and, when enabled, the admin UI. |
| Workflow automation | Bundled n8n with substrate‑aware nodes (memory read/write, policy check, dispatch). |
| Security scanner | AgentGuard scanner runs nightly on your agent configs (CLAUDE.md, .cursorrules, MCP configs). Findings surface as Issues. |
| Compliance evidence report | Monthly PDF summarizing policy decisions, approval‑queue activity, and scanner findings. Signed and hash‑chained. |

## What’s NOT in v1

- Cost metering and per‑agent LLM spend attribution (v1.1)
- Per‑employee SSO (Google Workspace, Entra) (v1.2)
- Browser extension for ChatGPT/Manus (v2)
- Hosted/cloud deployment (local‑only in v1)
- MCP‑first rule‑pack preview (CLI dry‑run is v1 fallback)

See [CHANGELOG.md](./CHANGELOG.md) for full release notes and known issues.

## Architecture

Single daemon (`agentos-d`) with three connection surfaces:
- **REST API** — custom agents and internal tooling
- **MCP server** — Claude Desktop, Cursor, Codex
- **WebSocket** — admin UI, n8n custom nodes

Python `scanner‑worker` as a sidecar. n8n as a sidecar. All data stays on your hardware.

## License

Apache 2.0. See [LICENSE](./LICENSE).

## Getting started

1. [Install](./docs/install-runbook.md)
2. Verify the daemon with `curl http://localhost:7710/api/health`
3. Connect your agents via MCP
4. Load a rule pack or write your own (see [rule‑pack authoring](./docs/rule-pack-authoring.md))
5. Test a policy decision: try to send an outbound SMS to a number in your DNC list and confirm it routes to review.

## Docs

- [Install runbook](./docs/install-runbook.md)
- [VPS blank-slate install](./docs/vps-blank-slate-install.md)
- [E2E verification](./docs/e2e-verification.md)
- [Rule‑pack authoring guide](./docs/rule-pack-authoring.md)
- [AWCP v0.1 spec](./docs/awcp.md) — draft spec for the wire format, API surface, and data model
- [Support bundle how‑to](./docs/support-bundle.md)
- [Backup and restore](./docs/backup-restore.md)
- [Update procedure](./docs/update-procedure.md)
