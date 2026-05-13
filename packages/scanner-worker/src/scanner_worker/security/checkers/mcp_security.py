"""
MCP (Model Context Protocol) Security Auditing
Detects vulnerabilities in MCP server configurations and tool access
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from scanner_worker.security.models import Finding, SeverityLevel
from scanner_worker.security.payloads import SecurityPayloads


class MCPSecurityChecker:
    """Audits MCP (Model Context Protocol) server security"""

    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout

    async def check_all(self, target_url: str) -> list[Finding]:
        """Run all MCP security checks"""
        findings = []

        # Enumerate MCP servers
        findings.extend(await self._enumerate_mcp_servers(target_url))

        # Check MCP authentication
        findings.extend(await self._check_mcp_authentication(target_url))

        # Test for SSRF via MCP tools
        findings.extend(await self._check_mcp_ssrf(target_url))

        # Check for overpowered MCP tools
        findings.extend(await self._check_dangerous_tools(target_url))

        # Check for MCP config exposure
        findings.extend(await self._check_mcp_config_exposure(target_url))

        # Deep scan: tool description injection
        findings.extend(await self._check_tool_description_injection(target_url))

        # Deep scan: schema poisoning
        findings.extend(await self._check_schema_poisoning(target_url))

        # Deep scan: capability escalation
        findings.extend(await self._check_capability_escalation(target_url))

        return findings

    async def _enumerate_mcp_servers(self, target_url: str) -> list[Finding]:
        """Enumerate and identify MCP servers"""
        findings = []

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in SecurityPayloads.MCP_ENDPOINTS:
                try:
                    url = f"{target_url.rstrip('/')}{endpoint}"
                    response = await client.get(url)

                    if response.status_code == 200:
                        try:
                            data = response.json()

                            # Check if this looks like MCP config
                            if isinstance(data, dict):
                                # MCP server indicators
                                mcp_indicators = ["mcpServers", "servers", "tools", "resources"]

                                if any(key in data for key in mcp_indicators):
                                    findings.append(Finding(
                                        id="MCP-001",
                                        severity=SeverityLevel.MEDIUM,
                                        title="MCP Server Configuration Exposed",
                                        description=(
                                            "MCP (Model Context Protocol) server configuration is publicly accessible. "
                                            "This reveals information about available tools, server locations, and "
                                            "potentially sensitive connection details."
                                        ),
                                        affected_endpoint=url,
                                        evidence=f"MCP configuration found at {endpoint}. Keys: {list(data.keys())}",
                                        remediation=(
                                            "1. Require authentication for MCP configuration endpoints. "
                                            "2. Move MCP config files outside web-accessible directories. "
                                            "3. Use environment variables instead of config files for secrets. "
                                            "4. Implement IP whitelisting for admin endpoints."
                                        ),
                                        cwe_id="CWE-200",
                                        cvss_score=5.3
                                    ))

                        except json.JSONDecodeError:
                            pass

                except Exception:
                    continue

        return findings

    async def _check_mcp_authentication(self, target_url: str) -> list[Finding]:
        """Check if MCP servers require authentication"""
        findings = []

        mcp_tool_endpoints = [
            "/api/tools/execute",
            "/api/mcp/call",
            "/mcp/invoke",
            "/tools/run",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in mcp_tool_endpoints:
                try:
                    url = f"{target_url.rstrip('/')}{endpoint}"

                    # Try to execute a harmless tool without auth
                    test_payloads = [
                        {"tool": "list", "args": {}},
                        {"name": "filesystem_list", "arguments": {"path": "/"}},
                        {"tool_name": "echo", "params": {"message": "test"}},
                    ]

                    for payload in test_payloads:
                        try:
                            response = await client.post(url, json=payload)

                            # If we get 200 without auth, that's a problem
                            if response.status_code in [200, 201]:
                                findings.append(Finding(
                                    id="MCP-002",
                                    severity=SeverityLevel.CRITICAL,
                                    title="Unauthenticated MCP Tool Execution",
                                    description=(
                                        "MCP tools can be executed without authentication. This allows "
                                        "unauthorized users to invoke agent capabilities, potentially leading "
                                        "to data access, command execution, or system compromise."
                                    ),
                                    affected_endpoint=url,
                                    evidence=f"Tool executed without credentials: {payload}",
                                    remediation=(
                                        "1. IMMEDIATELY require authentication for all MCP tool endpoints. "
                                        "2. Implement API key or OAuth 2.0 authentication. "
                                        "3. Use per-tool authorization policies. "
                                        "4. Add rate limiting to prevent abuse. "
                                        "5. Audit all tool invocations and log authentication failures."
                                    ),
                                    cwe_id="CWE-306",  # Missing Authentication
                                    cvss_score=10.0
                                ))
                                break  # Found vulnerability, stop testing this endpoint

                        except httpx.HTTPStatusError:
                            continue

                except Exception:
                    continue

        return findings

    async def _check_mcp_ssrf(self, target_url: str) -> list[Finding]:
        """Test if MCP tools can be used for SSRF attacks"""
        findings = []

        # Common MCP tools that might enable SSRF
        ssrf_tools = [
            {"tool": "fetch", "args": {"url": "http://169.254.169.254/latest/meta-data/"}},
            {"tool": "web_fetch", "args": {"url": "http://localhost:22"}},
            {"name": "http_request", "arguments": {"url": "http://127.0.0.1:6379"}},
        ]

        endpoints = ["/api/tools/execute", "/api/mcp/call"]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in endpoints:
                url = f"{target_url.rstrip('/')}{endpoint}"

                for tool_call in ssrf_tools:
                    try:
                        response = await client.post(url, json=tool_call)

                        # If request succeeds, check if SSRF was possible
                        if response.status_code in [200, 201]:
                            response_text = response.text.lower()

                            # Check for indicators of successful internal access
                            ssrf_indicators = ["ami-id", "iam", "redis", "ssh", "mysql"]

                            if any(indicator in response_text for indicator in ssrf_indicators):
                                findings.append(Finding(
                                    id="MCP-003",
                                    severity=SeverityLevel.CRITICAL,
                                    title="SSRF via MCP Tools",
                                    description=(
                                        "MCP tools can be exploited for Server-Side Request Forgery (SSRF) attacks. "
                                        "Attackers can use agent tools to access internal services, cloud metadata "
                                        "endpoints, or scan internal networks."
                                    ),
                                    affected_endpoint=url,
                                    evidence=f"SSRF successful with payload: {tool_call}",
                                    remediation=(
                                        "1. Implement URL validation to block internal IPs (127.0.0.0/8, 10.0.0.0/8, etc.). "
                                        "2. Block access to cloud metadata endpoints (169.254.169.254, metadata.google.internal). "
                                        "3. Use allowlists for permitted external domains. "
                                        "4. Implement DNS resolution checks after URL validation. "
                                        "5. Use a proxy or network firewall to restrict outbound connections."
                                    ),
                                    cwe_id="CWE-918",  # SSRF
                                    cvss_score=9.6,
                                    references=[
                                        "https://portswigger.net/web-security/ssrf",
                                        "https://owasp.org/Top10/A10_2021-Server-Side_Request_Forgery_%28SSRF%29/"
                                    ]
                                ))
                                break

                    except Exception:
                        continue

        return findings

    async def _check_dangerous_tools(self, target_url: str) -> list[Finding]:
        """Check for overly permissive or dangerous MCP tools"""
        findings = []

        # Try to list available tools
        tool_list_endpoints = [
            "/api/tools/list",
            "/api/mcp/tools",
            "/tools",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in tool_list_endpoints:
                try:
                    url = f"{target_url.rstrip('/')}{endpoint}"
                    response = await client.get(url)

                    if response.status_code == 200:
                        try:
                            data = response.json()

                            # Extract tool names
                            tool_names = []
                            if isinstance(data, list):
                                tool_names = [t.get("name", "") for t in data if isinstance(t, dict)]
                            elif isinstance(data, dict) and "tools" in data:
                                tool_names = [t.get("name", "") for t in data["tools"] if isinstance(t, dict)]

                            # Check for dangerous tools
                            dangerous_tools = [
                                "shell", "exec", "execute", "command", "bash",
                                "eval", "system", "subprocess",
                                "delete", "rm", "unlink",
                                "write_file", "modify_file",
                            ]

                            found_dangerous = [t for t in tool_names if any(d in t.lower() for d in dangerous_tools)]

                            if found_dangerous:
                                findings.append(Finding(
                                    id="MCP-004",
                                    severity=SeverityLevel.HIGH,
                                    title="Dangerous MCP Tools Exposed",
                                    description=(
                                        f"Agent exposes high-risk MCP tools: {', '.join(found_dangerous)}. "
                                        "These tools allow command execution, file system modification, or "
                                        "other dangerous operations that could compromise the system."
                                    ),
                                    affected_endpoint=url,
                                    evidence=f"Dangerous tools detected: {found_dangerous}",
                                    remediation=(
                                        "1. Remove or disable unnecessary dangerous tools. "
                                        "2. Implement strict authorization for high-risk tools. "
                                        "3. Add explicit user confirmation for destructive operations. "
                                        "4. Use sandboxed execution environments (containers, VMs). "
                                        "5. Implement comprehensive audit logging for tool usage. "
                                        "6. Apply principle of least privilege to tool capabilities."
                                    ),
                                    cwe_id="CWE-250",  # Execution with Unnecessary Privileges
                                    cvss_score=8.8
                                ))

                        except json.JSONDecodeError:
                            pass

                except Exception:
                    continue

        return findings

    async def _check_mcp_config_exposure(self, target_url: str) -> list[Finding]:
        """Check for exposed MCP configuration files"""
        findings = []

        config_paths = [
            "/.claude/mcp_servers.json",
            "/mcp-config.json",
            "/config/mcp.json",
            "/.config/mcp_servers.json",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for path in config_paths:
                try:
                    url = f"{target_url.rstrip('/')}{path}"
                    response = await client.get(url)

                    if response.status_code == 200:
                        try:
                            config = response.json()

                            # Check for sensitive information in config
                            sensitive_keys = ["api_key", "token", "password", "secret", "auth"]
                            config_str = json.dumps(config).lower()

                            has_secrets = any(key in config_str for key in sensitive_keys)

                            severity = SeverityLevel.CRITICAL if has_secrets else SeverityLevel.HIGH

                            findings.append(Finding(
                                id="MCP-005",
                                severity=severity,
                                title="MCP Configuration File Exposed",
                                description=(
                                    "MCP server configuration file is publicly accessible. "
                                    + ("This file contains API keys, tokens, or other credentials." if has_secrets else
                                       "This exposes server locations and tool configurations.")
                                ),
                                affected_endpoint=url,
                                evidence=f"Config file accessible at {path}",
                                remediation=(
                                    "1. IMMEDIATELY remove config files from web-accessible directories. "
                                    "2. Use .gitignore to prevent config files from being committed. "
                                    "3. Store configuration in environment variables or secure vaults. "
                                    "4. Rotate any exposed credentials immediately. "
                                    "5. Configure web server to deny access to .json, .yaml, and .env files."
                                ),
                                cwe_id="CWE-552",  # Files or Directories Accessible to External Parties
                                cvss_score=9.1 if has_secrets else 7.5
                            ))

                        except json.JSONDecodeError:
                            pass

                except Exception:
                    continue

        return findings

    def _extract_tools_from_response(self, data: dict[str, Any] | list[Any]) -> list[dict[str, Any]]:
        """Extract tool dicts from various response formats."""
        if isinstance(data, list):
            return [t for t in data if isinstance(t, dict)]
        if isinstance(data, dict):
            if "tools" in data:
                return [t for t in data["tools"] if isinstance(t, dict)]
            if "mcpServers" in data:
                tools: list[dict[str, Any]] = []
                for server in data["mcpServers"].values():
                    if isinstance(server, dict) and "tools" in server:
                        tools.extend(
                            t for t in server["tools"] if isinstance(t, dict)
                        )
                return tools
        return []

    async def _check_tool_description_injection(self, target_url: str) -> list[Finding]:
        """Scan MCP tool descriptions for prompt injection patterns."""
        findings = []
        tool_list_endpoints = ["/api/tools/list", "/api/mcp/tools", "/tools", "/mcp/tools"]
        compiled = [re.compile(p, re.IGNORECASE) for p in SecurityPayloads.MCP_INJECTION_PATTERNS]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in tool_list_endpoints:
                try:
                    url = f"{target_url.rstrip('/')}{endpoint}"
                    response = await client.get(url)
                    if response.status_code != 200:
                        continue

                    data = response.json()
                    tools = self._extract_tools_from_response(data)

                    for tool in tools:
                        desc = tool.get("description", "")
                        name = tool.get("name", "<unknown>")

                        matched = [p.pattern for p in compiled if p.search(desc)]
                        if matched:
                            findings.append(Finding(
                                id="MCP-006",
                                severity=SeverityLevel.HIGH,
                                title="Prompt Injection in MCP Tool Description",
                                description=(
                                    f"Tool '{name}' has a description containing prompt injection "
                                    "patterns. Malicious tool descriptions can manipulate the LLM "
                                    "into executing unintended actions when it reads tool metadata."
                                ),
                                affected_endpoint=url,
                                evidence=f"Tool '{name}' description matched injection patterns: {matched[:3]}",
                                remediation=(
                                    "1. Audit all MCP tool descriptions for injected instructions. "
                                    "2. Sanitize tool metadata before exposing to the LLM. "
                                    "3. Use allowlists for tool descriptions rather than freeform text. "
                                    "4. Implement content security policies for tool registrations."
                                ),
                                cwe_id="CWE-94",
                                cvss_score=8.1,
                                references=[
                                    "https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks"
                                ],
                            ))

                except (json.JSONDecodeError, Exception):
                    continue

        return findings

    async def _check_schema_poisoning(self, target_url: str) -> list[Finding]:
        """Check MCP tool schemas for prototype pollution / poisoning vectors."""
        findings = []
        tool_list_endpoints = ["/api/tools/list", "/api/mcp/tools", "/tools", "/mcp/tools"]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in tool_list_endpoints:
                try:
                    url = f"{target_url.rstrip('/')}{endpoint}"
                    response = await client.get(url)
                    if response.status_code != 200:
                        continue

                    data = response.json()
                    tools = self._extract_tools_from_response(data)

                    for tool in tools:
                        name = tool.get("name", "<unknown>")
                        schema = tool.get("inputSchema", tool.get("parameters", {}))
                        if not isinstance(schema, dict):
                            continue

                        schema_str = json.dumps(schema)
                        issues = []

                        # Check for prototype pollution keys in property names
                        for indicator in SecurityPayloads.MCP_SCHEMA_POISONING_INDICATORS:
                            if indicator in schema_str:
                                issues.append(f"contains '{indicator}' property")

                        # Check for overly permissive schemas
                        if schema.get("additionalProperties") is True:
                            issues.append("allows additionalProperties")

                        # Check for unconstrained object type (no properties defined)
                        if (
                            schema.get("type") == "object"
                            and not schema.get("properties")
                            and schema.get("additionalProperties") is not False
                        ):
                            issues.append("unconstrained object type (no properties defined)")

                        if issues:
                            findings.append(Finding(
                                id="MCP-007",
                                severity=SeverityLevel.MEDIUM,
                                title="MCP Tool Schema Poisoning Risk",
                                description=(
                                    f"Tool '{name}' has a schema that may be vulnerable to "
                                    "poisoning or prototype pollution attacks. Overly permissive "
                                    "schemas allow attackers to inject unexpected parameters."
                                ),
                                affected_endpoint=url,
                                evidence=f"Tool '{name}' schema issues: {'; '.join(issues)}",
                                remediation=(
                                    "1. Define explicit properties for all tool input schemas. "
                                    "2. Set additionalProperties to false. "
                                    "3. Avoid __proto__, constructor, or prototype as parameter names. "
                                    "4. Validate tool inputs against strict JSON schemas at runtime."
                                ),
                                cwe_id="CWE-1321",
                                cvss_score=6.5,
                            ))

                except (json.JSONDecodeError, Exception):
                    continue

        return findings

    async def _check_capability_escalation(self, target_url: str) -> list[Finding]:
        """Flag tools with privileged capabilities or excessive tool counts."""
        findings = []
        tool_list_endpoints = ["/api/tools/list", "/api/mcp/tools", "/tools", "/mcp/tools"]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in tool_list_endpoints:
                try:
                    url = f"{target_url.rstrip('/')}{endpoint}"
                    response = await client.get(url)
                    if response.status_code != 200:
                        continue

                    data = response.json()
                    tools = self._extract_tools_from_response(data)

                    if not tools:
                        continue

                    # Check for excessive number of tools (attack surface)
                    if len(tools) > 15:
                        findings.append(Finding(
                            id="MCP-008",
                            severity=SeverityLevel.HIGH,
                            title="Excessive MCP Tool Surface Area",
                            description=(
                                f"Agent exposes {len(tools)} MCP tools. A large number of tools "
                                "increases the attack surface and makes it harder to audit "
                                "security boundaries. Agents should follow the principle of "
                                "least privilege."
                            ),
                            affected_endpoint=url,
                            evidence=f"{len(tools)} tools exposed (threshold: 15)",
                            remediation=(
                                "1. Reduce tool count to only those required for the agent's purpose. "
                                "2. Use role-based tool access to limit exposure per user. "
                                "3. Implement dynamic tool loading instead of exposing all tools. "
                                "4. Audit each tool's necessity regularly."
                            ),
                            cwe_id="CWE-250",
                            cvss_score=7.2,
                        ))

                    # Check individual tools for privileged capabilities
                    for tool in tools:
                        name = tool.get("name", "")
                        desc = tool.get("description", "")
                        combined = f"{name} {desc}".lower()

                        matched = [
                            kw for kw in SecurityPayloads.MCP_PRIVILEGED_KEYWORDS
                            if kw in combined
                        ]
                        if matched:
                            findings.append(Finding(
                                id="MCP-008",
                                severity=SeverityLevel.HIGH,
                                title="Privileged MCP Tool Capability Detected",
                                description=(
                                    f"Tool '{name}' appears to have privileged or destructive "
                                    "capabilities. Exposing such tools to an LLM without strict "
                                    "authorization controls risks unintended privilege escalation."
                                ),
                                affected_endpoint=url,
                                evidence=f"Tool '{name}' matched privileged keywords: {matched}",
                                remediation=(
                                    "1. Require explicit user confirmation for privileged operations. "
                                    "2. Implement multi-factor authorization for destructive tools. "
                                    "3. Log all invocations of privileged tools. "
                                    "4. Consider removing privileged tools from agent-accessible sets."
                                ),
                                cwe_id="CWE-250",
                                cvss_score=8.4,
                            ))

                except (json.JSONDecodeError, Exception):
                    continue

        return findings
