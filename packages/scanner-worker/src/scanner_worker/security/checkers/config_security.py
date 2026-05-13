"""
Configuration Security Checks
Scans for exposed configuration files, environment variables, and secrets
"""

import re

import httpx

from scanner_worker.security.models import Finding, SeverityLevel
from scanner_worker.security.payloads import SecurityPayloads


class ConfigSecurityChecker:
    """Checks for exposed configuration and secrets"""

    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout

    async def check_all(self, target_url: str) -> list[Finding]:
        """Run all configuration security checks"""
        findings = []

        # Check for exposed config files
        findings.extend(await self._check_exposed_configs(target_url))

        # Check for environment variable exposure
        findings.extend(await self._check_env_exposure(target_url))

        # Check for secrets in responses
        findings.extend(await self._check_secret_leakage(target_url))

        # Check for debug mode
        findings.extend(await self._check_debug_mode(target_url))

        # Check for exposed git files
        findings.extend(await self._check_git_exposure(target_url))

        return findings

    async def _check_exposed_configs(self, target_url: str) -> list[Finding]:
        """Check for exposed configuration files"""
        findings = []

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False) as client:
            for config_path in SecurityPayloads.SENSITIVE_CONFIG_PATHS:
                try:
                    url = f"{target_url.rstrip('/')}{config_path}"
                    response = await client.get(url)

                    if response.status_code == 200:
                        # File is accessible
                        file_content = response.text
                        has_secrets = False

                        # Check if file contains secrets
                        for _secret_name, pattern in SecurityPayloads.SECRET_PATTERNS.items():
                            if re.search(pattern, file_content):
                                has_secrets = True
                                break

                        # Also check for sensitive keywords
                        sensitive_keywords = [
                            "password", "api_key", "secret", "token", "credential",
                            "private_key", "access_key", "auth"
                        ]
                        has_sensitive = any(kw in file_content.lower() for kw in sensitive_keywords)

                        if has_secrets or has_sensitive:
                            severity = SeverityLevel.CRITICAL
                            title = f"Exposed Configuration with Secrets: {config_path}"
                            cvss = 9.8
                        else:
                            severity = SeverityLevel.HIGH
                            title = f"Exposed Configuration File: {config_path}"
                            cvss = 7.5

                        findings.append(Finding(
                            id="CONFIG-001",
                            severity=severity,
                            title=title,
                            description=(
                                f"Configuration file {config_path} is publicly accessible. "
                                + ("This file contains secrets or credentials." if (has_secrets or has_sensitive) else
                                   "This file may contain sensitive system information.")
                            ),
                            affected_endpoint=url,
                            evidence=f"File accessible at {config_path}. Size: {len(file_content)} bytes",
                            remediation=(
                                "1. IMMEDIATELY remove config files from web-accessible directories. "
                                "2. Configure web server to deny access to .env, .json, .yaml, .yml files. "
                                "3. Use .gitignore to prevent config files from being committed. "
                                "4. Store configuration in environment variables or secure vaults (AWS Secrets Manager, HashiCorp Vault). "
                                "5. Rotate any exposed credentials immediately. "
                                "6. Add Content-Security-Policy headers to prevent file downloads."
                            ),
                            cwe_id="CWE-552",  # Files Accessible to External Parties
                            cvss_score=cvss
                        ))

                except Exception:
                    continue

        return findings

    async def _check_env_exposure(self, target_url: str) -> list[Finding]:
        """Check for environment variable exposure"""
        findings = []

        env_endpoints = [
            "/api/env",
            "/api/environment",
            "/env",
            "/environment",
            "/.env",
            "/api/config/env",
            "/debug/env",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in env_endpoints:
                try:
                    url = f"{target_url.rstrip('/')}{endpoint}"
                    response = await client.get(url)

                    if response.status_code == 200:
                        response_text = response.text

                        # Check if response looks like environment variables
                        env_indicators = [
                            "PATH=",
                            "HOME=",
                            "USER=",
                            "_KEY=",
                            "_TOKEN=",
                            "_SECRET=",
                        ]

                        is_env_data = any(indicator in response_text for indicator in env_indicators)

                        if is_env_data:
                            # Check for secrets in environment
                            has_secrets = False
                            found_secrets = []

                            for secret_name, pattern in SecurityPayloads.SECRET_PATTERNS.items():
                                if re.search(pattern, response_text):
                                    has_secrets = True
                                    found_secrets.append(secret_name)

                            findings.append(Finding(
                                id="CONFIG-002",
                                severity=SeverityLevel.CRITICAL,
                                title="Environment Variables Exposed",
                                description=(
                                    "Environment variables are accessible without authentication. "
                                    + (f"Found secrets: {', '.join(found_secrets)}. " if has_secrets else "")
                                    + "This exposes API keys, credentials, and system paths."
                                ),
                                affected_endpoint=url,
                                evidence=f"Environment variables exposed at {endpoint}",
                                remediation=(
                                    "1. CRITICAL: Disable /env and /environment endpoints immediately. "
                                    "2. Never expose environment variables via HTTP endpoints. "
                                    "3. Rotate all exposed credentials. "
                                    "4. Implement authentication for any debug endpoints. "
                                    "5. Use secret management services instead of environment variables for production."
                                ),
                                cwe_id="CWE-526",  # Information Exposure Through Environment Variables
                                cvss_score=10.0 if has_secrets else 8.2
                            ))

                except Exception:
                    continue

        return findings

    async def _check_secret_leakage(self, target_url: str) -> list[Finding]:
        """Check for secrets leaked in common endpoints"""
        findings = []

        # Endpoints to check
        check_endpoints = [
            "/",
            "/api/status",
            "/api/health",
            "/api/info",
            "/health",
            "/status",
            "/info",
            "/api/config",
            "/config",
            "/api/context",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in check_endpoints:
                try:
                    url = f"{target_url.rstrip('/')}{endpoint}"
                    response = await client.get(url)

                    if response.status_code == 200:
                        response_text = response.text
                        found_secrets = {}

                        # Check for each secret pattern
                        for secret_name, pattern in SecurityPayloads.SECRET_PATTERNS.items():
                            matches = re.finditer(pattern, response_text)
                            match_list = list(matches)
                            if match_list:
                                found_secrets[secret_name] = len(match_list)

                        if found_secrets:
                            findings.append(Finding(
                                id="CONFIG-003",
                                severity=SeverityLevel.CRITICAL,
                                title="API Keys/Secrets Leaked in Response",
                                description=(
                                    f"Secrets detected in HTTP response from {endpoint}. "
                                    f"Found: {', '.join(f'{k} ({v}x)' for k, v in found_secrets.items())}. "
                                    f"These credentials can be used to access external services and APIs."
                                ),
                                affected_endpoint=url,
                                evidence=f"Secrets found: {list(found_secrets.keys())}",
                                remediation=(
                                    "1. CRITICAL: Rotate all exposed API keys immediately. "
                                    "2. Remove secrets from all HTTP responses. "
                                    "3. Never log or return secrets in API responses. "
                                    "4. Implement output filtering to detect accidental secret exposure. "
                                    "5. Use secret scanning tools in CI/CD (git-secrets, truffleHog). "
                                    "6. Store secrets in secure vaults, not in code or config files."
                                ),
                                cwe_id="CWE-798",  # Use of Hard-coded Credentials
                                cvss_score=10.0,
                                references=[
                                    "https://owasp.org/www-community/vulnerabilities/Use_of_hard-coded_password"
                                ]
                            ))

                except Exception:
                    continue

        return findings

    async def _check_debug_mode(self, target_url: str) -> list[Finding]:
        """Check if debug mode is enabled"""
        findings = []

        debug_endpoints = [
            "/debug",
            "/debug/vars",
            "/__debug__",
            "/api/debug",
            "/_debug",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            # Check debug endpoints
            for endpoint in debug_endpoints:
                try:
                    url = f"{target_url.rstrip('/')}{endpoint}"
                    response = await client.get(url)

                    if response.status_code == 200:
                        findings.append(Finding(
                            id="CONFIG-004",
                            severity=SeverityLevel.HIGH,
                            title="Debug Mode Enabled",
                            description=(
                                f"Debug endpoint {endpoint} is accessible in production. "
                                "Debug mode exposes internal application state, variables, "
                                "stack traces, and potentially sensitive information."
                            ),
                            affected_endpoint=url,
                            evidence=f"Debug endpoint accessible: {endpoint}",
                            remediation=(
                                "1. Disable debug mode in production environments. "
                                "2. Remove or protect debug endpoints with authentication. "
                                "3. Use environment-specific configuration (DEBUG=false in prod). "
                                "4. Implement IP whitelisting for any required debug access. "
                                "5. Never deploy with DEBUG=true or development settings."
                            ),
                            cwe_id="CWE-489",  # Active Debug Code
                            cvss_score=7.5
                        ))

                except Exception:
                    continue

            # Check for debug indicators in normal responses
            try:
                response = await client.get(target_url)
                if response.status_code == 200:
                    response_lower = response.text.lower()

                    debug_indicators = [
                        "traceback",
                        "stacktrace",
                        "debug mode",
                        "development mode",
                        "django debug",
                        "flask debugger",
                    ]

                    if any(indicator in response_lower for indicator in debug_indicators):
                        findings.append(Finding(
                            id="CONFIG-005",
                            severity=SeverityLevel.MEDIUM,
                            title="Debug Information in Responses",
                            description=(
                                "Application responses contain debug information (stack traces, "
                                "error details). This reveals internal application structure "
                                "and may aid attackers in exploitation."
                            ),
                            affected_endpoint=target_url,
                            evidence="Debug indicators found in response",
                            remediation=(
                                "1. Configure custom error pages for production. "
                                "2. Suppress detailed error messages. "
                                "3. Log errors server-side instead of displaying to users. "
                                "4. Set DEBUG=false and use production error handlers."
                            ),
                            cwe_id="CWE-209",  # Information Exposure Through Error Message
                            cvss_score=5.3
                        ))

            except Exception:
                pass

        return findings

    async def _check_git_exposure(self, target_url: str) -> list[Finding]:
        """Check for exposed .git directory"""
        findings = []

        git_paths = [
            "/.git/config",
            "/.git/HEAD",
            "/.git/logs/HEAD",
            "/.git/index",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False) as client:
            for git_path in git_paths:
                try:
                    url = f"{target_url.rstrip('/')}{git_path}"
                    response = await client.get(url)

                    if response.status_code == 200:
                        findings.append(Finding(
                            id="CONFIG-006",
                            severity=SeverityLevel.HIGH,
                            title="Exposed .git Directory",
                            description=(
                                "The .git directory is publicly accessible, exposing version control "
                                "history, source code, commit messages, and potentially secrets. "
                                "Attackers can download the entire repository including deleted files "
                                "and historical commits."
                            ),
                            affected_endpoint=url,
                            evidence=f"Git file accessible: {git_path}",
                            remediation=(
                                "1. IMMEDIATELY block access to .git directory via web server config. "
                                "2. Add this to nginx: location ~ /\\.git { deny all; } "
                                "3. Or Apache: RedirectMatch 404 /\\.git "
                                "4. Never deploy .git directories to production servers. "
                                "5. Use .gitignore to prevent sensitive files from being tracked. "
                                "6. Scan git history for accidentally committed secrets and rotate them."
                            ),
                            cwe_id="CWE-538",  # File and Directory Information Exposure
                            cvss_score=8.6,
                            references=[
                                "https://en.internetwache.org/dont-publicly-expose-git-or-how-we-downloaded-your-websites-sourcecode-an-analysis-of-alexas-1m-28-07-2015/"
                            ]
                        ))
                        break  # Found .git exposure, no need to check more

                except Exception:
                    continue

        return findings
