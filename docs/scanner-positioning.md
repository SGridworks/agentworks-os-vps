# Scanner Positioning Copy
## Artifact identifier: AWO-70

---

## Core Positioning

**Name:** Posture Review (not "continuous compliance")

The AgentGuard scanner embedded in AgentWorks OS reviews your agent configurations — CLAUDE.md files, .cursorrules, MCP server settings — and surfaces findings as Issues in your admin dashboard. It runs on a configurable schedule (default: nightly).

**What it does:** snapshots your agent security posture and flags known-bad patterns, configuration errors, and excessive agency grants.

**What it does not do:** provide real-time compliance monitoring, block actions at runtime, or replace a policy engine.

---

## Approved Positioning Language

### Product UI label
> Posture Review

### Tagline (admin dashboard)
> Periodic security posture review of your agent configurations.

### Finding type labels (admin UI)
- **Critical**: immediate review required — known exploitation path
- **High**: misconfiguration that may enable unintended agent behavior
- **Medium**: hardening opportunity
- **Low**: best-practice recommendation

### Finding card description template
> This [agent config / MCP setting / CLAUDE.md] has [N] finding[s]. [Top finding label]: [one-line description]. Last reviewed [timestamp].

---

## Language to Avoid

| Instead of | Use |
|---|---|
| "continuous compliance" | "posture review" |
| "real-time monitoring" | "scheduled review" or "nightly scan" |
| "compliance scanner" | "configuration security review" |
| "scans your agents" | "reviews your agent configurations" |
| "ensures compliance" | "surfaces configuration risks" |
| "detects violations" | "identifies known-bad patterns" |

---

## Customer-Facing Explanation

> AgentWorks includes a Posture Review scanner that periodically examines your agent configuration files — including CLAUDE.md, .cursorrules, and MCP server settings — and surfaces findings in your admin dashboard.
>
> Posture Review is not real-time monitoring. It runs on a schedule you configure and produces a snapshot of your agent configurations at scan time. It does not block, intercept, or log agent actions in real time.
>
> Think of it like a security audit: it tells you what it found when it looked. It does not watch your agents work.

---

## Internal Justification (for agent team)

The PLAN.md and Codex review established the framing early and it was held through review:

- "Posture review" is accurate: the scanner runs on a schedule, not continuously
- "Continuous compliance" overpromises: it implies real-time monitoring the product does not do
- Positioning it as a snapshot audit is both accurate and defensible
- It avoids the implication that having no findings means the system is "compliant" — a liability risk

This positioning was confirmed at CEO review (Plan section, Pillar 7): scanner is positioned as "posture review, not continuous compliance."
