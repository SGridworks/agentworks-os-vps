# Best Practices

Operational patterns for a healthy, auditable, low-friction AgentWorks OS deployment. These are not required — the system works without them — but they reduce incidents, keep compliance evidence clean, and make the system easier to operate over time.

---

## Vault Hygiene

The vault is the shared memory your agents use to understand your business. Treat it like a shared wiki, not a dump.

### Keep Pages Focused and Independent

One concept per page. A page called `outbound-messaging-rules` that covers SMS, email, and carrier pigeons will confuse agents and makes targeted updates painful.

Good structure:

```
company/
  overview.md         — one paragraph on what you do and who you are
  brand-voice.md      — tone, style, what not to say
  jurisdictions.md     — states/markets you operate in
context/
  conventions.md       — how work gets approved, who decides what
  compliance.md       — regulatory obligations, attorney contacts, DNC list location
  contacts/
    attorney.md        — compliance counsel, name/email/phone
    compliance-officer.md
contacts/
  key-customers.md    — people agents need to know by name
projects/
  active/
    q2-outreach.md    — current campaign, status, approvers
```

### Link Between Pages

Use markdown links. Agents follow them. If `context/compliance.md` mentions rule packs, link to the relevant guide:

```markdown
See [Rule Pack Authoring](./rule-pack-authoring.md) for the current rule schema.
```

### Trim Stale Content

Review the vault quarterly. Archive pages for completed projects. Delete pages for defunct campaigns. An agent reading stale content will act on it.

A good vault at rest is under 200 pages for a typical SMB. If you're over 500, it's time to audit.

### Write for an Agent Audience

Write to the person who has no context. "We" is fine — "the company" is not. Assume the reader is a new employee on their first day.

**Bad:**
> As discussed, per the Board's directive from Q1, we are focusing on the mid-market segment.

**Good:**
> We sell to mid-market B2B companies (50-500 employees). Focus on manufacturing and logistics verticals.

### Never Put Secrets in the Vault

The vault is not encrypted at rest in v1. API keys, credentials, and tokens go in **Settings → Integrations → Secret Store** — that store is encrypted.

### Back Up the Vault

The vault is a directory of markdown files. It is included in the standard AgentWorks OS backup. If you maintain separate backups, include:

```
~/.agentworks/data/vault/{tenant_id}/
```

Test a restore once a quarter.

---

## Rule Pack Design

### Start with Shadow Mode

Every new rule pack should run in **shadow mode** for at least 24 hours before going live. Shadow mode logs what the pack *would* have done without acting on it. Watch the shadow decisions in the admin UI before turning enforcement on.

This is how you catch false positives before they block real work.

### Write Rules for the Decision You Want, Not the Data You Have

A rule that requires `consent.source == "written"` will `route_to_review` every outreach where `consent.source` is absent or `null`. Set `disposition_when_missing` explicitly — don't leave it to the policy engine to guess.

### Use `required_data` Guards for Optional Fields

If a rule checks `contact_age < 18`, but `contact_age` might be absent, guard it:

```yaml
conditions:
  - when:
      contact_age_known: true    # guard — only evaluate if we know the age
      contact_age: "< 18"
    then:
      decision: block
```

Without the guard, the rule fires as `route_to_review` (via `disposition_when_missing`) when the age is unknown — which is probably not what you want.

### Priority Order Matters

Rules evaluate in priority order (lowest number first). The first `block` or `route_to_review` terminates evaluation for that pack. Design your priority sequence intentionally.

For a typical SMB:

```
priority: 1    — hard blocks (DNC, explicit consent required)
priority: 10   — conditional blocks (time restrictions, jurisdiction limits)
priority: 50   — review triggers (unusual volume, flagged terms)
priority: 100  — informational logging (default)
```

### One Rule, One Concern

A rule that checks DNC *and* calling hours *and* consent status is three rules. Keep them separate. It makes shadow-mode log output readable and makes it possible to disable one concern without losing the others.

### Document Your Citations

Every `block` rule should have a `citation` field. "Internal policy" is fine for operational rules. For regulatory rules, cite the actual law or regulation.

```yaml
then:
  decision: block
  reason: "No TCPA consent on file for this number"
  citation: "47 U.S.C. § 227(b)"
```

This is what your compliance evidence report will show auditors.

### Test Fixtures Are Not Optional

Every rule pack you write should have test fixtures covering:
- One `allow` case
- One `block` case
- One `route_to_review` case
- One case where required data is missing

Run fixtures before activating a pack:

```bash
curl -X POST http://localhost:7710/api/policy/check -H content-type:application/json -d @fixture.json
```

---

## Agent Onboarding

### Set Up Each Agent's MCP Connection Individually

Don't assume one agent config works for all. Each agent (Claude Desktop, Cursor, Codex) has its own MCP config location and restart procedure.

After connecting an agent, verify:
1. `/memory read` returns vault content
2. `/memory write` persists to the vault
3. A test policy check returns a decision

### Tell Agents What the Vault Is For

Agents need to know to write their outputs to the vault. Put this in your `context/conventions.md`:

```markdown
## After Completing Work

When you finish a task, write a summary to the vault:
- Key decisions made
- What needs follow-up
- Who needs to be informed

Use the vault page for the relevant project as the canonical record.
```

### Give Each Agent a Working Context

An agent that reads `company/overview.md`, `context/conventions.md`, and a relevant project page before starting work will produce better output than one that doesn't. Agents that use the vault consistently will maintain context across sessions automatically.

