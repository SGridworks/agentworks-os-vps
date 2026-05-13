# Install & Onboarding Schedule Template

Use this as a public-safe install schedule template. Keep customer names,
company names, personal device names, and private access details out of the
repo.

## Objective

Install the AgentWorks OS stack, connect the first agent client through MCP, and
run one representative workflow through memory, policy, and evidence logging.

## Pre-Install Checklist

- Confirm installation owner and support contact outside the repo.
- Confirm target machine meets the published requirements.
- Confirm Docker and required ports are available.
- Confirm backup destination and restore test plan.
- Confirm which MCP client will be paired first.
- Confirm which rule pack should start in shadow mode.

## Install Window

1. Verify host readiness.
2. Install AgentWorks OS.
3. Start services and check daemon health.
4. Configure the first MCP client.
5. Run a memory read/write smoke test.
6. Run a representative action through policy check.
7. Confirm evidence logging in the admin UI.

## Post-Install

- Capture issues in the tracker without customer-identifying details.
- Store private support notes in the approved private system of record.
- Schedule the shadow-mode review.
- Decide which rule packs, if any, are ready for enforce mode.
