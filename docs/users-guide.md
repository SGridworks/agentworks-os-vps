# AgentWorks OS User Guide

This guide is for the person who operates AgentWorks OS for a company. You install it, connect agents, approve sensitive actions, keep the vault useful, and produce evidence when someone asks what the agents did.

Use this guide after, or alongside, the [Install Runbook](./install-runbook.md). The runbook gets the system running. This guide explains how to use it well.

---

## 1. What AgentWorks OS Does

AgentWorks OS gives AI agents a controlled operating environment.

Agents can still write, research, update records, hand off tasks, and run workflows. The difference is that AgentWorks OS provides:

- A policy layer that checks proposed actions before they cross a boundary.
- A human approval queue for actions that should not be automatic.
- A vault that gives agents durable company memory.
- An orchestration surface for companies, agents, issues, runs, and handoffs.
- A scanner that audits agent configuration and unsafe permissions.
- A hash-chained system of record for policy decisions, approvals, vault writes, and operational events.
- Evidence reports for compliance and management review.

AgentWorks OS is not a replacement for legal counsel, compliance staff, or operator judgment. It gives you controls, records, and repeatable workflows so your agents are not operating as an unobserved black box.

---

## 2. Mental Model

Think of AgentWorks OS as five connected systems.

| System | What it controls | Where you use it |
|---|---|---|
| Vault | Shared memory and working knowledge | Memory Vault Viewer, MCP tools |
| Policy | Rule packs, shadow mode, enforcement, decisions | Rule Packs, Approvals, Activity Log |
| Orchestration | Companies, agents, issues, wakeups, runs, handoffs | Mission Control, Triage Queue, Process Health |
| Security | Agent config scanning and findings | Scanner, Settings |
| Evidence | Reports, exports, hash checks, retention | Evidence Report, Activity Log, backups |

The normal action path is:

1. An agent proposes an action, such as an outbound message, CRM write, data export, or workflow step.
2. AgentWorks OS normalizes that proposal into a standard action record.
3. Active rule packs evaluate the action.
4. The action is allowed, blocked, or routed to human review.
5. The decision is logged with evidence.
6. If approved, the action continues. If rejected or returned, the agent receives the outcome and revises or stops.

The normal work path is:

1. A task or issue is created.
2. AgentWorks OS assigns it to the right agent when the lane is clear.
3. Ambiguous work goes to the Triage Queue.
4. The assigned agent works, posts status, and records outputs.
5. Process Health watches for stale work, off-lane work, failed runs, and premature completion.
6. Important outcomes are written back to the vault.

---

## 3. What Is Included

### Memory Vault

The vault is a markdown-backed memory store. Agents use it to remember company facts, projects, contacts, policies, decisions, and current context across sessions.

Core capabilities:

- Read a vault page by key.
- Write or append to a vault page.
- Read the current hot context page.
- Search and visualize vault links in the Memory Vault Viewer.
- Preserve vault contents in backups.

### Rule Packs

Rule packs are YAML policy files. They declare what actions are allowed, blocked, or routed to review.

AgentWorks OS ships with starter packs, including:

- `smb-starter`
- `tcpa-real-estate`
- `fair-housing`
- `real-estate-tcpa-fair-housing`
- `hipaa-placeholder`

New rule packs should start in shadow mode. Shadow mode logs what would have happened without blocking or routing live work.

### Approval Queue

Approvals are for actions that need a human decision.

Approvers can:

- Approve the action.
- Reject the action.
- Return it to the author with a note.
- Review the rule, evidence snapshot, actor, tenant, and proposed action summary.

### Mission Control

Mission Control is the orchestration dashboard. It shows companies, agents, open issues, live runs, and operational status.

Use it to:

- See every company under a tenant.
- Open a company workspace.
- Inspect agents and their current state.
- Wake an agent on demand.
- View issue lanes.
- Watch recent runs.
- Edit agent metadata such as status, model, instructions path, capabilities, reporting line, and budget fields.

### Triage Queue

