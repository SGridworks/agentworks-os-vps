"""
Skill/tool definition analyzer for JSON and YAML tool configurations.

Scans MCP server configs, OpenAI function calling schemas, and other
structured tool definitions for security misconfigurations.
"""

from __future__ import annotations

import json
import re
from typing import Any

import yaml

from scanner_worker.security.models import Finding, SeverityLevel


class SkillAnalyzer:
    """Analyzes JSON/YAML tool/skill definitions for security issues."""

    async def analyze(self, content: str) -> list[Finding]:
        """Parse content and run all skill definition checks."""
        parsed = self._parse_content(content)
        if parsed is None:
            return []

        tools = self._normalize_tools(parsed)
        if not tools:
            return []

        findings: list[Finding] = []
        findings.extend(self._check_dangerous_tools(tools))
        findings.extend(self._check_missing_input_constraints(tools))
        findings.extend(self._check_ssrf_vectors(tools))
        findings.extend(self._check_command_injection(tools))
        findings.extend(self._check_path_traversal(tools))
        findings.extend(self._check_missing_descriptions(tools))
        findings.extend(self._check_excessive_scope(tools))
        findings.extend(self._check_missing_auth(parsed))
        return findings

    def _parse_content(self, content: str) -> dict[str, Any] | list[Any] | None:
        """Try to parse content as JSON first, then YAML."""
        content = content.strip()
        if not content:
            return None

        # Try JSON first
        try:
            parsed_content = json.loads(content)
            assert isinstance(parsed_content, (dict, list))
            return parsed_content
        except (json.JSONDecodeError, ValueError, AssertionError):
            pass

        # Fall back to YAML
        try:
            result = yaml.safe_load(content)
            if isinstance(result, (dict, list)):
                return result
        except yaml.YAMLError:
            pass

        return None

    def _normalize_tools(self, parsed: dict[str, Any] | list[Any]) -> list[dict[str, Any]]:
        """Normalize different tool definition formats into a flat list.

        Handles:
        - MCP format: {"mcpServers": {"name": {"command": ..., "tools": [...]}}}
        - OpenAI format: {"tools": [{"type": "function", "function": {...}}]}
        - Flat list: [{"name": ..., "description": ..., "parameters": ...}]
        - Single tool dict: {"name": ..., "description": ...}
        """
        tools: list[dict[str, Any]] = []

        if isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict):
                    tools.append(item)
            return tools

        if not isinstance(parsed, dict):
            return tools

        # MCP format: {"mcpServers": {...}}
        if "mcpServers" in parsed:
            for _server_name, server_config in parsed["mcpServers"].items():
                if isinstance(server_config, dict):
                    # The server config itself is a tool-like definition
                    tools.append(server_config)
                    # Also extract nested tools if present
                    if "tools" in server_config and isinstance(server_config["tools"], list):
                        for tool in server_config["tools"]:
                            if isinstance(tool, dict):
                                tools.append(tool)
            return tools

        # OpenAI format: {"tools": [{"type": "function", "function": {...}}]}
        if "tools" in parsed and isinstance(parsed["tools"], list):
            for tool in parsed["tools"]:
                if isinstance(tool, dict):
                    # OpenAI nested function format
                    if "function" in tool and isinstance(tool["function"], dict):
                        tools.append(tool["function"])
                    else:
                        tools.append(tool)
            return tools

        # {"functions": [...]} format
        if "functions" in parsed and isinstance(parsed["functions"], list):
            for func in parsed["functions"]:
                if isinstance(func, dict):
                    tools.append(func)
            return tools

        # Single tool dict with name+parameters
        if "name" in parsed and "parameters" in parsed:
            tools.append(parsed)
            return tools

        return tools

    def _get_tool_text(self, tool: dict[str, Any]) -> str:
        """Get searchable text from a tool definition (name + description)."""
        parts = []
        for key in ("name", "description", "command"):
            val = tool.get(key, "")
            if isinstance(val, str):
                parts.append(val)
        return " ".join(parts).lower()

    def _get_parameters(self, tool: dict[str, Any]) -> dict[str, Any]:
        """Extract parameter definitions from a tool."""
        params = tool.get("parameters", tool.get("inputSchema", {}))
        if isinstance(params, dict):
            props = params.get("properties", {})
            if isinstance(props, dict):
                return props
        return {}

    def _check_dangerous_tools(self, tools: list[dict[str, Any]]) -> list[Finding]:
        """Detect tool names/descriptions containing dangerous execution keywords."""
        findings: list[Finding] = []
        dangerous_keywords = [
            r"\bshell\b", r"\bbash\b", r"\bexec\b", r"\beval\b",
            r"\bsystem\b", r"\bsubprocess\b", r"\brm\b", r"\bdelete\b",
            r"\bdrop\b",
        ]

        for tool in tools:
            text = self._get_tool_text(tool)
            for pattern in dangerous_keywords:
                if re.search(pattern, text):
                    tool_name = tool.get("name", tool.get("command", "unknown"))
                    findings.append(Finding(
                        id="SKILL-DANGER-001",
                        severity=SeverityLevel.CRITICAL,
                        title=f"Dangerous Tool: {tool_name}",
                        description=(
                            f"Tool '{tool_name}' contains dangerous execution keywords "
                            f"({pattern.strip(chr(92)).strip('b')}) in its name or description. "
                            "This tool could enable arbitrary code or command execution."
                        ),
                        affected_endpoint="tool definition",
                        evidence=f"Dangerous keyword in tool: {tool_name}",
                        remediation=(
                            "Replace dangerous tools with safer, scoped alternatives. "
                            "If shell access is required, use sandboxed execution with "
                            "strict allowlists for permitted commands."
                        ),
                        cwe_id="CWE-78",
                        cvss_score=9.8,
                    ))
                    break  # One finding per tool
        return findings

    def _check_missing_input_constraints(self, tools: list[dict[str, Any]]) -> list[Finding]:
        """Detect string parameters without enum, pattern, or maxLength constraints."""
        findings: list[Finding] = []

        for tool in tools:
            params = self._get_parameters(tool)
            unconstrained = []
            for param_name, param_def in params.items():
                if not isinstance(param_def, dict):
                    continue
                if param_def.get("type") == "string":
                    has_constraint = any(
                        k in param_def for k in ("enum", "pattern", "maxLength", "const", "format")
                    )
                    if not has_constraint:
                        unconstrained.append(param_name)

            if unconstrained:
                tool_name = tool.get("name", "unknown")
                findings.append(Finding(
                    id="SKILL-INPUT-001",
                    severity=SeverityLevel.HIGH,
                    title=f"Unconstrained String Parameters in '{tool_name}'",
                    description=(
                        f"Tool '{tool_name}' has string parameters without input constraints "
                        f"(enum, pattern, maxLength): {', '.join(unconstrained)}. "
                        "Unconstrained inputs are more susceptible to injection attacks."
                    ),
                    affected_endpoint="tool definition",
                    evidence=f"Unconstrained params: {', '.join(unconstrained)}",
                    remediation=(
                        "Add input constraints to string parameters: use 'enum' for "
                        "known values, 'pattern' for format validation, or 'maxLength' "
                        "to limit input size."
                    ),
                    cwe_id="CWE-20",
                    cvss_score=7.0,
                ))
        return findings

    def _check_ssrf_vectors(self, tools: list[dict[str, Any]]) -> list[Finding]:
        """Detect URL-type parameters without domain restrictions."""
        findings: list[Finding] = []
        url_param_names = {"url", "endpoint", "href", "uri", "webhook_url", "callback_url"}

        for tool in tools:
            params = self._get_parameters(tool)
            risky_params = []
            for param_name, param_def in params.items():
                if not isinstance(param_def, dict):
                    continue
                if param_name.lower() in url_param_names:
                    desc = str(param_def.get("description", "")).lower()
                    has_restriction = any(
                        kw in desc for kw in ("domain", "allowlist", "whitelist", "restricted")
                    )
                    has_pattern = "pattern" in param_def
                    if not has_restriction and not has_pattern:
                        risky_params.append(param_name)

            if risky_params:
                tool_name = tool.get("name", "unknown")
                findings.append(Finding(
                    id="SKILL-SSRF-001",
                    severity=SeverityLevel.HIGH,
                    title=f"SSRF Vector in '{tool_name}'",
                    description=(
                        f"Tool '{tool_name}' accepts URL parameters ({', '.join(risky_params)}) "
                        "without documented domain restrictions. An attacker could supply "
                        "internal network URLs to perform SSRF attacks."
                    ),
                    affected_endpoint="tool definition",
                    evidence=f"Unrestricted URL params: {', '.join(risky_params)}",
                    remediation=(
                        "Add domain allowlists or URL validation patterns to URL "
                        "parameters. Block private IP ranges and cloud metadata endpoints."
                    ),
                    cwe_id="CWE-918",
                    cvss_score=8.0,
                ))
        return findings

    def _check_command_injection(self, tools: list[dict[str, Any]]) -> list[Finding]:
        """Detect command/script parameters flowing into execution tools."""
        findings: list[Finding] = []
        cmd_param_names = {"command", "cmd", "script", "query", "shell", "code", "expression"}

        for tool in tools:
            params = self._get_parameters(tool)
            risky_params = [
                p for p in params if p.lower() in cmd_param_names
            ]

            if risky_params:
                tool_name = tool.get("name", "unknown")
                findings.append(Finding(
                    id="SKILL-CMDINJ-001",
                    severity=SeverityLevel.CRITICAL,
                    title=f"Command Injection Risk in '{tool_name}'",
                    description=(
                        f"Tool '{tool_name}' accepts parameters named "
                        f"{', '.join(risky_params)} which could be used for command "
                        "injection if passed to a shell or interpreter."
                    ),
                    affected_endpoint="tool definition",
                    evidence=f"Command-like params: {', '.join(risky_params)}",
                    remediation=(
                        "Avoid accepting raw command strings. Use parameterized APIs, "
                        "restrict allowed values with enums, or implement strict input "
                        "validation and sandboxed execution."
                    ),
                    cwe_id="CWE-78",
                    cvss_score=9.5,
                ))
        return findings

    def _check_path_traversal(self, tools: list[dict[str, Any]]) -> list[Finding]:
        """Detect file path parameters without documented restrictions."""
        findings: list[Finding] = []
        path_param_names = {"path", "file", "filepath", "file_path", "directory", "dir", "filename"}

        for tool in tools:
            params = self._get_parameters(tool)
            risky_params = []
            for param_name, param_def in params.items():
                if not isinstance(param_def, dict):
                    continue
                if param_name.lower() in path_param_names:
                    desc = str(param_def.get("description", "")).lower()
                    has_restriction = any(
                        kw in desc
                        for kw in ("restricted", "sandbox", "allowed", "within", "base_dir")
                    )
                    has_pattern = "pattern" in param_def
                    if not has_restriction and not has_pattern:
                        risky_params.append(param_name)

            if risky_params:
                tool_name = tool.get("name", "unknown")
                findings.append(Finding(
                    id="SKILL-PATH-001",
                    severity=SeverityLevel.HIGH,
                    title=f"Path Traversal Risk in '{tool_name}'",
                    description=(
                        f"Tool '{tool_name}' accepts file path parameters "
                        f"({', '.join(risky_params)}) without documented restrictions. "
                        "This could allow path traversal attacks to access arbitrary files."
                    ),
                    affected_endpoint="tool definition",
                    evidence=f"Unrestricted path params: {', '.join(risky_params)}",
                    remediation=(
                        "Restrict file path parameters to a specific base directory. "
                        "Validate paths to prevent traversal (../) and reject absolute paths."
                    ),
                    cwe_id="CWE-22",
                    cvss_score=7.5,
                ))
        return findings

    def _check_missing_descriptions(self, tools: list[dict[str, Any]]) -> list[Finding]:
        """Detect tools with empty or missing description fields."""
        findings: list[Finding] = []

        for tool in tools:
            name = tool.get("name", tool.get("command", ""))
            if not name:
                continue
            desc = tool.get("description", "")
            if not desc or (isinstance(desc, str) and not desc.strip()):
                findings.append(Finding(
                    id="SKILL-DESC-001",
                    severity=SeverityLevel.LOW,
                    title=f"Missing Description for Tool '{name}'",
                    description=(
                        f"Tool '{name}' has no description. Without a clear description, "
                        "the AI model may misuse the tool or invoke it in unintended contexts."
                    ),
                    affected_endpoint="tool definition",
                    evidence=f"Tool '{name}' has empty or missing description",
                    remediation=(
                        "Add a clear, detailed description to every tool definition "
                        "that explains what the tool does, its expected inputs, and "
                        "any limitations."
                    ),
                    cwe_id="CWE-1059",
                    cvss_score=2.0,
                ))
        return findings

    def _check_excessive_scope(self, tools: list[dict[str, Any]]) -> list[Finding]:
        """Detect tools with too many parameters or overly broad descriptions."""
        findings: list[Finding] = []

        for tool in tools:
            params = self._get_parameters(tool)
            tool_name = tool.get("name", "unknown")
            text = self._get_tool_text(tool)

            too_many_params = len(params) > 5
            broad_language = bool(re.search(r"\bany\b|\ball\b", text))

            if too_many_params or broad_language:
                reason = []
                if too_many_params:
                    reason.append(f"{len(params)} parameters (>5)")
                if broad_language:
                    reason.append("overly broad language ('any'/'all') in description")
                findings.append(Finding(
                    id="SKILL-SCOPE-001",
                    severity=SeverityLevel.MEDIUM,
                    title=f"Excessive Scope in Tool '{tool_name}'",
                    description=(
                        f"Tool '{tool_name}' has excessive scope: {'; '.join(reason)}. "
                        "Overly broad tools increase the attack surface and are harder to audit."
                    ),
                    affected_endpoint="tool definition",
                    evidence=f"Excessive scope: {'; '.join(reason)}",
                    remediation=(
                        "Break large tools into smaller, focused tools with fewer "
                        "parameters. Replace broad descriptions with specific, scoped language."
                    ),
                    cwe_id="CWE-250",
                    cvss_score=5.0,
                ))
        return findings

    def _check_missing_auth(self, parsed: dict[str, Any] | list[Any]) -> list[Finding]:
        """Detect MCP server configs without authentication fields."""
        findings: list[Finding] = []

        if not isinstance(parsed, dict):
            return findings

        servers = parsed.get("mcpServers", {})
        if not isinstance(servers, dict):
            return findings

        auth_keywords = {"auth", "token", "apikey", "api_key", "authorization", "secret", "key"}

        for server_name, config in servers.items():
            if not isinstance(config, dict):
                continue
            config_keys = {k.lower() for k in config}
            config_str = json.dumps(config).lower()

            has_auth = (
                bool(config_keys & auth_keywords)
                or any(kw in config_str for kw in auth_keywords)
            )

            if not has_auth:
                findings.append(Finding(
                    id="SKILL-AUTH-001",
                    severity=SeverityLevel.HIGH,
                    title=f"Missing Auth for MCP Server '{server_name}'",
                    description=(
                        f"MCP server '{server_name}' has no authentication configuration "
                        "(no auth, token, apiKey, or authorization fields). Unauthenticated "
                        "server connections can be intercepted or spoofed."
                    ),
                    affected_endpoint="tool definition",
                    evidence=f"Server '{server_name}' missing authentication fields",
                    remediation=(
                        "Add authentication to the MCP server configuration. Use API keys, "
                        "tokens, or OAuth credentials to secure the connection."
                    ),
                    cwe_id="CWE-306",
                    cvss_score=7.5,
                ))
        return findings
