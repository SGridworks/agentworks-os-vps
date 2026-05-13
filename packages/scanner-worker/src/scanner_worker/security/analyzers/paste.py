"""
Paste-based content analyzer for security scanning without a live URL.
Detects secrets, prompt injection patterns, configuration exposure, and sensitive data.
"""

from __future__ import annotations

import re
from typing import TypedDict

from scanner_worker.security.models import Finding, SeverityLevel
from scanner_worker.security.payloads import SecurityPayloads


class _InjectionIndicator(TypedDict):
    """Typed dict for prompt injection indicators."""
    pattern: str
    title: str
    description: str
    severity: SeverityLevel


class PasteAnalyzer:
    """Analyzes pasted text content for security vulnerabilities."""

    async def analyze(self, content: str) -> list[Finding]:
        """Run all paste-based checks on the provided content."""
        findings: list[Finding] = []
        findings.extend(self._check_secrets(content))
        findings.extend(self._check_prompt_injection_patterns(content))
        findings.extend(self._check_config_exposure(content))
        findings.extend(self._check_sensitive_data(content))
        findings.extend(self._check_typosquatting(content))
        findings.extend(self._check_encoded_content(content))
        return findings

    def _check_secrets(self, content: str) -> list[Finding]:
        """Detect leaked API keys and credentials using regex patterns."""
        findings: list[Finding] = []
        for secret_name, pattern in SecurityPayloads.SECRET_PATTERNS.items():
            matches = re.findall(pattern, content)
            if matches:
                # Mask the matched secret for display
                match_preview = matches[0] if isinstance(matches[0], str) else str(matches[0])
                masked = match_preview[:8] + "..." + match_preview[-4:] if len(match_preview) > 16 else "***"
                findings.append(Finding(
                    id=f"PASTE-SECRET-{secret_name}",
                    severity=SeverityLevel.CRITICAL,
                    title=f"Exposed {secret_name.replace('_', ' ').title()}",
                    description=(
                        f"A {secret_name.replace('_', ' ').lower()} was found in the pasted content. "
                        "This credential could be used by attackers to access your services."
                    ),
                    affected_endpoint="pasted content",
                    evidence=f"Pattern match: {masked}",
                    remediation=(
                        "Immediately rotate this credential. Remove it from any configs or code, "
                        "and store it in environment variables or a secrets manager instead."
                    ),
                    cwe_id="CWE-798",
                    cvss_score=9.8,
                ))
        return findings

    def _check_prompt_injection_patterns(self, content: str) -> list[Finding]:
        """Detect prompt injection indicators in pasted content."""
        findings: list[Finding] = []
        content_lower = content.lower()

        injection_indicators: list[_InjectionIndicator] = [
            {
                "pattern": r"ignore\s+(all\s+)?previous\s+instructions",
                "title": "Prompt Override Attempt Detected",
                "description": "Content contains language attempting to override AI agent instructions.",
                "severity": SeverityLevel.HIGH,
            },
            {
                "pattern": r"\[SYSTEM\]|\[system\]|<<SYS>>|<\|system\|>",
                "title": "Fake System Message Detected",
                "description": "Content contains fake system message tags that could trick an AI agent.",
                "severity": SeverityLevel.HIGH,
            },
            {
                "pattern": r"you\s+are\s+now\s+|act\s+as\s+(if\s+you\s+are\s+|a\s+)?|pretend\s+(to\s+be|you\s+are)",
                "title": "Role Override Attempt Detected",
                "description": "Content contains roleplay/identity override patterns that could hijack agent behavior.",
                "severity": SeverityLevel.MEDIUM,
            },
            {
                "pattern": r"your\s+new\s+objective|your\s+new\s+goal|your\s+new\s+task|disregard\s+(your|all)",
                "title": "Goal Hijacking Attempt Detected",
                "description": "Content attempts to redirect an AI agent's objectives.",
                "severity": SeverityLevel.HIGH,
            },
        ]

        for indicator in injection_indicators:
            if re.search(indicator["pattern"], content_lower):
                findings.append(Finding(
                    id=f"PASTE-INJECTION-{indicator['title'].split()[0].upper()}",
                    severity=indicator["severity"],
                    title=indicator["title"],
                    description=indicator["description"],
                    affected_endpoint="pasted content",
                    evidence="Pattern detected in content",
                    remediation=(
                        "Review this content before feeding it to your AI agent. "
                        "Sanitize or reject inputs containing instruction override patterns."
                    ),
                    cwe_id="CWE-94",
                    cvss_score=8.5 if indicator["severity"] == SeverityLevel.HIGH else 6.0,
                ))

        return findings

    def _check_config_exposure(self, content: str) -> list[Finding]:
        """Detect exposed configuration patterns in pasted content."""
        findings: list[Finding] = []

        # Check for .env file patterns (KEY=VALUE with sensitive key names)
        sensitive_env_keys = [
            "DATABASE_URL", "DB_PASSWORD", "DB_HOST",
            "SECRET_KEY", "API_KEY", "API_SECRET",
            "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
            "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
            "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
            "REDIS_URL", "REDIS_PASSWORD",
            "SMTP_PASSWORD", "EMAIL_PASSWORD",
            "PRIVATE_KEY", "ENCRYPTION_KEY",
        ]

        for key in sensitive_env_keys:
            pattern = rf'{key}\s*[=:]\s*["\']?(\S+)["\']?'
            match = re.search(pattern, content, re.IGNORECASE)
            if match:
                value = match.group(1)
                # Skip if it's a placeholder
                if value.lower() in ("your_key_here", "changeme", "xxx", "***", "${" + key + "}", ""):
                    continue
                findings.append(Finding(
                    id="PASTE-CONFIG-EXPOSURE",
                    severity=SeverityLevel.CRITICAL,
                    title=f"Exposed Configuration: {key}",
                    description=(
                        f"The configuration variable {key} appears to contain a real value. "
                        "Sharing configs with live credentials is a security risk."
                    ),
                    affected_endpoint="pasted content",
                    evidence=f"{key}=***",
                    remediation=(
                        f"Remove the value for {key} before sharing. "
                        "Use environment variables or a secrets manager to store sensitive configuration."
                    ),
                    cwe_id="CWE-200",
                    cvss_score=9.1,
                ))

        # Check for debug mode enabled
        debug_patterns = [
            (r'DEBUG\s*[=:]\s*["\']?(?:true|1|yes|on)["\']?', "Debug Mode Enabled"),
            (r'ENVIRONMENT\s*[=:]\s*["\']?(?:development|dev|staging)["\']?', "Non-Production Environment"),
        ]
        for pattern, title in debug_patterns:
            if re.search(pattern, content, re.IGNORECASE):
                findings.append(Finding(
                    id="PASTE-CONFIG-DEBUG",
                    severity=SeverityLevel.MEDIUM,
                    title=title,
                    description=(
                        "This configuration has debug or development settings enabled. "
                        "Ensure production deployments use production settings."
                    ),
                    affected_endpoint="pasted content",
                    evidence=f"{title} detected",
                    remediation="Set DEBUG=false and ENVIRONMENT=production for production deployments.",
                    cwe_id="CWE-489",
                    cvss_score=5.0,
                ))

        return findings

    def _check_sensitive_data(self, content: str) -> list[Finding]:
        """Detect PII and sensitive data patterns in pasted content."""
        findings: list[Finding] = []

        # Check for internal/private URLs
        private_url_pattern = r'https?://(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})[:/]'
        if re.search(private_url_pattern, content):
            findings.append(Finding(
                id="PASTE-SENSITIVE-INTERNAL-URL",
                severity=SeverityLevel.MEDIUM,
                title="Internal/Private URL Exposed",
                description=(
                    "Content contains URLs pointing to internal or private network addresses. "
                    "Sharing these could reveal your network architecture."
                ),
                affected_endpoint="pasted content",
                evidence="Private/internal URL pattern detected",
                remediation="Remove internal URLs before sharing. Use public-facing URLs or redact network details.",
                cwe_id="CWE-200",
                cvss_score=5.5,
            ))

        # Check for email addresses (potential PII exposure)
        email_pattern = r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
        emails = re.findall(email_pattern, content)
        # Filter out common non-PII emails
        real_emails = [e for e in emails if not e.endswith(("@example.com", "@test.com", "@localhost"))]
        if len(real_emails) > 2:
            findings.append(Finding(
                id="PASTE-SENSITIVE-PII",
                severity=SeverityLevel.LOW,
                title="Multiple Email Addresses Found",
                description=(
                    f"Found {len(real_emails)} email addresses in the pasted content. "
                    "Sharing personal email addresses may violate privacy policies."
                ),
                affected_endpoint="pasted content",
                evidence=f"{len(real_emails)} email addresses detected",
                remediation="Redact email addresses before sharing content publicly.",
                cwe_id="CWE-359",
                cvss_score=3.5,
            ))

        return findings

    def _check_typosquatting(self, content: str) -> list[Finding]:
        """Detect potential typosquatting in pasted dependency lists."""
        from scanner_worker.security.checkers.typosquatting import levenshtein_distance

        findings: list[Finding] = []
        packages: list[str] = []

        # Extract package names from requirements.txt-style content
        for line in content.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("-"):
                continue
            # Match pip-style: package==version or package>=version
            match = re.match(r'^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*[>=<!\[;]', line)
            if match:
                packages.append(match.group(1))
            # Match bare package name (single word on line)
            elif re.match(r'^[a-zA-Z0-9][a-zA-Z0-9._-]*$', line):
                packages.append(line)

        # Also try to parse JSON (package.json content)
        try:
            import json
            data = json.loads(content)
            if isinstance(data, dict):
                for dep_key in ("dependencies", "devDependencies", "peerDependencies"):
                    if dep_key in data and isinstance(data[dep_key], dict):
                        packages.extend(data[dep_key].keys())
        except (json.JSONDecodeError, ValueError):
            pass

        if not packages:
            return findings

        all_known = (
            SecurityPayloads.KNOWN_GOOD_NPM_PACKAGES
            + SecurityPayloads.KNOWN_GOOD_PYPI_PACKAGES
        )
        known_set = {k.lower() for k in all_known}

        for pkg in packages:
            pkg_lower = pkg.lower()
            if pkg_lower in known_set:
                continue

            for known in all_known:
                known_lower = known.lower()
                if abs(len(pkg_lower) - len(known_lower)) > 2:
                    continue
                dist = levenshtein_distance(pkg_lower, known_lower)
                if 1 <= dist <= 2:
                    findings.append(Finding(
                        id="PASTE-TYPOSQUAT-001",
                        severity=SeverityLevel.HIGH,
                        title=f"Possible Typosquatting: '{pkg}'",
                        description=(
                            f"Package '{pkg}' is suspiciously similar to '{known}' "
                            f"(edit distance: {dist}). This could be a typosquatting attack."
                        ),
                        affected_endpoint="pasted content",
                        evidence=f"'{pkg}' is {dist} edit(s) from '{known}'",
                        remediation=(
                            f"Verify that '{pkg}' is the intended package, not '{known}'. "
                            "Check the package registry for publisher info and download counts."
                        ),
                        cwe_id="CWE-829",
                        cvss_score=8.2,
                    ))
                    break

        return findings

    def _check_encoded_content(self, content: str) -> list[Finding]:
        """Detect secrets hidden behind encoding in pasted content.

        Applies recursive decoding and checks if the decoded version matches
        SECRET_PATTERNS while the raw content does not.
        """
        from scanner_worker.security.checkers.data_exfiltration import (
            DataExfiltrationChecker,
        )

        findings: list[Finding] = []
        decoded = DataExfiltrationChecker._recursive_decode(content)

        for secret_name, pattern in SecurityPayloads.SECRET_PATTERNS.items():
            raw_match = re.search(pattern, content)
            decoded_match = re.search(pattern, decoded)

            if decoded_match and not raw_match:
                findings.append(Finding(
                    id="PASTE-ENCODED-001",
                    severity=SeverityLevel.MEDIUM,
                    title=f"Encoded Secret Detected: {secret_name.replace('_', ' ').title()}",
                    description=(
                        f"A {secret_name.replace('_', ' ').lower()} was found in the pasted "
                        "content after decoding (base64, hex, or URL encoding). The secret "
                        "is obfuscated in the raw content but visible after decoding."
                    ),
                    affected_endpoint="pasted content",
                    evidence=f"Secret pattern '{secret_name}' found after recursive decoding",
                    remediation=(
                        "Remove the encoded secret from this content. "
                        "Encoding is not encryption — base64 and hex are trivially reversible. "
                        "Store secrets in a secrets manager, never in encoded form."
                    ),
                    cwe_id="CWE-116",
                    cvss_score=6.5,
                ))
                break  # One finding is enough

        return findings