The Triage Queue holds unassigned or ambiguous issues. AgentWorks OS uses path and role matching when it can, but ambiguous work needs a human assignment.

Use it to:

- Review newly created work that could not be safely auto-assigned.
- See suggested roles and triage reason.
- Assign the issue to the correct agent.
- Keep work from drifting to whoever happens to be online.

### Process Health

Process Health watches whether agents are following the operating rules.

The seven checks are:

1. Stale in-progress work.
2. Premature done.
3. Off-lane commits or edits.
4. Auto-commit close mismatch.
5. Queue depth.
6. Failed run not retried.
7. Blocked ticket stuck.

Use Process Health as the weekly quality-control surface for agent operations.

### Scanner

The scanner audits agent configuration and pasted content for unsafe patterns.

It can surface:

- Excessive permissions.
- Exposed secrets.
- Prompt injection risks.
- Unsafe tool execution patterns.
- Data exfiltration risks.
- MCP configuration problems.
- SSRF and auth configuration concerns.

### Activity Log

The Activity Log is the operational record. It includes policy decisions, action records, approval outcomes, scanner events, and other auditable activity.

Use it when you need to answer:

- What did an agent try to do?
- What rule fired?
- Who approved or rejected it?
- What evidence was used?
- When did it happen?

### Evidence Reports

Evidence reports summarize policy and approval activity for a date range. Reports are persisted with hashes so later verification can detect mismatch.

Use them monthly or before a review with counsel, management, or a customer.

### Workflow Automation

AgentWorks OS includes workflow automation with AgentWorks-aware nodes:

- Policy Check
- Memory Read
- Memory Write
- Dispatch

Use workflows for repeatable operations such as lead intake, outbound review, compliance checks, enrichment, and agent handoffs.

---

## 4. Setup Guide

### Prerequisites

You need:

- A Mac or Linux machine you control.
- Docker Desktop or Docker Engine.
- 20 GB free disk, 4 GB RAM minimum, 8 GB recommended.
- Network access from the machines running your agents.
- At least one agent client to connect, such as Claude Desktop, Cursor, Codex, or a custom REST client.

Confirm Docker is running:

```bash
docker --version
docker ps
```

If `docker ps` cannot connect, start Docker before installing.

### Install

Run the installer on the machine that will host AgentWorks OS:

```bash
curl -fsSL https://github.com/SGridworks/agentworks-os-vps/releases/download/v0.1.9/install.sh | bash
```

The installer creates `~/.agentworks/`, generates secrets, starts services, and creates the first tenant.

### Verify Services

```bash
agentworks status
```

Expected services:

| Service | Purpose | Default port |
|---|---|---|
| `agentos-d` | Main daemon, REST API, MCP | 7710 |
| `scanner-worker` | Security scanner | 3101 |
| `n8n` | Workflow automation | 5678 |
| `admin-ui` | Browser operator dashboard | 3000 |
| `postgres` | Local execution database | internal only |

Check daemon health:

```bash
curl http://localhost:7710/api/health
```

### Admin UI Status

v0.1.9 starts the Admin UI from the default Docker Compose stack at
`http://localhost:3000`. On a VPS, keep it loopback-only and access it through
an SSH tunnel or authenticated TLS reverse proxy.

### Tenant Setup

The Admin UI includes an onboarding wizard. REST and MCP setup remain available
for headless installs and automation.

Set up:

- Company or tenant name.
- Optional description.
- Starting rule pack mode: blank, minimal, or standard.
- Which local editors or agent clients should receive an AgentWorks MCP entry.

The installer creates the first tenant and vault directory. You can create
additional tenants with `POST /api/tenants`.

### Connect Agents

AgentWorks OS exposes MCP tools and REST endpoints. Use MCP for interactive agent clients and REST for custom integrations.

#### Claude Desktop

Add an `agentworks` MCP server entry to the Claude Desktop config and restart Claude Desktop. See [MCP Integration](./mcp-integration.md) for the current config shape.

#### Cursor

