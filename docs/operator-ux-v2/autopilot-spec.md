# Autopilot With Guardrails – Design Spec

## Goal
Give regulated-SMB operators a single “Autopilot” toggle that lets the substrate automatically execute low-risk agent actions while escalating the rest for human review. The feature must surface a clear risk-score (0..1) and a human-readable reasons[] list so operators can audit every decision without reading YAML.

## Surfaces

### 1. Operator-facing toggle
- Location: Admin UI → Tenant Settings → Autopilot
- States: OFF | ON (default OFF for new tenants)
- Help text: “When ON the substrate will auto-execute actions scored ≤ 0.3 and queue the rest for approval.”

### 2. Action card in approval queue
- Tag: “Autopilot” (color = slate-400)
- Badge overlay: “Auto-allowed” | “Needs approval” | “Risky”
- Tooltip shows riskScore + top-3 reasons

### 3. Bulk-dispatch endpoint (internal)
`POST /api/tenants/:id/autopilot/dispatch`
```json
{
  "actionIds": ["<uuid>", …],
  "dryRun": false
}
```
Returns 207 multi-status:
```json
{
  "results": [
    {
      "actionId": "<uuid>",
      "decision": "allow" | "needsApproval" | "risky",
      "riskScore": 0.25,
      "reasons": ["tcpa.time_of_day", "fair_housing.keyword_match"]
    }
  ]
}
```
Dry-run skips side-effects; live run updates approval queue and audit log.

## Backend

### Bucketing rules (evaluated in order)
1. **Safe** → auto-allow
   - riskScore ≤ 0.30
   - No rule returned “block”
   - Action type is in allow-listed set: memory_write, file_read, http_get, shell_read_only
2. **Risky** → block + alert
   - Any rule returned “block”
   - riskScore ≥ 0.70
3. **NeedsApproval** → queue for human review
   - Everything else

### riskScore formula (0..1)
```
riskScore = max(ruleSeverityScore, actionTypeScore, contentScore)

where
ruleSeverityScore = 0.0 if all rules allow
                    0.4 if any rule returns route_to_review
                    1.0 if any rule returns block

actionTypeScore = lookup in action-type-risk-table (see below)

contentScore = 0.0 if no pattern matches
               0.3 if Fair-Housing keyword match
               0.5 if TCPA phone/time match
               0.6 if HIPAA identifier detected
               1.0 if PII regex high-confidence match
```

action-type-risk-table (YAML fragment shipped in rule-packs/smb-starter/autopilot.yml):
```yaml
action_type_scores:
  memory_write: 0.10
  file_read: 0.05
  http_get: 0.10
  http_post: 0.35
  shell_read_only: 0.10
  shell_mutating: 0.50
  email_send: 0.45
  sms_send: 0.55
  db_write: 0.40
```

### reasons[] vocabulary (canonical strings)
- `tcpa.time_of_day` – TCPA quiet-hours violation
- `tcpa.phone_invalid` – malformed US phone
- `fair_housing.keyword_match` – protected-class keyword detected
- `fair_housing.steering` – geographic steering language
- `hipaa.phi_detected` – PHI pattern matched
- `pii.high_confidence` – SSN, DL, CCN regex hit
- `action_type.high_risk` – action type score ≥ 0.5
- `rule_pack.block` – explicit block rule fired
- `content.unsafe_url` – URL deny-list match
- `approval_history.recent_deny` – same agent denied ≤ 24 h ago

Reasons are deduplicated and capped at 5 per action.

### Implementation notes
- New column `autopilot_decision` on `approval_queue` table: enum(allow, needsApproval, risky)
- New column `risk_score` numeric(3,2)
- New column `reasons` jsonb
- Policy engine evaluator returns the above three fields in addition to legacy verdict
- Bulk-dispatch worker runs in agentos-d process, 50 actions per batch, 5 concurrent batches max
- Audit log entries tagged `autopilot=true` when decision source = autopilot

## Frontend

### Toggle switch
- React component `<AutopilotToggle tenantId={id} />`
- Mutates via `PATCH /api/tenants/:id/settings { autopilotEnabled: boolean }`
- Shows inline confirmation toast: “Autopilot is ON. Actions scored ≤ 0.3 will auto-execute.”

### Queue filters
- New filter pill “Autopilot” with sub-options: Auto-allowed / Needs approval / Risky
- Column “Risk” added to queue table (sortable, 0→1)
- Expandable row shows full reasons[] list and contributing score breakdown

### Telemetry banner
- If ≥ 3 “risky” decisions in last 24 h, show yellow banner: “Autopilot blocked 3 high-risk actions – review settings.” CTA links to tenant settings.

## Out of scope
- Rollback / undo of auto-executed actions (v2)
- Per-agent autopilot overrides
- Custom risk-score thresholds per tenant (v1.1)
- Real-time operator chat before escalation

## Open questions
1. Do we persist the risk-score & reasons for manually approved actions? (Proposed: yes, for future ML.)
2. Should we expose the action-type-risk-table as UI-editable? (Deferred to v1.1.)
3. Kill-switch behavior when autopilot mis-classifies – manual disable only, or automatic backoff? (Manual only for v1.)
