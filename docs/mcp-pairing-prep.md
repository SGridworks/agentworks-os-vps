# MCP Pairing Prep

## What This Covers

Connect a customer's existing MCP-capable tools to the AgentWorks MCP server
running inside `agentos-d`. Once connected, those tools can:

- read from and write to the AgentWorks vault
- submit actions through the policy engine
- log activity to the audit trail

## Prerequisites

- `agentos-d` exposes the MCP server.
- The install runbook includes the supported MCP client configuration.
- The MCP integration guide has the current tenant-ID and client config steps.
- The customer has approved the support channel used for managed setup.

## Implementation Notes

The MCP server should expose:

- `memory.read`
- `memory.write`
- `policy.check`

The daemon should serve MCP over the supported local transport. If a client
requires stdio, use the AgentWorks stdio bridge rather than exposing an
unauthenticated network endpoint.

## Managed Setup Sequence

1. Connect to the customer-managed workstation through the approved support
   channel.
2. Verify AgentWorks OS services are running.
3. Write or guide the MCP client configuration.
4. Restart the MCP client if required.
5. Smoke test `memory.read`.
6. Smoke test `policy.check`.
7. Confirm the admin UI shows the action feed and audit entries.

## Verification Gates

The MCP pairing is done when:

- the first MCP client lists the `agentworks` server
- `memory.read` returns seeded vault content
- `memory.write` records a test note
- `policy.check` returns a policy decision
- the customer can use their existing agent client without changing workflow