Add the AgentWorks MCP server from Cursor's MCP settings, then restart Cursor.

#### Codex

Add an MCP server entry to the Codex configuration. If your local Codex supports an MCP add command, use the URL or stdio bridge shown by your install.

#### Custom REST Agents

Submit policy checks to:

```text
POST http://localhost:7710/api/policy/check
```

Submit action records to:

```text
POST http://localhost:7710/api/action
```

See [AWCP](./awcp.md) for the action schema and [Rule Pack Authoring](./rule-pack-authoring.md) for field names used by policy rules.

### First Verification

After install, verify four things:

1. The daemon health endpoint responds.
2. The admin UI loads.
3. At least one rule pack appears under Rule Packs.
4. A connected agent can read or write a test vault page.

Example policy check:

```bash
curl -X POST http://localhost:7710/api/policy/check \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "YOUR_TENANT_ID",
    "actionKind": "outbound.sms",
    "payload": { "to": "5550001234", "body": "test message" },
    "actorId": "quickstart-test",
    "actorLabel": "quickstart test",
    "actorType": "system",
    "summary": "users-guide policy check"
  }'
```

Expected result: a JSON response with a policy decision.

---

## 5. Admin UI Package Guide

This section applies to the default `admin-ui` service at
`http://localhost:3000`.

### Mission Control

Mission Control is the main operating view.

The top-level page shows:

- Companies.
- Active agents versus total agents.
- Open issues.
- Last poll time.
- Per-company tiles.

Open a company to see:

- Agent roster.
- Issue board.
- Live run feed.
- Agent detail panel.

For each agent, review:

- Name and role.
- Status: active, paused, retired, or error-like states if reported.
- Adapter type.
- Model.
- Instructions path.
- Capabilities.
- Heartbeat interval.
- Wake-on-demand setting.
- Reporting line.
- Monthly budget fields.
- Runtime state, wakeups, revisions, and task sessions.

Use **Wake** when an agent is idle but has work to pick up. Use pause or retired states when an agent should not receive work.

### Memory Vault Viewer

The Memory Vault Viewer shows vault structure and relationships.

It has two useful modes:

- Orchestration view: companies, agents, and issues.
- Vault view: markdown pages and links.

Use search and local focus to inspect a specific company, agent, project, or note cluster.

### Approvals

Approvals is the review queue for policy decisions that returned `route_to_review`.

Use the filters:

- Pending.
- Reviewed.
- All.

When reviewing an item, check:

- Actor label.
- Proposed action kind.
- Proposed action summary.
- Decision reason.
- Evidence snapshot.
- Age of the item.
- Tenant.

Then choose:

- Approve if the action is acceptable.
- Reject if the action should not happen.
- Return to author if the agent should revise and resubmit.

Write a useful note. Short notes such as "ok" do not help future review.

### Triage Queue

Use the Triage Queue for unassigned work.

Each row shows:

- Ticket title.
- Identifier.
- Priority.
- Created age.
- Triage reason.
- Suggested roles.
- Agent assignment dropdown.

Assign ambiguous tickets daily. A large triage queue usually means tickets are missing file paths, role hints, or enough detail for auto-assignment.

### Rule Packs

Rule Packs shows installed policy packs.

For each pack, review:

- Name and version.
- Tier.
- Shadow or enforcing mode.
- Edit link.
- Upload action.

Operational rules:

- New packs start in shadow.
- Keep packs in shadow for at least one day under realistic traffic.
- Promote to enforcement only after reviewing shadow decisions.
- If a pack over-fires, return it to shadow and adjust rules.
- Keep rule pack YAML in source control outside AgentWorks OS.

### Scanner

The scanner page lists findings from agent configuration audits.

For each finding, decide:

- Fix it.
- Suppress it with a reason if it is intentional.
- Leave it open only if it is low risk and scheduled for later.

High and critical findings should be handled within seven days. Do not suppress a finding without a written reason.

### Process Health

Process Health is where you look for agent discipline problems.

Review it weekly, and during active delivery daily.

