"""
Tool Execution Safety Checks
Tests for command injection, path traversal, and unsafe tool execution
"""


import httpx

from scanner_worker.security.models import Finding, SeverityLevel
from scanner_worker.security.payloads import SecurityPayloads


class ToolExecutionChecker:
    """Checks for unsafe tool execution vulnerabilities"""

    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout

    async def check_all(self, target_url: str) -> list[Finding]:
        """Run all tool execution safety checks"""
        findings = []

        # Test command injection
        findings.extend(await self._test_command_injection(target_url))

        # Test path traversal
        findings.extend(await self._test_path_traversal(target_url))

        # Test arbitrary code execution
        findings.extend(await self._test_code_execution(target_url))

        # Check for shell access
        findings.extend(await self._test_shell_access(target_url))

        return findings

    async def _test_command_injection(self, target_url: str) -> list[Finding]:
        """Test for command injection vulnerabilities"""
        findings = []

        # Endpoints that might execute commands
        command_endpoints = [
            "/api/execute",
            "/api/run",
            "/api/command",
            "/api/shell",
            "/api/bash",
            "/api/system",
            "/tools/bash",
            "/tools/execute",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in command_endpoints:
                url = f"{target_url.rstrip('/')}{endpoint}"

                for payload_obj in SecurityPayloads.COMMAND_INJECTION:
                    try:
                        # Try different payload formats
                        test_payloads = [
                            {"command": f"ls {payload_obj.payload}"},
                            {"cmd": f"echo test{payload_obj.payload}"},
                            {"input": f"safe_command{payload_obj.payload}"},
                            {"args": [f"test{payload_obj.payload}"]},
                        ]

                        for test_payload in test_payloads:
                            try:
                                response = await client.post(url, json=test_payload, timeout=10.0)

                                if response.status_code in [200, 201]:
                                    response_text = response.text.lower()

                                    # Check for indicators of successful command execution
                                    injection_indicators = [
                                        "root:",
                                        "bin/bash",
                                        "/etc/passwd",
                                        "uid=",
                                        "gid=",
                                        "drwxr",
                                        "total",
                                    ]

                                    if any(indicator in response_text for indicator in injection_indicators):
                                        findings.append(Finding(
                                            id="TOOL-001",
                                            severity=SeverityLevel.CRITICAL,
                                            title=f"Command Injection: {payload_obj.name}",
                                            description=(
                                                f"Agent is vulnerable to command injection. Malicious input "
                                                f"'{payload_obj.payload}' was executed as a shell command. "
                                                f"Attackers can execute arbitrary system commands, leading to "
                                                f"complete system compromise."
                                            ),
                                            affected_endpoint=url,
                                            evidence=f"Command injection payload executed: {payload_obj.payload}. Response: {response.text[:200]}",
                                            remediation=(
                                                "1. CRITICAL: Never pass user input directly to shell commands. "
                                                "2. Use parameterized commands or safe APIs instead of shell execution. "
                                                "3. If shell execution is necessary, use strict allowlists for commands. "
                                                "4. Sanitize all input by removing shell metacharacters (; | & $ ` \\n). "
                                                "5. Use subprocess with shell=False (Python) or equivalent. "
                                                "6. Run agent with minimal privileges (non-root user). "
                                                "7. Use security tools like AppArmor/SELinux to restrict execution."
                                            ),
                                            cwe_id="CWE-78",  # OS Command Injection
                                            cvss_score=10.0,
                                            references=[
                                                "https://owasp.org/www-community/attacks/Command_Injection",
                                                "https://cwe.mitre.org/data/definitions/78.html"
                                            ]
                                        ))
                                        return findings  # Critical vulnerability found

                            except httpx.TimeoutException:
                                # Command might have hung the system
                                findings.append(Finding(
                                    id="TOOL-001-DOS",
                                    severity=SeverityLevel.HIGH,
                                    title="Potential Command Injection (Timeout)",
                                    description=(
                                        f"Command execution timed out when testing payload: {payload_obj.payload}. "
                                        f"This may indicate the payload was executed and caused a hang/DoS."
                                    ),
                                    affected_endpoint=url,
                                    evidence=f"Request timed out with payload: {payload_obj.payload}",
                                    remediation="Same as TOOL-001 remediation",
                                    cwe_id="CWE-78",
                                    cvss_score=8.2
                                ))

                    except Exception:
                        continue

        return findings

    async def _test_path_traversal(self, target_url: str) -> list[Finding]:
        """Test for path traversal vulnerabilities"""
        findings = []

        # Endpoints that might access files
        file_endpoints = [
            "/api/file",
            "/api/read",
            "/api/download",
            "/api/get",
            "/files",
            "/read",
            "/api/fs/read",
            "/tools/read_file",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in file_endpoints:
                url = f"{target_url.rstrip('/')}{endpoint}"

                for payload_obj in SecurityPayloads.PATH_TRAVERSAL:
                    try:
                        # Try different parameter names
                        test_payloads = [
                            {"path": payload_obj.payload},
                            {"file": payload_obj.payload},
                            {"filename": payload_obj.payload},
                            {"filepath": payload_obj.payload},
                        ]

                        for test_payload in test_payloads:
                            try:
                                response = await client.post(url, json=test_payload)

                                if response.status_code == 200:
                                    response_text = response.text.lower()

                                    # Check for sensitive file contents
                                    sensitive_indicators = [
                                        "root:",
                                        "daemon:",
                                        "/bin/bash",
                                        "nobody:",
                                        "[boot loader]",
                                        "administrator:",
                                    ]

                                    if any(indicator in response_text for indicator in sensitive_indicators):
                                        findings.append(Finding(
                                            id="TOOL-002",
                                            severity=SeverityLevel.CRITICAL,
                                            title=f"Path Traversal: {payload_obj.name}",
                                            description=(
                                                f"Agent is vulnerable to path traversal attacks. Payload "
                                                f"'{payload_obj.payload}' successfully accessed sensitive files "
                                                f"outside the intended directory. Attackers can read arbitrary "
                                                f"files including credentials, private keys, and configuration."
                                            ),
                                            affected_endpoint=url,
                                            evidence=f"Path traversal successful: {payload_obj.payload}. Accessed sensitive file.",
                                            remediation=(
                                                "1. CRITICAL: Validate and sanitize all file paths. "
                                                "2. Use os.path.normpath() or Path.resolve() to normalize paths. "
                                                "3. Check that resolved path is within allowed directory (chroot). "
                                                "4. Reject paths containing '..' or absolute paths. "
                                                "5. Use allowlists for permitted files/directories. "
                                                "6. Run agent in sandboxed environment with restricted file access. "
                                                "7. Implement principle of least privilege for file permissions."
                                            ),
                                            cwe_id="CWE-22",  # Path Traversal
                                            cvss_score=9.1,
                                            references=[
                                                "https://owasp.org/www-community/attacks/Path_Traversal",
                                                "https://cwe.mitre.org/data/definitions/22.html"
                                            ]
                                        ))
                                        return findings  # Critical vulnerability found

                            except Exception:
                                continue

                    except Exception:
                        continue

        return findings

    async def _test_code_execution(self, target_url: str) -> list[Finding]:
        """Test for arbitrary code execution vulnerabilities"""
        findings = []

        code_endpoints = [
            "/api/eval",
            "/api/execute",
            "/api/run",
            "/api/code",
            "/eval",
            "/execute",
        ]

        # Test payloads for different languages
        code_payloads = [
            {
                "lang": "python",
                "code": "import os; os.system('whoami')",
                "indicators": ["command", "executed", "system"]
            },
            {
                "lang": "javascript",
                "code": "require('child_process').execSync('whoami').toString()",
                "indicators": ["child_process", "exec"]
            },
            {
                "lang": "python",
                "code": "__import__('os').environ",
                "indicators": ["path", "home", "user"]
            },
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in code_endpoints:
                url = f"{target_url.rstrip('/')}{endpoint}"

                for payload in code_payloads:
                    try:
                        test_payloads = [
                            {"code": payload["code"]},
                            {"code": payload["code"], "language": payload["lang"]},
                            {"expression": payload["code"]},
                            {"script": payload["code"]},
                        ]

                        for test_payload in test_payloads:
                            try:
                                response = await client.post(url, json=test_payload)

                                if response.status_code in [200, 201]:
                                    response_text = response.text.lower()

                                    if any(indicator in response_text for indicator in payload["indicators"]):
                                        findings.append(Finding(
                                            id="TOOL-003",
                                            severity=SeverityLevel.CRITICAL,
                                            title="Arbitrary Code Execution",
                                            description=(
                                                f"Agent executes arbitrary {payload['lang']} code without sandboxing. "
                                                f"Attackers can run malicious code to compromise the system, "
                                                f"steal data, or pivot to other systems."
                                            ),
                                            affected_endpoint=url,
                                            evidence=f"Code execution confirmed with payload: {payload['code']}",
                                            remediation=(
                                                "1. CRITICAL: Remove arbitrary code execution features if not essential. "
                                                "2. If required, use sandboxed environments (Docker, gVisor, Firecracker). "
                                                "3. Implement strict code validation and sanitization. "
                                                "4. Use allowlists for permitted functions/modules. "
                                                "5. Apply timeout limits to prevent infinite loops. "
                                                "6. Run code execution in isolated containers with no network/file access. "
                                                "7. Require explicit user authorization for code execution."
                                            ),
                                            cwe_id="CWE-94",  # Code Injection
                                            cvss_score=10.0,
                                            references=[
                                                "https://owasp.org/www-community/attacks/Code_Injection",
                                                "https://cwe.mitre.org/data/definitions/94.html"
                                            ]
                                        ))
                                        return findings

                            except Exception:
                                continue

                    except Exception:
                        continue

        return findings

    async def _test_shell_access(self, target_url: str) -> list[Finding]:
        """Check if agent exposes shell/terminal access"""
        findings = []

        shell_endpoints = [
            "/api/shell",
            "/api/terminal",
            "/api/bash",
            "/shell",
            "/terminal",
            "/console",
            "/exec",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for endpoint in shell_endpoints:
                url = f"{target_url.rstrip('/')}{endpoint}"

                try:
                    # Try both GET and POST
                    for method in [client.get, client.post]:
                        try:
                            response = await method(url)  # type: ignore[operator]

                            if response.status_code in [200, 201]:
                                response_text = response.text.lower()

                                # Check for shell indicators
                                shell_indicators = [
                                    "terminal",
                                    "shell",
                                    "bash",
                                    "$ ",
                                    "# ",
                                    "command prompt",
                                    "xterm",
                                ]

                                if any(indicator in response_text for indicator in shell_indicators):
                                    findings.append(Finding(
                                        id="TOOL-004",
                                        severity=SeverityLevel.CRITICAL,
                                        title="Exposed Shell/Terminal Access",
                                        description=(
                                            "Agent exposes direct shell or terminal access. This provides "
                                            "attackers with complete system control, allowing arbitrary "
                                            "command execution and full system compromise."
                                        ),
                                        affected_endpoint=url,
                                        evidence=f"Shell interface accessible at {endpoint}",
                                        remediation=(
                                            "1. IMMEDIATELY disable direct shell access. "
                                            "2. If debugging is needed, use time-limited, token-based access. "
                                            "3. Implement comprehensive audit logging for all commands. "
                                            "4. Restrict shell access to specific IP addresses. "
                                            "5. Use read-only shells or restricted shell environments (rbash). "
                                            "6. Require multi-factor authentication for any shell access."
                                        ),
                                        cwe_id="CWE-749",  # Exposed Dangerous Method
                                        cvss_score=10.0
                                    ))
                                    return findings

                        except Exception:
                            continue

                except Exception:
                    continue

        return findings