---

## Approval Queue Management

### Set SLAs on Rule Packs

Every rule pack should declare an SLA. The default is none, which means items can sit in the queue forever.

Set an SLA in the pack:

```yaml
sla_hours: 24
fallback_approver: "compliance@example.com"
```

If an item sits past its SLA, it auto-routes to the fallback approver. If the fallback SLA also expires, the item auto-rejects and notifies the proposing agent.

### Assign a Fallback Approver Who Is Not the Primary

The fallback approver is your safety net for items that the primary approver misses. They should not be checking the queue daily — that's the primary's job. If the fallback is also the primary, the escalation chain is useless.

### Review Queue Items Don't Accumulate

A queue with 50 items is a sign that either:
- The rule pack is over-firing (too many `route_to_review` outcomes — tune it)
- Approvers aren't checking daily (set a routine, or add a Slack/email notification)

Keep the queue under 20 items at all times. More than that and approvals become rubber-stamping.

---

## Compliance Evidence

### Keep Rule Packs in Source Control

The YAML files for your rule packs should be in a git repository. This gives you version history for every rule change, which matters when an auditor asks "what changed in your compliance policy in Q2?"

Include the pack file, its version, and the git commit hash in the compliance evidence report.

### Use Real Citations in Rules

A compliance report that cites "Internal policy" for every rule is less useful than one that cites specific regulations. Use `citation` fields even for operational rules — "outbound calling hours 9am-6pm local time" is better than nothing.

### Generate Monthly Reports

The compliance evidence report is your audit artifact. Generate it monthly even if you don't need it — it forces you to review what's in the audit log, and it keeps the report generation process familiar when you do need it.

Admin UI → **Dashboard** → **Reports** → **New Report**

### Keep the Activity Log Uninterrupted

The audit log is append-only and hash-chained. Do not delete entries from it. If you need shorter retention, set a retention window in **Settings → Retention** — the pruner will handle it. Manually editing or deleting log entries breaks the hash chain and invalidates the evidence report.

---

## Operations and Maintenance

### Restart Strategy

```bash
# Recreate agentos-d with the current compose config
agentworks restart agentos-d
```

Agents reconnect automatically. Policy checks in-flight queue and resume.

### Update Monthly

Check for updates monthly:

```bash
agentworks update --check
agentworks update
```

AgentWorks OS handles forward-only schema migrations on startup. If a migration fails, the daemon refuses to start and the previous version stays running. Check `docker compose logs agentos-d` if you see this.

### Monitor Disk Usage

The three things that grow:
1. **Activity log** — set a retention window and let the pruner handle it
2. **Vault** — trim completed projects and stale pages quarterly
3. **n8n data** — workflow execution history grows; prune from within n8n

Dashboard → **Storage** shows current usage.

### Test Backups Before You Need Them

Run a restore test every quarter against a scratch install — never restore
into production to verify a backup:

```bash
# 1. Take a fresh backup
agentworks backup ~/.agentworks/data/backups/test-$(date +%Y%m%d).tar.gz

# 2. Spin up a disposable install pointed at a scratch dir
AGENTWORKS_DIR=/tmp/awos-restore-test \
  ~/.agentworks/source/apps/installer/src/install.sh --unattended

# 3. Restore the backup into the scratch install
AGENTWORKS_DIR=/tmp/awos-restore-test agentworks restore \
  --input ~/.agentworks/data/backups/test-*.tar.gz

# 4. Verify it came up healthy
AGENTWORKS_DIR=/tmp/awos-restore-test agentworks status

# 5. Tear it down
AGENTWORKS_DIR=/tmp/awos-restore-test agentworks uninstall
```

A bundled `restore-test.sh` wrapper is on the v0.2 roadmap.

### Watch the Approval Queue Daily

Make checking the approval queue part of your daily routine. Items that sit for more than 48 hours are a sign something is wrong — either the rule pack is over-firing or the approver isn't checking.

---

## Security Scanner

### Configure Watched Paths After Migration

After migrating agent configs, confirm the scanner is watching them:

```bash
agentworks logs scanner-worker | grep "watching"
```

If a path is missing, add it in **Settings → Scanner → Watched Paths**.

### Act on Findings Within 7 Days

High and critical findings should be resolved or suppressed within 7 days. Low and medium findings should be triaged within 30 days. A findings list that grows without being acted on means the scanner is generating noise, not signal.

### Suppressions Must Be Justified

When you suppress a finding, write a brief note explaining why. "Intentional" is not a justification. "This path is mounted read-only at runtime so the finding is not exploitable" is.

Suppressions are auditable — an auditor will ask about them.

---

## What to Do When Something Goes Wrong

| Situation | First action |
|---|---|
| Policy check times out | Check **Dashboard → Daemon Status**. Restart `agentos-d` if down. |
| Approval queue items stuck "in flight" | Force-resolve from the item detail pane. The agent may have crashed. |
| Agent can't read vault | Have agent run `/memory refresh` or restart the agent app |
| Scanner stopped finding things | Re-add the path in **Settings → Scanner → Watched Paths** |
| Compliance report missing entries | Check retention window is longer than report period |
| Approver not getting emails | Run **Settings → Notifications → Test SMTP** |
| Vault edits not persisting | Check disk space; check `~/.agentworks/data/` is mounted correctly |

For anything not covered here, collect a support bundle per [Support Bundle](./support-bundle.md) and contact support with your tenant ID.