Watch for:

- Agents with repeated stale in-progress work.
- Agents closing work without evidence.
- Repeated off-lane edits.
- Too many open issues assigned to one agent.
- Failed runs that were never retried.
- Blocked work without escalation.

Use Process Health findings to tune lanes, split overloaded agents, improve instructions, or change the issue design.

### Activity Log

Use Activity Log for investigations.

Filter by:

- Tenant.
- Agent or actor.
- Action kind.
- Decision.
- Date range.

Export the log when you need an external review artifact. Do not manually edit underlying activity records.

### Evidence Report

Use Evidence Report to generate and verify reports for a period.

Normal monthly procedure:

1. Enter tenant ID.
2. Generate a report for the month.
3. Verify the report hash.
4. Save the report with other company compliance artifacts.
5. Review unusual blocks, overrides, and suppressions.

Evidence reports prove system state and decision history. They do not prove legal compliance by themselves.

### Settings

Use Settings for installation-level details and basic preferences.

Depending on your version, Settings may show:

- Theme.
- Cost controls status.
- Daemon name and port.
- Vault path.
- Tenant information.
- Integrations.
- Scanner watched paths.
- Backup and retention configuration.

If Settings shows a different daemon port than this guide, use the port shown in your live install.

---

## 6. Vault Guide

### What the Vault Is For

The vault is working memory for agents. It should contain facts and current context that an agent needs to act correctly.

Good vault content:

- Company overview.
- Brand voice.
- Jurisdictions and markets.
- Compliance policies.
- Approval rules.
- Current projects.
- Contacts and responsibilities.
- Active campaigns.
- Decisions and rationale.
- Session handoffs.

Bad vault content:

- API keys or passwords.
- Large unprocessed dumps.
- Old campaign data that is no longer valid.
- Contradictory duplicate pages.
- Private data that every connected agent should not see.

### Recommended Structure

Start simple:

```text
company/
  overview.md
  brand-voice.md
  jurisdictions.md
context/
  conventions.md
  compliance.md
  approvals.md
contacts/
  compliance-counsel.md
  key-vendors.md
projects/
  active/
    q2-outreach.md
  archived/
decisions/
  2026-05.md
agents/
  operating-rules.md
hot.md
```

### The Hot Page

`hot.md` is the short context page agents should read first. Keep it concise.

Include:

- Current priorities.
- Active constraints.
- Recently changed decisions.
- Links to active project pages.
- Anything that would prevent a repeated mistake.

Do not put the entire vault in `hot.md`. It is a map, not the archive.

### Naming Conventions

Use lowercase kebab-case:

```text
projects/active/customer-onboarding.md
context/approval-policy.md
contacts/outside-counsel.md
```

Avoid:

- Spaces.
- Date-only filenames unless the page is a log.
- Vague names such as `notes.md`, `misc.md`, or `important.md`.

### Writing Vault Pages

Write for a new agent with no background.

Use:

- Direct statements.
- Current tense where possible.
- Clear owners and dates.
- Links to related pages.
- Short sections.

Avoid:

- "As discussed."
- Unexplained acronyms.
- Long pasted transcripts without summary.
- Multiple unrelated topics on one page.

### Append vs Replace

Use append mode for logs, session notes, and chronological updates.

Use replace mode for canonical facts, such as:

- Company overview.
- Approval policy.
- Brand voice.
- Current project status.

If replacing a page, preserve important history by moving old material to an archive or decision log first.

### Vault Hygiene Routine

Daily:

- Add a short session handoff after meaningful work.
- Update active project pages when status changes.
- Remove or correct facts an agent got wrong.

Weekly:

- Review `hot.md`.
- Close stale project pages.
- Check that major decisions have a decision page or dated note.
- Check that open issues link to the right project pages.

Monthly:

- Archive completed project pages.
- Remove obsolete campaign instructions.
- Review contacts and approvers.
- Search for "TODO", "old", "maybe", and "TBD".
- Confirm no secrets were written into the vault.

Quarterly:

