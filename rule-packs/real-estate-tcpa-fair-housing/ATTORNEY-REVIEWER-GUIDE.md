# Attorney Reviewer Guide
## Real Estate TCPA + Fair Housing Rule Pack

**Pack:** `real-estate-tcpa-fair-housing-v0.1.yaml`
**Version reviewed:** 0.1.0-draft
**Reviewer:** [NAME — to be completed by reviewing attorney]
**Date:** [DATE — to be completed by reviewing attorney]
**Status:** PENDING ATTORNEY REVIEW

---

## What You Are Reviewing

This is a **compliance assistance rule pack** for the AgentWorks OS policy engine. It defines machine-evaluable rules that intercept AI agent actions (outbound SMS, email, calls, lead-gen, CRM writes) before they execute and either allow, block, or route them to human review.

**What this is NOT:**
- This is not a legal opinion
- This is not a guarantee of compliance
- This does not replace the need for customers to have their own legal counsel
- This does not substitute for integrating real consent records, DNC lists, or phone validation services

**What this IS:**
- A structured, versioned rule definition that translates legal requirements into machine-evaluable logic
- A documentation artifact that shows which legal citations support each rule
- A tool that helps regulated businesses operationalize compliance for AI agent workflows

The rule pack ships with a disclaimer that must appear in all customer-facing materials: *"This pack provides compliance assistance, not legal advice."*

---

## Reviewer Objectives

Your job as reviewing attorney is to verify:

1. **Rule logic is sound** — each rule correctly captures the legal requirement it claims to implement
2. **Citations are accurate** — statutory references are current, correct, and sufficient
3. **Disposition logic is appropriate** — the block/route_to_review/allow outcomes are legally justified
4. **Required data declarations are realistic** — the data the pack requires is actually obtainable by a customer
5. **Exceptions and exemptions are correctly modeled** — EBR and other exemptions are accurately represented
6. **Ohio-specific rules are accurate** — state law requirements are correctly stated

---

## Regulatory Landscape

### TCPA (47 U.S.C. § 227; 47 C.F.R. § 64.1200)

The Telephone Consumer Protection Act restricts:
- Use of autodialers (ATDS) for residential telephone numbers
- Unwanted solicitations via text message
- Contacting residential subscribers who have registered on do-not-call lists

Key TCPA provisions relevant to this pack:
- **Written consent** required for autodialed calls/SMS to mobile numbers (47 C.F.R. § 64.1200(a)(1))
- **Internal DNC lists** must be honored (47 C.F.R. § 64.1200(c)(2))
- **Time-of-day restrictions**: 8 AM–9 PM local time of called party
- **ATDS definition**: an automated system that can store or produce telephone numbers using random or sequential number generator

**Open TCPA questions this pack flags for attorney review:**
- Whether AI-agent-initiated messages constitute ATDS usage (FCC guidance evolving)
- Whether EBR eliminates written consent requirement for mobile (split authority — courts and FCC)
- Reassigned numbers doctrine and void consent

### Fair Housing Act (42 U.S.C. § 3601 et seq.)

The FHA prohibits discrimination in housing-related marketing and transactions based on:
- Race, color, national origin
- Religion
- Sex (including gender identity and sexual orientation)
- Familial status (presence of children under 18)
- Disability
- Color (additional protected class under Ohio law)

Key provisions:
- **§ 3604(a)**: refusal to deal or discrimination in terms/conditions of housing
- **§ 3604(c)**: discriminatory advertising
- **§ 3604(d)**: discrimination in financing
- **24 C.F.R. Part 109**: FHA advertising rules
- **24 C.F.R. § 100.500**: disparate impact standard

**Open FH questions this pack flags for attorney review:**
- Disparate impact analysis at census-tract granularity
- Steering definition for digital advertising
- Ohio-specific protected classes (ancestry, military status)

### Ohio Real Estate (OAC 4735: Ohio Real Estate License Law)

- **OAC 4735-7-09**: unsolicited real estate communications must include license disclosure
- **ORC Chapter 4112**: Ohio Fair Housing Act (broader than federal in some respects)
- Ohio adds **ancestry** and **military status** as protected classes

---

## Section-by-Section Review Notes

### Section: TCPA DNC Rules (Rules RE-TCPA-001 through RE-TCPA-003)

**RE-TCPA-001** (Block SMS to internal DNC list)
- Citation 47 C.F.R. § 64.1200(c)(2) is accurate
- Verify: does this correctly restrict to residential subscribers, or does it also apply to mobile?
- Verify: is the internal DNC check sufficient or must external DNC be checked too?

**RE-TCPA-002** (Block SMS to reassigned numbers)
- The void-consent doctrine for reassigned numbers is correctly stated per FCC 07-222
- Verify: is the reassigned number check required only for the National Reassigned Numbers Database, or does any reassignment trigger the block?

**RE-TCPA-003** (Block SMS to landline via ATDS)
- This rule may be overbroad. ATDS restriction applies to autodialer delivery, not necessarily all automated SMS.
- **Flag for review**: verify whether all SMS from AI agents constitute ATDS usage, or only messages from systems with random/sequential number generation capability.

### Section: TCPA Written Consent (Rule RE-TCPA-004)

