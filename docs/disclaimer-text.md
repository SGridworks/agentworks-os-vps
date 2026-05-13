# Compliance Evidence Report — Disclaimer Text
# Artifact identifier: AWO-80
# Status: DRAFT v0.1 — requires operator sign-off before use

---

## Required Disclaimer (for all Compliance Evidence Report footers)

```
THIS REPORT REFLECTS THE STATE OF THE AGENTWORKS SUBSTRATE AT THE TIME OF
EVALUATION. IT IS NOT LEGAL ADVICE AND DOES NOT CONSTITUTE A DETERMINATION
THAT ANY PARTY IS IN COMPLIANCE WITH APPLICABLE LAW. COMPLIANCE WITH TCPA,
FAIR HOUSING, HIPAA, OR OTHER REGULATORY REQUIREMENTS DEPENDS ON FACTS
SPECIFIC TO YOUR SITUATION THAT THIS SYSTEM DOES NOT POSSESS. CONSULT A
LICENSED ATTORNEY BEFORE TAKING ACTION BASED ON THIS REPORT.
```

---

## Short-form badge text (for UI, reports, PDFs)

> Evidence of system state. Not legal compliance. Consult an attorney.

---

## Positioning copy for customer-facing materials

AgentWorks produces a **Compliance Evidence Report** — a signed, hashed record of what the policy engine evaluated, what decisions it reached, and what data was present at evaluation time.

The Compliance Evidence Report is not a compliance certificate and not a legal opinion. It does not guarantee that any specific action is lawful. What it provides: a tamper-evident record of the system's behavior, so your team can review what happened and your counsel can advise on what it means.

**What the report tells you:**
- Which rule packs were active
- What each action's input data looked like to the system
- What decision the policy engine reached
- What data was missing (which may itself be a compliance flag)

**What the report does not tell you:**
- Whether your specific facts satisfy the applicable legal standard
- Whether a regulator would agree with the outcome
- Anything about data sources the system does not integrate

The substrate requires integration with your consent records, DNC status providers, and jurisdiction data to evaluate TCPA rules. A report showing "data missing" for those fields is a flag that your integration needs attention before the system can evaluate those rules. It is not a passing grade.

---

## Internal notes for review

The word "certificate" does not appear anywhere in this framing. The word "compliance" appears only as part of the product name ("Compliance Evidence Report") and in the explicit disavowal. No claim that the system makes you legal-compliant.

The missing-data warning is intentionally prominent. This is both accurate (TCPA/fair-housing checks require DNC/consent/jurisdiction data) and protective (prevents customers from reading the report as a clean bill of health).