- Test backup restore.
- Review vault size and page count.
- Merge duplicate pages.
- Refresh compliance and approval pages with counsel or the responsible operator.

### Vault Quality Checklist

A healthy vault:

- Has fewer than a few hundred active pages for a typical small business.
- Has one clear page per important concept.
- Has a maintained `hot.md`.
- Links related pages.
- Does not contain secrets.
- Distinguishes current policy from historical notes.
- Is included in backup and restore tests.

---

## 7. Rule Pack Operations

### Load a Pack

In the admin UI:

1. Open Rule Packs.
2. Click Upload pack.
3. Select a `.yaml` or `.yml` file.
4. Confirm it appears in the list.
5. Keep it in shadow until reviewed.

Validate the pack with the policy-engine package tests (offline):

```bash
pnpm --filter @agentworks/policy-engine test -- /path/to/pack.yaml
```

Or dry-run against the live daemon:

```bash
curl -s -X POST http://localhost:7710/api/policy/check \
  -H 'content-type: application/json' \
  -d @/path/to/test-fixture.json
```

### Understand Decisions

Policy outcomes:

| Decision | Meaning | Operator action |
|---|---|---|
| `allow` | No active rule blocked or routed the action | No action needed |
| `block` | A rule stopped the action | Review if surprising |
| `route_to_review` | A human must decide | Review in Approvals |

When packs disagree, blocking is safest. Design rule packs so the reason and citation are clear enough for an approver to understand quickly.

### Shadow Mode

Shadow mode evaluates and logs rules without enforcement.

Use shadow mode for:

- New packs.
- Packs changed after false positives.
- Packs added for a new business line.
- Advisory policy tests.

Review shadow decisions before enforcing. If the pack would have blocked normal work, tune it before flipping.

### Rule Pack Maintenance

For each production pack, maintain:

- Pack file in source control.
- Version number.
- Test fixtures.
- Citation fields for regulatory rules.
- Owner.
- Last review date.
- Mode history.

Never edit a production rule pack without leaving a trace in source control or a decision note.

---

## 8. Approval Operations

### What Requires Human Review

Human review is appropriate for:

- Legal or compliance uncertainty.
- Missing required data.
- First contact with a customer or lead.
- Sensitive wording.
- Bulk outbound.
- Data export.
- Unusual agent behavior.
- Any action a rule pack is intentionally routing.

### Review Procedure

For each approval:

1. Read the proposed action summary.
2. Inspect the evidence snapshot.
3. Confirm the actor and tenant.
4. Read the rule reason.
5. Decide approve, reject, or return.
6. Leave a note that explains the decision.

Good approval note:

```text
Approved because written consent is present in CRM record 4821 and the message uses the approved Q2 template.
```

Bad approval note:

```text
ok
```

### Queue Hygiene

Daily:

- Clear new approvals.
- Return unclear items instead of leaving them pending.
- Reject stale or unsafe actions.

Weekly:

- Look for repeated review reasons.
- Tune over-firing rules.
- Add missing data sources.
- Confirm fallback approvers are still correct.

Keep the pending queue small. A large queue turns approvals into rubber-stamping.

---

## 9. Agent Orchestration Guide

Agent orchestration is the discipline of assigning work to the right agent, keeping that agent in its lane, preserving context, and checking the output before the work is treated as done.

### Core Objects

| Object | Meaning |
|---|---|
| Tenant | The customer or organization whose rules and vault apply |
| Company | A company workspace under the tenant |
| Agent | A configured worker with role, model, adapter, instructions, and status |
| Issue | A unit of work |
| Run | A concrete execution attempt by an agent |
| Wakeup | A request to nudge an agent to work |
| Task session | A tracked working session for an agent and task |
| Comment | A work note, blocker, handoff, or completion record |

### Agent Configuration Fields

Review these fields for every agent:

| Field | How to use it |
|---|---|
| Name | Human-readable label |
| Role | Routing and responsibility hint |
| Status | Active agents receive work; paused and retired agents should not |
| Adapter type | How AgentWorks OS reaches the agent |
| Model | The model or model profile the agent uses |
| Instructions path | The agent's operating instructions |
| Capabilities | Plain-language scope of what the agent can do |
| Heartbeat interval | How often the agent should check in |
| Wake on demand | Whether the operator can wake it manually |
| Reports to | Manager or parent agent for escalation |
| Budget fields | Monthly spend limits and tracking when enabled |

### Issue Lifecycle

Use this lifecycle consistently:

1. `triage`: needs assignment or clarification.
2. `inbox`: assigned but not started.
3. `in_progress`: actively being worked.
4. `blocked`: waiting on external input or dependency.
5. `done`: agent believes work is complete.
6. `closed`: operator or reviewer accepted completion.

Do not let agents skip evidence. A done issue should include what changed, where it changed, how it was verified, and what remains.

### Creating Good Issues

A good issue includes:

- Goal.
- Context.
- Expected output.
- Relevant files, systems, or vault pages.
- Acceptance criteria.
- Verification command or manual check.
- Constraints.
- Owner or suggested role if known.

Weak issue:

```text
Fix docs.
```

Good issue:

```text
Expand docs/users-guide.md to cover setup, daily operation, vault hygiene, and agent orchestration. Keep customer-facing vocabulary. Verify no internal substrate names appear. Acceptance: guide includes setup, UI tour, vault routine, rule pack workflow, approvals, orchestration, maintenance, and troubleshooting.
```

### Auto-Assignment

AgentWorks OS can assign issues automatically when the issue description clearly points to one role or lane.

Auto-assignment works best when the issue includes:

- File paths.
- Feature names.
- Explicit role hints.
- Clear acceptance criteria.

If multiple roles match equally, or no role matches, the issue goes to Triage Queue.

### Triage Assignment

When assigning from Triage Queue:

1. Read the triage reason.
2. Check suggested roles.
3. Open the issue if the title is ambiguous.
4. Pick the agent whose capability matches the work.
5. If no agent fits, revise the issue or create a new agent before assignment.

Do not assign ambiguous work just to empty the queue. Bad assignment creates rework.

### Waking Agents

Wake an agent when:

- It has assigned work but no recent run.
- You changed its instructions or model and want a new pass.
- You returned an approval item and need revision.
- You unblocked a blocked issue.

Avoid repeated wakeups without changing context. If an agent does not respond, inspect runtime state and logs instead of waking it repeatedly.

### Handoffs Between Agents

Good handoffs include:

- Summary of completed work.
- Links to changed files or vault pages.
- Remaining task.
- Known risks.
- Verification already performed.
- Exact next question for the receiving agent.

Use the Dispatch workflow node or the execution API when a workflow should hand off to a specific agent. Use issue comments and vault pages for durable context.

### Manager Pattern

For complex work, use a manager pattern:

1. One coordinating agent or operator owns decomposition.
2. Specialist agents own bounded tasks.
3. Each specialist writes results to the issue and relevant vault page.
4. The coordinator reviews, integrates, and closes.

Good manager behavior:

- Splits tasks by ownership boundary.
- Avoids duplicate assignments.
- Waits for necessary blockers only.
- Keeps a status digest.
- Escalates unclear or risky decisions.

Bad manager behavior:

- Assigns the same work to multiple agents without a review purpose.
- Lets agents edit outside their lane.
- Marks work done without verification.
- Lets blocked issues sit without next action.

### Parallel Work

Parallelize only when tasks are independent.

Good parallel splits:

- Backend API implementation and frontend UI implementation with clear contract.
- Documentation expansion and screenshot capture.
- Rule pack authoring and fixture writing.
- Scanner test additions and UI copy review.

Avoid parallel work when:

- Multiple agents need to edit the same file.
- The interface is not agreed.
- One task depends on the other's output.
- The task is exploratory and needs a single coherent decision.

### Review Cycle

For high-risk work, use a review cycle:

