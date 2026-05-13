# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Email `security@sgridworks.com` with:

- A description of the issue and its impact
- Steps to reproduce, or a proof-of-concept
- The version (or git commit hash) you tested against

We will acknowledge receipt within 3 business days and aim to provide an
initial assessment within 7 business days.

## Supported versions

| Version | Supported           |
|---------|---------------------|
| 0.1.x   | Yes (current)       |
| < 0.1   | No (pre-release)    |

We will issue patch releases for security fixes against the current minor
version. Older minors are not back-ported.

## Scope

In scope for v0.1.x:

- **Policy-engine bypass.** Any agent action that should have been blocked
  or routed to review reaching execution unchallenged.
- **Audit-log tampering.** Any path that mutates `policy_decisions` or
  `action_log` outside the documented append-only hash-chained API.
- **Scanner false-negatives** of known-bad patterns the scanner is
  documented to detect.
- **Authentication / authorization** vulnerabilities in the daemon's REST
  and MCP surfaces, including tenant boundary violations.
- **Injection / RCE / SSRF** in any code path reachable from a customer's
  agent, configured rule pack, or admin UI session.
- **Secret exposure** in logs, support bundles, evidence reports, or HTTP
  responses.

## VPS hardening baseline

The default v0.1.x stack binds fixed host ports:

| Port | Service | Exposure guidance |
|---|---|---|
| `7710` | AgentWorks API / MCP | Loopback-bound by default; use an SSH tunnel, VPN, or authenticated reverse proxy. |
| `3101` | scanner-worker | Loopback-bound by default; keep private to the host or trusted admin network. |
| `5678` | n8n | Loopback-bound by default; use an SSH tunnel for admin access. |
| `3000` | Admin UI | Loopback-bound by default; protect with authenticated TLS before exposing. |

Do not expose `7710`, `3101`, or `5678` directly to the public internet on a clean VPS. Store `~/.agentworks/config/.env`, `~/.agentworks/config/secrets.json`, and backup archives as secrets.

Out of scope for v0.1.x (these are tracked as feature work, not security):

- Per-employee SSO / federated auth (planned for v1.2)
- Hosted/cloud deployment hardening (local-only in v1)
- Cost-meter accuracy or per-agent attribution (planned for v1.1)
- Browser-extension surface (planned for v2)

## Disclosure

Once a fix is available, we will:

1. Publish a patch release
2. Tag a CVE if appropriate
3. Credit the reporter (unless anonymity is requested)
4. Document the issue in [CHANGELOG.md](./CHANGELOG.md)

We follow a coordinated-disclosure model: please give us a reasonable
window (typically 90 days) before disclosing publicly.
