"""
Core Scanner Engine
Orchestrates vulnerability scanning
"""

import asyncio
import contextlib
import logging
from datetime import datetime, timezone
from uuid import uuid4

import httpx

from scanner_worker.security.checkers.auth import AuthenticationChecker
from scanner_worker.security.checkers.canary_tokens import CanaryTokenChecker
from scanner_worker.security.checkers.config_security import ConfigSecurityChecker
from scanner_worker.security.checkers.data_exfiltration import DataExfiltrationChecker
from scanner_worker.security.checkers.excessive_agency import ExcessiveAgencyChecker
from scanner_worker.security.checkers.mcp_security import MCPSecurityChecker
from scanner_worker.security.checkers.prompt_injection import PromptInjectionChecker
from scanner_worker.security.checkers.ssrf import SSRFChecker
from scanner_worker.security.checkers.tool_execution import ToolExecutionChecker
from scanner_worker.security.checkers.typosquatting import TyposquattingChecker
from scanner_worker.security.http_utils import resilient_get
from scanner_worker.security.models import (
    Finding,
    ScanInputType,
    ScanRequest,
    ScanResult,
    ScanType,
    SeverityLevel,
)

logger = logging.getLogger("agentguard.scanner")


class VulnerabilityScanner:
    """Main scanner engine"""

    def __init__(self) -> None:
        self.timeout = 30.0

        # Initialize all checkers
        self.prompt_injection_checker = PromptInjectionChecker(timeout=self.timeout)
        self.auth_checker = AuthenticationChecker(timeout=self.timeout)
        self.mcp_checker = MCPSecurityChecker(timeout=self.timeout)
        self.ssrf_checker = SSRFChecker(timeout=10.0)
        self.tool_execution_checker = ToolExecutionChecker(timeout=self.timeout)
        self.config_checker = ConfigSecurityChecker(timeout=self.timeout)
        self.data_exfiltration_checker = DataExfiltrationChecker(timeout=self.timeout)
        self.typosquatting_checker = TyposquattingChecker(timeout=self.timeout)
        self.excessive_agency_checker = ExcessiveAgencyChecker(timeout=self.timeout)
        self.canary_token_checker = CanaryTokenChecker(timeout=self.timeout)

    async def scan(self, request: ScanRequest) -> ScanResult:
        """
        Execute a complete security scan

        Args:
            request: Scan configuration

        Returns:
            Complete scan results with findings
        """
        paste_types = {ScanInputType.PASTE, ScanInputType.PASTE_MD, ScanInputType.PASTE_SKILL}
        if request.scan_input_type in paste_types:
            return await self._scan_paste(request)
        return await self._scan_url(request)

    async def _scan_url(self, request: ScanRequest) -> ScanResult:
        """Execute a URL-based security scan."""
        scan_id = f"scan-{uuid4().hex[:12]}"
        scan_started = datetime.now(timezone.utc)

        # Detect framework
        framework = await self._detect_framework(str(request.target_url))

        # Run all vulnerability checks
        findings = await self._run_checks(str(request.target_url), request.scan_type, request.checks)

        scan_completed = datetime.now(timezone.utc)
        duration = (scan_completed - scan_started).total_seconds()

        return ScanResult(
            scan_id=scan_id,
            target_url=str(request.target_url),
            scan_input_type=ScanInputType.URL,
            agent_name=request.agent_name,
            framework=framework,
            scan_type=request.scan_type,
            findings=findings,
            scan_started=scan_started,
            scan_completed=scan_completed,
            duration_seconds=duration
        )

    async def _scan_paste(self, request: ScanRequest) -> ScanResult:
        """Execute a paste-based content analysis.

        Routes to the appropriate analyzer based on scan_input_type.
        For generic PASTE type, auto-detects content and upgrades the type.
        """
        scan_id = f"scan-{uuid4().hex[:12]}"
        scan_started = datetime.now(timezone.utc)

        effective_type = request.scan_input_type
        content = request.paste_content
        assert content is not None, "paste_content must not be None for PASTE scan types"

        # Auto-detect content type when generic PASTE
        if effective_type == ScanInputType.PASTE:
            effective_type = self._detect_paste_type(content)

        findings: list[Finding]
        if effective_type == ScanInputType.PASTE_MD:
            from scanner_worker.security.analyzers.agent_config import (
                AgentConfigAnalyzer,
            )

            findings = await AgentConfigAnalyzer().analyze(content)
            framework = "agent-config-analysis"
        elif effective_type == ScanInputType.PASTE_SKILL:
            from scanner_worker.security.analyzers.skill import SkillAnalyzer

            findings = await SkillAnalyzer().analyze(content)
            framework = "skill-definition-analysis"
        else:
            from scanner_worker.security.analyzers.paste import PasteAnalyzer

            findings = await PasteAnalyzer().analyze(content)
            framework = "paste-analysis"

        scan_completed = datetime.now(timezone.utc)
        duration = (scan_completed - scan_started).total_seconds()

        return ScanResult(
            scan_id=scan_id,
            target_url=None,
            scan_input_type=effective_type,
            agent_name=request.agent_name,
            framework=framework,
            scan_type=request.scan_type,
            findings=findings,
            scan_started=scan_started,
            scan_completed=scan_completed,
            duration_seconds=duration
        )

    @staticmethod
    def _detect_paste_type(content: str) -> ScanInputType:
        """Sniff paste content and determine the most appropriate scan type.

        Returns PASTE_MD for markdown agent configs, PASTE_SKILL for JSON/YAML
        tool definitions, or PASTE for generic content.
        """
        import json as _json

        import yaml as _yaml

        trimmed = content.strip()

        # Check for JSON/YAML tool definition structure first
        parsed = None
        try:
            parsed = _json.loads(trimmed)
        except (ValueError, _json.JSONDecodeError):
            with contextlib.suppress(_yaml.YAMLError):
                parsed = _yaml.safe_load(trimmed)

        if isinstance(parsed, dict):
            tool_keys = {"tools", "mcpServers", "functions"}
            if tool_keys & set(parsed.keys()):
                return ScanInputType.PASTE_SKILL
            if "name" in parsed and "parameters" in parsed:
                return ScanInputType.PASTE_SKILL

        if isinstance(parsed, list) and parsed:
            first = parsed[0] if isinstance(parsed[0], dict) else {}
            if "name" in first and ("parameters" in first or "description" in first):
                return ScanInputType.PASTE_SKILL

        # Check for markdown / agent config patterns
        agent_keywords = [
            "you are", "your role", "system prompt", "instructions",
            "agent", "assistant", "tool", "never", "refuse",
        ]
        content_lower = trimmed.lower()
        has_markdown_header = trimmed.startswith("#") or "\n## " in trimmed or "\n# " in trimmed
        has_agent_keywords = sum(1 for kw in agent_keywords if kw in content_lower) >= 2

        if has_markdown_header and has_agent_keywords:
            return ScanInputType.PASTE_MD

        return ScanInputType.PASTE

    async def _detect_framework(self, target_url: str) -> str:
        """
        Detect which AI agent framework is running

        Args:
            target_url: URL to check

        Returns:
            Framework name (openclaw, generic, etc.)
        """
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(target_url)

                # Check for OpenClaw signatures
                if "X-OpenClaw-Version" in response.headers:
                    return "openclaw"

                if "openclaw" in response.text.lower():
                    return "openclaw"

                # Check for other frameworks
                if "n8n" in response.text.lower():
                    return "n8n"

                if "windsurf" in response.text.lower():
                    return "windsurf"

        except httpx.TimeoutException:
            logger.warning("Framework detection timed out for %s", target_url)
        except httpx.RequestError as exc:
            logger.warning("Framework detection network error for %s: %s", target_url, exc)
        except Exception:
            logger.error("Unexpected error during framework detection for %s", target_url, exc_info=True)

        return "generic"

    async def _run_checks(
        self,
        target_url: str,
        scan_type: ScanType,
        selected_checks: list[str] | None = None,
    ) -> list[Finding]:
        """
        Run all vulnerability checks

        Args:
            target_url: URL to scan
            scan_type: Type of scan (full, quick, custom)
            selected_checks: For custom scans, list of check names to run

        Returns:
            List of findings
        """
        findings = []

        # Map of check name -> coroutine factory
        all_checks = {
            "exposed_endpoints": lambda: self._check_exposed_endpoints(target_url),
            "authentication": lambda: self.auth_checker.check_all(target_url),
            "secret_leakage": lambda: self._check_secret_leakage(target_url),
            "prompt_injection": lambda: self.prompt_injection_checker.check_all(target_url),
            "mcp_security": lambda: self.mcp_checker.check_all(target_url),
            "ssrf": lambda: self.ssrf_checker.check_all(target_url),
            "tool_execution": lambda: self.tool_execution_checker.check_all(target_url),
            "config_security": lambda: self.config_checker.check_all(target_url),
            "data_exfiltration": lambda: self.data_exfiltration_checker.check_all(target_url),
            "typosquatting": lambda: self.typosquatting_checker.check_all(target_url),
            "excessive_agency": lambda: self.excessive_agency_checker.check_all(target_url),
            "canary_tokens": lambda: self.canary_token_checker.check_all(target_url),
        }

        # Define checks based on scan type
        if scan_type == ScanType.QUICK:
            names = ["exposed_endpoints", "authentication", "secret_leakage", "config_security"]
        elif scan_type == ScanType.CUSTOM and selected_checks:
            names = [n for n in selected_checks if n in all_checks]
        else:
            # FULL or CUSTOM with no selection defaults to all
            names = list(all_checks.keys())

        checks = [all_checks[n]() for n in names]

        # Run all checks in parallel
        results = await asyncio.gather(*checks, return_exceptions=True)

        for result in results:
            if isinstance(result, list):
                findings.extend(result)
            elif isinstance(result, Exception):
                # Log but don't fail scan
                logger.warning("Scanner check failed: %s", result)

        return findings

    async def _check_exposed_endpoints(self, target_url: str) -> list[Finding]:
        """Check for exposed admin/sensitive endpoints"""
        findings = []

        sensitive_paths = [
            "/admin",
            "/api/admin",
            "/config",
            "/metrics",
            "/debug",
        ]

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for path in sensitive_paths:
                try:
                    url = f"{target_url.rstrip('/')}{path}"
                    response = await resilient_get(client, url, follow_redirects=False)

                    # If we get 200, endpoint is exposed
                    if response.status_code == 200:
                        findings.append(Finding(
                            id="EXPOSED-001",
                            severity=SeverityLevel.HIGH,
                            title=f"Exposed Endpoint: {path}",
                            description=f"The endpoint {path} is accessible without authentication",
                            affected_endpoint=url,
                            evidence=f"HTTP {response.status_code} response received",
                            remediation="Implement authentication or restrict access to this endpoint",
                            cwe_id="CWE-306",
                            cvss_score=7.5,
                        ))

                except httpx.TimeoutException:
                    logger.warning("Timeout checking endpoint %s%s", target_url, path)
                except httpx.RequestError as exc:
                    logger.warning("Network error checking endpoint %s%s: %s", target_url, path, exc)
                except Exception:
                    logger.error("Unexpected error checking endpoint %s%s", target_url, path, exc_info=True)

        return findings

    async def _check_secret_leakage(self, target_url: str) -> list[Finding]:
        """Check for leaked secrets in responses"""
        findings = []

        # Common endpoints that might leak secrets
        check_paths = [
            "/",
            "/api/config",
            "/api/env",
            "/api/context",
        ]

        # Patterns for common secrets
        secret_patterns = {
            "OPENAI_API_KEY": r"sk-" r"[A-Za-z0-9]{48}",
            "ANTHROPIC_API_KEY": r"sk-" r"ant-[A-Za-z0-9-]{95}",
            "AWS_ACCESS_KEY": r"AKIA" r"[0-9A-Z]{16}",
            "GITHUB_TOKEN": r"ghp_" r"[A-Za-z0-9]{36}",
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for path in check_paths:
                try:
                    url = f"{target_url.rstrip('/')}{path}"
                    response = await resilient_get(client, url)

                    if response.status_code == 200:
                        # Check for secret patterns in response
                        import re
                        for secret_name, pattern in secret_patterns.items():
                            if re.search(pattern, response.text):
                                findings.append(Finding(
                                    id="SECRET-001",
                                    severity=SeverityLevel.CRITICAL,
                                    title=f"Exposed {secret_name}",
                                    description=f"API key or secret token exposed in response from {path}",
                                    affected_endpoint=url,
                                    evidence=f"{secret_name} pattern detected in response",
                                    remediation="Remove secrets from public endpoints. Use environment variables and never expose in API responses.",
                                    cwe_id="CWE-798",
                                    cvss_score=9.8
                                ))

                except httpx.TimeoutException:
                    logger.warning("Timeout checking secrets at %s%s", target_url, path)
                except httpx.RequestError as exc:
                    logger.warning("Network error checking secrets at %s%s: %s", target_url, path, exc)
                except Exception:
                    logger.error("Unexpected error checking secrets at %s%s", target_url, path, exc_info=True)

        return findings