1. Implementer completes task with evidence.
2. Reviewer checks against acceptance criteria.
3. Implementer fixes findings.
4. Operator or coordinator closes the issue.

For compliance and outbound automation, keep human review in the loop until the rule pack has proven itself in shadow and enforcement.

### Process Health Response

When Process Health flags an agent:

| Flag | Operator response |
|---|---|
| Stale in-progress | Wake once, then reassign or pause if no response |
| Premature done | Reopen and require evidence |
| Off-lane work | Stop the agent, correct instructions, review changes |
| Queue depth | Move lower-priority work or add capacity |
| Failed run not retried | Retry with clearer context or inspect logs |
| Blocked stuck | Ask for the blocker owner and next action |

### Orchestration Hygiene

Daily:

- Clear Triage Queue.
- Check blocked and stale issues.
- Review approvals.
- Wake agents only when context changed.

Weekly:

- Review Process Health.
- Check overloaded agents.
- Update lane rules.
- Archive closed work.
- Review vault handoffs.

Monthly:

- Review agent roster.
- Retire unused agents.
- Confirm instructions paths still exist.
- Review model assignments and budget fields.
- Generate evidence report.

---

## 10. MCP and API Tools

Connected MCP clients can use these tools:

| Tool | Purpose |
|---|---|
| `memory.read` | Read a vault page |
| `memory.write` | Replace or append a vault page |
| `memory.hot` | Read the curated hot context page |
| `policy.check` | Evaluate a proposed action |
| `activity.log` | Add an audit log entry |

Typical agent startup pattern:

1. Call `memory.hot`.
2. Read any referenced project or policy pages.
3. Work on the assigned task.
4. Submit risky actions through `policy.check`.
5. Write durable conclusions back with `memory.write`.
6. Log important external actions with `activity.log`.

REST integrations should use the documented API routes rather than writing directly to data files.

---

## 11. Workflow Automation

Open workflow automation at:

```text
http://localhost:5678
```

Use workflows when a process is repeatable:

- Lead intake.
- Consent checks.
- Outbound review.
- CRM enrichment.
- Document intake.
- Customer support routing.
- Agent handoff.

Recommended workflow pattern:

1. Trigger receives new data.
2. Normalize data into an action record.
3. Run Policy Check.
4. If allowed, continue.
5. If blocked, stop and log.
6. If review is required, wait for approval.
7. Write useful context to the vault.
8. Dispatch to an agent only after policy passes.

Keep workflow credentials in the workflow tool's credential store, not in the vault.

---

## 12. Routine Maintenance

### Daily

- Check Approvals.
- Check Triage Queue.
- Review critical scanner findings.
- Confirm Mission Control has no unexpected offline agents.
- Update active project vault pages after meaningful decisions.

### Weekly

- Review Process Health.
- Review blocked and stale issues.
- Check rule pack shadow decisions.
- Tune rules that over-fire.
- Confirm scanner watched paths are current.
- Review `hot.md`.

### Monthly

- Generate evidence report.
- Review Activity Log for unusual blocks and overrides.
- Update AgentWorks OS if needed.
- Archive completed vault project pages.
- Review approvers and fallback owners.
- Confirm backups are running.

### Quarterly

- Test restore from backup.
- Review vault structure and stale pages.
- Review agent roster and model assignments.
- Review rule pack source control history.
- Review scanner suppressions.

---

## 13. Backup and Restore

Back up before:

- Updating AgentWorks OS.
- Changing rule pack configuration.
- Running onboarding again.
- Large vault imports.
- Major agent roster changes.

Create a backup:

```bash
agentworks backup /path/to/backup.tar.gz
```

Restore from backup:

```bash
agentworks restore /path/to/backup.tar.gz
```

Restore replaces the current vault and database with the backup contents. Treat restore as a destructive operation and confirm you have the right archive.

Store at least one recent backup off the AgentWorks OS host.

Test restore quarterly. A backup you have never restored is only a hope.

---

## 14. Updates

Check version:

```bash
agentworks --help | head -1   # the wrapper prints "AgentWorks OS CLI — <version>"
```

