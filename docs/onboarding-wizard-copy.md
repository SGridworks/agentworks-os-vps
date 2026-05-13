# Onboarding Wizard — Copy Reference

**File to read before implementing OnboardingWizard.tsx**
**Author:** TechnicalWriter
**Last updated:** 2026-04-27

This file contains every string the wizard displays. Copy these into the component. Do not paraphrase or summarize — use these exact strings.

---

## Step 1: Welcome

### Screen title

```
Welcome to AgentWorks OS
```

### Subtitle

```
The AI compliance firewall for regulated small businesses.
```

### What it does — intro card

```
What AgentWorks OS does
```

Body:
```
Intercepts every AI agent action through a policy engine.
Checks actions against rule packs you configure.
Blocks violations or routes them to a human approval queue.
Maintains an append-only audit log with tamper-evident hashing.
```

### What the wizard will set up

```
This wizard will help you:
```

List items:
```
1. Select compliance rule packs for your industry
2. Understand shadow mode before going live
3. Configure your business profile for tailored rules
```

### CTA button

```
Get Started
```

---

## Step 2: Rule Pack Selection

### Screen title

```
Select Rule Packs
```

### Subtitle

```
Choose compliance packs that match your industry and regulatory needs.
```

### Pack card labels

**For the SMB Starter pack (default suggestion):**

Pack name:
```
SMB Compliance Starter
```

Description:
```
Baseline compliance guardrails for small businesses running AI agents.
Covers do-not-contact, consent provenance, content boundaries, and data handling.
Not a substitute for industry-specific legal advice.
```

**For the TCPA Real Estate pack:**

Pack name:
```
TCPA Real Estate
```

Description:
```
Outbound contact rules for real estate lead-gen and marketing.
Covers TCPA do-not-call, written consent requirements, and SMS disclosure.
Requires attorney-reviewed status for production use.
```

**For the Fair Housing Real Estate pack:**

Pack name:
```
Fair Housing Real Estate
```

Description:
```
Marketing and lead-gen rules that account for Fair Housing Act protected classes.
Blocks discriminatory targeting criteria and census-tract-level sensitive offers.
Requires attorney-reviewed status for production use.
```

### Tier badge labels

```
Free
Paid
Attorney Reviewed
```

### Empty-state note (no packs selected)

```
Note: The SMB Starter pack provides baseline guardrails. We recommend selecting at least one industry-specific pack.
```

### Back button

```
Back
```

### Continue button

```
Continue
```

---

## Step 3: Shadow Mode

### Screen title

```
Shadow Mode
```

### Subtitle

```
Understand how your rule packs behave before enforcement begins.
```

### Toggle card header

```
Shadow Mode
```

Toggle card body:
```
When enabled, the policy engine evaluates all actions against your rule packs and logs the decisions — but does NOT block or route any actions. Everything passes through.
```

### Why start in shadow mode? — section header

```
Why start in shadow mode?
```

List items:
```
Observe how your rules perform with real agent actions.
Identify rules that may over-fire or conflict.
Build confidence before blocking real actions.
```

### Recommendation callout

```
Recommendation: Start with shadow mode enabled for at least 24-48 hours. You can switch to enforcement mode at any time from the Policy dashboard.
```

### Mode comparison — section header

```
Mode comparison
```

**Shadow Mode card:**
```
Shadow Mode
```
```
Evaluates all rules
Logs all decisions
Never blocks actions
Never routes to review
```

**Enforce Mode card:**
```
Enforce Mode
```
```
Evaluates all rules
Logs all decisions
Blocks violations
Routes to review queue
```

### Back button

```
Back
```

### Continue button (shadow enabled)

```
Start in Shadow Mode
```

### Continue button (shadow disabled)

```
Complete Setup
```

---

## Step 4: Business Profile

### Screen title

```
Business Profile
```

### Subtitle

```
Help us tailor the compliance rules to your specific context.
```

### Industry dropdown label

```
Industry / Business Type
```

Industry dropdown options:
```
Select your industry...
Real Estate
Healthcare / Health Services
Financial Services
Insurance
Legal Services
Other
```

### Jurisdiction dropdown label

```
Primary Jurisdiction
```

Jurisdiction dropdown options:
```
Select jurisdiction...
United States (Federal)
United States - California
United States - Texas
United States - New York
United States - Florida
United States - Other State
Multiple US States
Canada
Other
```

### Info callout

```
This information is used to pre-filter which rule packs are recommended and which regulations apply by default. You can change these settings at any time from the Settings dashboard.
```

### Back button

```
Back
```

### Complete Setup button

```
Complete Setup
```

---

## Completion / Confirmation Screen

After the wizard finishes, display:

```
Setup complete.
Your policy engine is running in shadow mode.
Start by connecting your first agent via MCP.
```

Then show a summary:
```
Company: [tenant name from onboarding]
Industry: [selected industry]
Jurisdiction: [selected jurisdiction]
Rule packs active: [list of selected pack names]
Mode: [Shadow / Enforcing]
```

### Next steps prompt

```
Next step: Connect Claude Desktop
```

Body:
```
Add the AgentWorks OS MCP server to your Claude Desktop config.
The installer printed the MCP URL during setup.
Restart Claude Desktop and try: /memory read
```

### Link to docs

```
See the install runbook for step-by-step agent connection instructions.
```

---

## Error / Edge-case Strings

### No packs available

```
No rule packs are available for your industry yet.
Select SMB Starter to continue with baseline guardrails.
```

### Wizard interrupted / session expired

```
Your session timed out. Restart the wizard to continue setup.
Any progress you made has been saved.
```

### Failed to load packs

```
Couldn't load rule packs from the server. Check that AgentWorks OS is running, then refresh.
```

---

## Copy rules for this file

1. Use these exact strings in the UI.
2. Do not add marketing language between steps.
3. Do not add progress encouragement ("You're doing great!").
4. Do not bold text except for section headers.
5. Keep callout boxes short — one paragraph max.
6. Tier badge labels are single words: Free / Paid / Attorney Reviewed.
7. The completion screen is the only place for a brief "setup complete" message.
