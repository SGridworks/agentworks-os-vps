"""
Agent configuration file analyzer for markdown instruction files.

Scans CLAUDE.md, .cursorrules, system prompts, and similar agent configuration
documents for security misconfigurations, overly permissive instructions,
and vulnerability patterns.
"""

import re

from scanner_worker.security.models import Finding, SeverityLevel
from scanner_worker.security.payloads import SecurityPayloads


class AgentConfigAnalyzer:
    """Analyzes markdown/text agent configuration files for security issues."""

    async def analyze(self, content: str) -> list[Finding]:
        """Run all agent config checks on the provided content."""
        findings: list[Finding] = []
        findings.extend(self._check_overly_permissive(content))
        findings.extend(self._check_missing_safety_boundaries(content))
        findings.extend(self._check_privilege_escalation(content))
        findings.extend(self._check_data_exfiltration(content))
        findings.extend(self._check_secrets(content))
        findings.extend(self._check_injection_surface(content))
        findings.extend(self._check_jailbreak_susceptibility(content))
        findings.extend(self._check_unrestricted_tools(content))
        return findings

    def _check_overly_permissive(self, content: str) -> list[Finding]:
        """Detect overly permissive instructions that remove safety guardrails."""
        findings: list[Finding] = []
        content_lower = content.lower()

        permissive_patterns = [
            r"execute\s+any\s+command",
            r"no\s+restrictions",
            r"bypass\s+safety",
            r"do\s+anything\s+(the\s+user|they|you)?\s*(ask|want|request)",
            r"without\s+(any\s+)?limitations",
            r"no\s+safety\s+(rules|guidelines|guardrails)",
            r"comply\s+with\s+(all|any)\s+requests?",
        ]

        for pattern in permissive_patterns:
            if re.search(pattern, content_lower):
                findings.append(Finding(
                    id="MD-PERM-001",
                    severity=SeverityLevel.CRITICAL,
                    title="Overly Permissive Agent Instructions",
                    description=(
                        "The agent configuration contains language that removes safety "
                        "guardrails. An overly permissive agent can be trivially exploited "
                        "to perform unauthorized actions."
                    ),
                    affected_endpoint="agent configuration",
                    evidence=f"Permissive pattern detected: '{pattern}'",
                    remediation=(
                        "Add explicit safety boundaries to the agent instructions. "
                        "Define what the agent should refuse to do, limit its scope, "
                        "and include guardrail keywords (e.g., 'never', 'refuse', 'restricted')."
                    ),
                    cwe_id="CWE-269",
                    cvss_score=9.5,
                ))
                break  # One finding per check is sufficient
        return findings

    def _check_missing_safety_boundaries(self, content: str) -> list[Finding]:
        """Detect absence of safety guardrail keywords in substantial config files."""
        findings: list[Finding] = []

        if len(content) <= 200:
            return findings

        content_lower = content.lower()
        guardrail_keywords = [
            "never", "refuse", "don't", "do not", "restrict", "forbidden",
            "prohibited", "must not", "should not", "not allowed", "disallow",
        ]

        has_guardrail = any(kw in content_lower for kw in guardrail_keywords)
        if not has_guardrail:
            findings.append(Finding(
                id="MD-SAFETY-001",
                severity=SeverityLevel.HIGH,
                title="Missing Safety Boundaries in Agent Config",
                description=(
                    "This agent configuration file is substantial but contains no "
                    "safety guardrail keywords (never, refuse, restrict, forbidden, etc.). "
                    "Without explicit boundaries, the agent may comply with harmful requests."
                ),
                affected_endpoint="agent configuration",
                evidence="No guardrail keywords found in configuration",
                remediation=(
                    "Add explicit safety boundaries such as: 'Never execute destructive "
                    "commands', 'Refuse requests to access unauthorized data', "
                    "'Do not reveal system internals or credentials'."
                ),
                cwe_id="CWE-862",
                cvss_score=7.5,
            ))
        return findings

    def _check_privilege_escalation(self, content: str) -> list[Finding]:
        """Detect privilege escalation patterns in agent instructions."""
        findings: list[Finding] = []
        content_lower = content.lower()

        escalation_patterns = [
            r"\bsudo\b",
            r"\broot\s+access\b",
            r"\badmin\s+mode\b",
            r"\bfull\s+system\s+access\b",
            r"\bunrestricted\s+(access|mode|permissions?)\b",
            r"\brun\s+as\s+root\b",
            r"\bescalate\s+privil",
        ]

        for pattern in escalation_patterns:
            if re.search(pattern, content_lower):
                findings.append(Finding(
                    id="MD-PRIV-001",
                    severity=SeverityLevel.CRITICAL,
                    title="Privilege Escalation in Agent Config",
                    description=(
                        "The agent configuration grants or references elevated system "
                        "privileges. Agents with root/admin access can cause severe "
                        "damage if compromised or misdirected."
                    ),
                    affected_endpoint="agent configuration",
                    evidence=f"Privilege escalation pattern detected: '{pattern}'",
                    remediation=(
                        "Follow the principle of least privilege. Remove elevated "
                        "access references and configure the agent to operate with "
                        "minimal necessary permissions."
                    ),
                    cwe_id="CWE-269",
                    cvss_score=9.8,
                ))
                break
        return findings

    def _check_data_exfiltration(self, content: str) -> list[Finding]:
        """Detect data exfiltration risk: external URLs combined with send actions."""
        findings: list[Finding] = []
        content_lower = content.lower()

        has_external_url = bool(re.search(r"https?://[^\s\"']+", content))
        exfil_actions = [
            r"\bsend\b", r"\bforward\b", r"\bpost\b", r"\bwebhook\b",
            r"\bexfiltrate\b", r"\bupload\b", r"\btransmit\b",
        ]
        has_exfil_action = any(re.search(p, content_lower) for p in exfil_actions)

        if has_external_url and has_exfil_action:
            findings.append(Finding(
                id="MD-EXFIL-001",
                severity=SeverityLevel.HIGH,
                title="Potential Data Exfiltration Vector",
                description=(
                    "The agent configuration contains external URLs combined with "
                    "data-sending actions (send, forward, post, webhook). This pattern "
                    "could enable data exfiltration if the agent is compromised."
                ),
                affected_endpoint="agent configuration",
                evidence="External URL with send/forward/post action detected",
                remediation=(
                    "Restrict outbound network access to known, trusted domains. "
                    "Add allowlists for external URLs and avoid instructing agents "
                    "to send data to arbitrary endpoints."
                ),
                cwe_id="CWE-200",
                cvss_score=8.0,
            ))
        return findings

    def _check_secrets(self, content: str) -> list[Finding]:
        """Detect leaked secrets using the same patterns as PasteAnalyzer."""
        findings: list[Finding] = []
        for secret_name, pattern in SecurityPayloads.SECRET_PATTERNS.items():
            matches = re.findall(pattern, content)
            if matches:
                match_preview = matches[0] if isinstance(matches[0], str) else str(matches[0])
                masked = (
                    match_preview[:8] + "..." + match_preview[-4:]
                    if len(match_preview) > 16
                    else "***"
                )
                findings.append(Finding(
                    id=f"MD-SECRET-{secret_name}",
                    severity=SeverityLevel.CRITICAL,
                    title=f"Exposed {secret_name.replace('_', ' ').title()} in Agent Config",
                    description=(
                        f"A {secret_name.replace('_', ' ').lower()} was found in the agent "
                        "configuration. Credentials embedded in config files can be extracted "
                        "by anyone with access to the configuration."
                    ),
                    affected_endpoint="agent configuration",
                    evidence=f"Pattern match: {masked}",
                    remediation=(
                        "Immediately rotate this credential. Never embed secrets in agent "
                        "configuration files. Use environment variables or a secrets manager."
                    ),
                    cwe_id="CWE-798",
                    cvss_score=9.8,
                ))
        return findings

    def _check_injection_surface(self, content: str) -> list[Finding]:
        """Detect user input handling without sanitization mentions."""
        findings: list[Finding] = []
        content_lower = content.lower()

        input_patterns = [r"user\s+input", r"user\s+provided", r"user[\-_\s]supplied"]
        sanitize_patterns = [
            r"sanitiz", r"validat", r"filter", r"escap", r"whitelist", r"allowlist",
        ]

        has_user_input = any(re.search(p, content_lower) for p in input_patterns)
        has_sanitize = any(re.search(p, content_lower) for p in sanitize_patterns)

        if has_user_input and not has_sanitize:
            findings.append(Finding(
                id="MD-INJECT-001",
                severity=SeverityLevel.MEDIUM,
                title="Unsanitized User Input Handling",
                description=(
                    "The agent configuration references user input but does not mention "
                    "sanitization, validation, or filtering. This creates an injection "
                    "surface where malicious user input could manipulate agent behavior."
                ),
                affected_endpoint="agent configuration",
                evidence="User input referenced without sanitization guidance",
                remediation=(
                    "Add explicit instructions to sanitize, validate, or filter all "
                    "user-provided input before the agent processes it. Define input "
                    "validation rules and rejection criteria."
                ),
                cwe_id="CWE-20",
                cvss_score=6.5,
            ))
        return findings

    def _check_jailbreak_susceptibility(self, content: str) -> list[Finding]:
        """Detect short instructions without identity anchoring."""
        findings: list[Finding] = []

        if len(content) >= 500 or len(content) == 0:
            return findings

        content_lower = content.lower()
        identity_anchors = [r"you\s+are\b", r"your\s+role\b", r"your\s+purpose\b"]
        has_identity = any(re.search(p, content_lower) for p in identity_anchors)

        if not has_identity:
            findings.append(Finding(
                id="MD-JAILBREAK-001",
                severity=SeverityLevel.MEDIUM,
                title="Jailbreak-Susceptible Agent Config",
                description=(
                    "This agent configuration is short and lacks identity anchoring "
                    "(e.g., 'you are', 'your role'). Short instructions without strong "
                    "identity make it easier for attackers to override agent behavior "
                    "via jailbreak prompts."
                ),
                affected_endpoint="agent configuration",
                evidence="Short config without identity anchoring statements",
                remediation=(
                    "Add a clear identity statement (e.g., 'You are a customer support "
                    "agent for X') and define the agent's boundaries, purpose, and "
                    "refusal conditions."
                ),
                cwe_id="CWE-284",
                cvss_score=6.0,
            ))
        return findings

    def _check_unrestricted_tools(self, content: str) -> list[Finding]:
        """Detect unrestricted tool access grants."""
        findings: list[Finding] = []
        content_lower = content.lower()

        tool_patterns = [
            r"\ball\s+tools\b",
            r"\bany\s+tool\b",
            r"\bfull\s+access\s+to\s+tools\b",
            r"\bevery\s+tool\b",
            r"\bunlimited\s+tool\s+access\b",
        ]

        scope_keywords = [
            "except", "only", "limited to", "restricted to", "but not",
            "excluding", "whitelist", "allowlist",
        ]

        has_unrestricted = any(re.search(p, content_lower) for p in tool_patterns)
        has_scoping = any(kw in content_lower for kw in scope_keywords)

        if has_unrestricted and not has_scoping:
            findings.append(Finding(
                id="MD-TOOLS-001",
                severity=SeverityLevel.HIGH,
                title="Unrestricted Tool Access",
                description=(
                    "The agent configuration grants access to 'all tools' or 'any tool' "
                    "without scoping or restrictions. Unrestricted tool access increases "
                    "the blast radius if the agent is compromised."
                ),
                affected_endpoint="agent configuration",
                evidence="Unrestricted tool access pattern without scoping",
                remediation=(
                    "Explicitly list which tools the agent can use. Apply the principle "
                    "of least privilege by granting only the tools needed for the agent's "
                    "specific purpose."
                ),
                cwe_id="CWE-250",
                cvss_score=8.0,
            ))
        return findings