Check for updates:

```bash
agentworks update --check
```

Apply an update:

```bash
agentworks update
```

Pre-update checklist:

1. Create a backup.
2. Check available disk space.
3. Read release notes.
4. Confirm no critical approvals are waiting.
5. Notify operators if there will be downtime.

If an update fails, collect logs before making manual changes:

```bash
agentworks logs agentos-d
```

Do not manually edit the database to work around a failed migration.

---

## 15. Storage and Retention

The main growing data stores are:

- Vault pages.
- Activity log.
- Policy decision history.
- Evidence reports.
- Scanner findings.
- Workflow execution history.

Monitor disk usage:

```bash
df -h
du -sh ~/.agentworks
```

Retention guidance:

- Keep activity records long enough to support your compliance and customer obligations.
- Archive vault pages rather than deleting current project history.
- Keep evidence reports outside the live host when they are part of official records.
- Prune workflow execution history according to business need.

Never manually delete activity log rows to save space. Use supported retention features when available.

---

## 16. Security Practices

### Secrets

Do not put secrets in:

- Vault pages.
- Issue descriptions.
- Approval notes.
- Rule pack YAML.
- Agent instructions.

Use secret storage for credentials and API tokens.

### Local Exposure

AgentWorks OS is designed for local or controlled-network deployment. Do not expose the daemon or workflow automation ports to the public internet without authentication, TLS, and a reviewed network configuration.

### Scanner Findings

Treat scanner findings as work, not noise.

High and critical findings should either be fixed or have a documented suppression. Suppression without a reason is a future audit problem.

### Agent Permissions

Give agents only the access they need.

Review:

- Filesystem access.
- Shell permissions.
- MCP servers.
- Workflow credentials.
- External API credentials.
- Write access to shared repositories.

---

## 17. Troubleshooting

| Symptom | First check |
|---|---|
| Admin UI will not load | Check `docker compose ps admin-ui`, then `docker compose logs admin-ui --tail 100` |
| Daemon is down | `agentworks status` |
| Agent cannot read vault | Confirm MCP config, restart agent client, test `memory.hot` |
| Policy checks all allow | Confirm rule packs are assigned and enforcing |
| Too many approvals | Review shadow/enforcement mode and missing-data rules |
| Approval item is stale | Return to author or reject with note |
| Triage queue grows | Improve issue descriptions and lane hints |
| Scanner has no findings | Confirm watched paths and scanner health |
| Evidence report missing entries | Check date range and retention |
| Vault edits are not visible | Refresh agent memory or restart the client |
| Disk filling up | Check vault, activity, evidence reports, and workflow history |

Useful commands:

```bash
agentworks status
agentworks logs
agentworks logs agentos-d
agentworks status
agentworks logs scanner-worker
curl http://localhost:7710/api/health
```

For support, generate a support bundle and include tenant ID, time window, and what you expected to happen.

---

## 18. Operating Principles

1. Keep the vault current and small enough to be useful.
2. Put new rule packs in shadow before enforcement.
3. Require evidence before closing work.
4. Clear approvals and triage daily.
5. Treat scanner findings as operational work.
6. Back up before changes and test restore quarterly.
7. Do not expose local services casually.
8. Prefer narrow, well-described issues over broad requests.
9. Use agent orchestration for bounded handoffs, not vague delegation.
10. Generate evidence reports on a schedule, not only after a problem.

---

## 19. Where to Go Next

- [Quickstart](./quickstart.md)
- [Install Runbook](./install-runbook.md)
- [MCP Integration](./mcp-integration.md)
- [Rule Pack Authoring](./rule-pack-authoring.md)
- [AWCP](./awcp.md)
- [Backup and Restore](./backup-restore.md)
- [Update Procedure](./update-procedure.md)
- [Best Practices](./best-practices.md)
- [Error Messages](./error-messages.md)
- [Support Bundle](./support-bundle.md)
- [Disclaimer](./disclaimer-text.md)