**RE-TCPA-004** is the core mobile consent rule.
- Citation 47 U.S.C. § 227(b)(1)(A) and 47 C.F.R. § 64.1200(a)(1) are correct.
- Verify: the rule treats "written" as the only acceptable consent type for mobile. Is this accurate?
- Note: the FCC's 2024 rulemaking on AI-generated calls may affect this analysis — check whether AI-agent-initiated messages are treated differently from pure ATDS calls.

### Section: TCPA EBR Exemption (Rule RE-TCPA-006)

**RE-TCPA-006** is the most legally complex rule in this pack.
- The EBR exemption under 47 C.F.R. § 64.1200(f)(5) is real but contested.
- Courts have split on whether EBR eliminates the written consent requirement for mobile.
- The D.C. Circuit's 2024 decision in Tel. No. 1 v. FCC may have resolved this — verify current status.
- **This rule routes to review rather than allowing**: this is the conservative position and is legally defensible.
- Verify: is the EBR routing appropriately conservative?

### Section: Fair Housing Core (Rules RE-FH-001 through RE-FH-003)

**RE-FH-001** (Block exclusion by protected class)
- 42 U.S.C. § 3604(a) and 24 C.F.R. § 100.60 are correct citations.
- Applies to filtering and exclusion — correctly stated.

**RE-FH-002** (Discriminatory intent)
- Correct standard. Discriminatory intent can be inferred from circumstantial evidence.
- Verify: is the "combination of targeting + content" test for inferring intent legally sound?

**RE-FH-003** (Disparate impact)
- The citation to HUD § 100.500 is correct.
- The "dummy criteria" language is appropriate.
- Verify: does census-tract targeting alone trigger the rule, or does the rule require an additional showing of discriminatory effect?

### Section: Fair Housing Advertising (Rules RE-FH-004 through RE-FH-006)

**RE-FH-004** (Discriminatory content)
- 42 U.S.C. § 3604(c) and 24 C.F.R. Part 109 are correct.
- Examples provided are illustrative — verify they are representative.

**RE-FH-005** (Steering)
- HUD Revenue Ruling 24-10 (April 2024) is the current guidance on digital steering.
- Verify: does describing neighborhood characteristics (school quality, income level, family density) constitute steering?

**RE-FH-006** (Equal housing notice)
- 24 C.F.R. § 109.30 is correct.
- **Flag**: digital advertising has modified notice requirements. Verify which platforms require the notice.

### Section: Ohio State Overlay (Rule RE-OH-FH-001)

**RE-OH-FH-001**
- ORC Chapter 4112 is the correct citation for Ohio fair housing.
- Verify: Ohio adds ancestry and military status as protected classes. Confirm this is current and accurate.
- Note: Ohio law may also cover additional contexts not covered by federal FHA.

### Section: Ohio Real Estate License Disclosure (Rule RE-OH-RE-001)

**RE-OH-RE-001**
- OAC 4735-7-09 is the correct administrative code cite.
- **Flag**: verify which communications require the disclosure (SMS, email, voice, all?).
- **Flag**: verify whether "unsolicited" is defined to include AI-initiated outreach to prospects who have not directly requested contact.

---

## Open Questions Requiring Your Written Response

Please confirm in writing (email is sufficient for draft review, letter for final):

1. **OATH-TCPA-001**: TCPA written consent requirement for mobile SMS/calls under 47 U.S.C. § 227(b)(1)(A) — confirm the rule correctly states this requirement.

2. **OATH-TCPA-002**: EBR exemption scope — confirm whether EBR eliminates written consent for mobile, or whether the conservative "route to review" position is appropriate given split authority.

3. **OATH-TCPA-003**: ATDS definition — confirm whether AI-agent-initiated messages constitute ATDS usage under current FCC guidance, and whether the landline-SMS restriction is correctly scoped.

4. **OATH-FH-001**: Disparate impact at census-tract granularity — confirm whether census-tract targeting alone triggers route_to_review or whether additional statistical showing is required.

5. **OATH-FH-002**: Steering definition — confirm whether neighborhood descriptive language in digital marketing constitutes steering under HUD guidance.

6. **OATH-FH-003**: Ohio ORC 4112 protected classes — confirm ancestry and military status are correctly listed as additional Ohio-only protections.

7. **OATH-OH-001**: Ohio real estate license disclosure under OAC 4735-7-09 — confirm which channels require disclosure and whether AI-initiated outreach to prospects constitutes "unsolicited communication."

---

## Sign-Off Process

When all open questions above are resolved to your satisfaction:

1. Provide written confirmation for each open question (email or letter)
2. Confirm the pack is ready for `attorney_reviewed: true`
3. Provide your name and bar number for the pack record
4. Confirm the engagement letter is on file with SGridworks

SGridworks will then update the pack metadata:
```yaml
attorney_reviewed: true
attorney_name: "Your Name, Esq."
attorney_engagement_letter_on_file: true
```

The engagement letter should reference this specific pack version (v0.1.0-draft) and the scope of review covered.

---

## Disclaimer That Must Appear

The pack includes the following disclaimer which must not be removed or modified:

> DISCLAIMER: This pack provides compliance assistance, not legal advice. It requires customer integration with consent records, DNC status, phone type, and jurisdiction data to function fully. "Route to review" is the correct disposition when required data is missing — it is not a passing grade.

---

## Contact

For questions about this review:
- SGridworks compliance team: [compliance@sgridworks.com]
- Engagement letter requests: [legal@sgridworks.com]
- Technical questions about rule pack structure: [support@sgridworks.com]
