"""
python -m agentos_d.mcp_test_client

A minimal MCP (Model Context Protocol) test client that verifies the agentos-d
daemon is reachable and exercises the policy.check tool via JSON-RPC 2.0.

Usage:
    cd ~/agentworks-os/packages/agentos-d
    pip install -e .   # one-time: makes agentos_d importable
    python -m agentos_d.mcp_test_client [--url http://localhost:7710]

Exit codes:
    0  — all checks passed
    1  — daemon unreachable, MCP handshake failed, or policy check non-2xx
    2  — unexpected JSON-RPC error response
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
import urllib.error


DEFAULT_URL = "http://localhost:7710/api/mcp"
EXIT_OK = 0
EXIT_CONNECTION_FAIL = 1
EXIT_RPC_ERROR = 2


def jrpc(method: str, params: dict | None = None, req_id: int = 1) -> dict:
    payload: dict = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        payload["params"] = params
    return payload


def post(url: str, payload: dict, timeout: float = 10.0) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: SIM117
        return json.loads(resp.read().decode("utf-8"))


def check_initialize(url: str) -> bool:
    resp = post(
        url,
        jrpc(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "agentos-d-mcp-test", "version": "0.1.0"},
            },
        ),
    )
    if "result" not in resp:
        print("FAIL  initialize: no result in response")
        return False
    result = resp["result"]
    server_name = result.get("serverInfo", {}).get("name", "?")
    protocol_version = result.get("protocolVersion", "?")
    print(f"OK    initialize: server={server_name} protocol={protocol_version}")
    return True


def check_tools_list(url: str) -> bool:
    resp = post(url, jrpc("tools/list"))
    if "result" not in resp:
        print("FAIL  tools/list: no result in response")
        return False
    tools = resp["result"].get("tools", [])
    tool_names = [t["name"] for t in tools]
    print(f"OK    tools/list: {len(tools)} tools — {', '.join(tool_names)}")
    return True


def check_policy_check(url: str, tenant_id: str) -> bool:
    params = {
        "tenantId": tenant_id,
        "actor": {"id": "test-agent", "type": "agent", "label": "mcp-test-client"},
        "proposedAction": {
            "kind": "outbound.sms",
            "summary": "Test outbound SMS to 555-000-1234",
        },
        "evidenceSnapshot": {"source": "mcp-test-client"},
    }
    resp = post(url, jrpc("tools/call", {"name": "policy.check", "arguments": params}))
    if "result" not in resp:
        error = resp.get("error", {})
        print(f"FAIL  policy.check: JSON-RPC error {error.get('code')} — {error.get('message')}")
        return False
    result = resp["result"]
    decision = result.get("decision", "UNKNOWN")
    print(f"OK    policy.check: decision={decision}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="MCP test client for agentos-d")
    parser.add_argument("--url", default=DEFAULT_URL, help="MCP endpoint URL")
    parser.add_argument(
        "--tenant-id",
        default="00000000-0000-0000-0000-000000000001",
        help="Tenant ID for policy check",
    )
    args = parser.parse_args()

    print(f"[agentos-d] MCP test client")
    print(f"[agentos-d] Target: {args.url}")
    print()

    try:
        ok = check_initialize(args.url)
        ok = check_tools_list(args.url) and ok
        ok = check_policy_check(args.url, args.tenant_id) and ok
    except urllib.error.URLError as e:
        print(f"FAIL  Could not connect to {args.url}: {e.reason}")
        return EXIT_CONNECTION_FAIL
    except json.JSONDecodeError as e:
        print(f"FAIL  Invalid JSON response: {e}")
        return EXIT_RPC_ERROR

    print()
    if ok:
        print("[agentos-d] All checks passed")
        return EXIT_OK
    else:
        print("[agentos-d] Some checks failed")
        return EXIT_RPC_ERROR


if __name__ == "__main__":
    sys.exit(main())
