# E2E Verification

Use this after a clean install or release-candidate deploy to prove the full default stack works end to end.

## Preconditions

- `agentos-d` is reachable at `http://127.0.0.1:7710`
- `scanner-worker` is reachable at `http://127.0.0.1:3101`
- `n8n` is reachable at `http://127.0.0.1:5678`
- `admin-ui` is reachable at `http://127.0.0.1:3000`

On a VPS, keep those services loopback-only and run the test through SSH tunnels:

```bash
ssh -N \
  -L 17710:127.0.0.1:7710 \
  -L 13000:127.0.0.1:3000 \
  -L 13101:127.0.0.1:3101 \
  -L 15678:127.0.0.1:5678 \
  <user>@<vps-host>
```

Then run from the source checkout on the workstation:

```bash
AWOS_BASE=http://127.0.0.1:17710/api \
AWOS_ADMIN=http://127.0.0.1:13000 \
AWOS_SCANNER=http://127.0.0.1:13101 \
AWOS_N8N=http://127.0.0.1:15678 \
pnpm test:vps-e2e
```

For a local install, run:

```bash
pnpm test:vps-e2e
```

## Coverage

The test creates disposable records and verifies:

- daemon, scanner, n8n, and admin-ui health
- tenant creation
- company creation
- project creation
- agent creation
- assigned issue creation
- unassigned triage issue creation
- triage queue assignment and removal
- issue workflow through `in_progress` and `done`
- corrected issue comment body field
- agent wakeup dispatch through completion
- agent runtime state
- execution run, run event, and task session
- policy `route_to_review` and approval queue review
- scanner submit, poll, and findings list
- final company, agent, issue, dispatch, and scanner visibility checks

## Evidence

The script writes `summary.json` under `AWOS_E2E_OUT`, or under `/tmp/awos-vps-e2e-*` by default.

A launch candidate should not ship unless this script exits zero on a clean install with no manual file edits on the target host.
