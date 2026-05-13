"""
SSRF (Server-Side Request Forgery) Detection
Tests for SSRF vulnerabilities in AI agents
"""

import ipaddress

import httpx

from scanner_worker.security.models import Finding, SeverityLevel


class SSRFChecker:
    """Detects Server-Side Request Forgery vulnerabilities"""

    def __init__(self, timeout: float = 10.0):
        self.timeout = timeout

        # Private IP ranges to check for
        self.private_networks = [
            ipaddress.ip_network("10.0.0.0/8"),
            ipaddress.ip_network("172.16.0.0/12"),
            ipaddress.ip_network("192.168.0.0/16"),
            ipaddress.ip_network("127.0.0.0/8"),
            ipaddress.ip_network("::1/128"),  # IPv6 localhost
            ipaddress.ip_network("fc00::/7"),  # IPv6 private
        ]

    async def check_all(self, target_url: str) -> list[Finding]:
        """Run all SSRF checks"""
        findings = []

        # Test localhost access
        findings.extend(await self._test_localhost_ssrf(target_url))

        # Test private network access
        findings.extend(await self._test_private_network_ssrf(target_url))

        # Test cloud metadata endpoints
        findings.extend(await self._test_cloud_metadata_ssrf(target_url))

        # Test URL fetch endpoints
        findings.extend(await self._test_url_fetch_ssrf(target_url))

        # Test webhook/callback SSRF
        findings.extend(await self._test_webhook_ssrf(target_url))

        return findings

    async def _test_localhost_ssrf(self, target_url: str) -> list[Finding]:
        """Test if agent can be tricked into accessing localhost"""
        findings = []

        localhost_variants = [
            "http://localhost",
            "http://127.0.0.1",
            "http://[::1]",
            "http://0.0.0.0",
            "http://localhost.localdomain",
        ]

        # Common internal service ports
        internal_ports = [22, 3306, 5432, 6379, 8080, 9200]

        endpoints = [
            "/api/fetch",
            "/api/webhook",
            "/api/proxy",
            "/api/import",
            "/api/url",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False) as client:
            for endpoint in endpoints:
                url = f"{target_url.rstrip('/')}{endpoint}"

                for localhost in localhost_variants:
                    for port in internal_ports:
                        test_url = f"{localhost}:{port}"

                        try:
                            # Try common parameter names
                            payloads = [
                                {"url": test_url},
                                {"fetch_url": test_url},
                                {"webhook_url": test_url},
                                {"proxy": test_url},
                                {"src": test_url},
                            ]

                            for payload in payloads:
                                try:
                                    response = await client.post(url, json=payload, timeout=5.0)

                                    # If we get a response, check for SSRF indicators
                                    if response.status_code in [200, 201, 500]:
                                        response_text = response.text.lower()

                                        # Look for service banners or error messages
                                        ssrf_indicators = [
                                            "ssh",
                                            "mysql",
                                            "postgres",
                                            "redis",
                                            "elasticsearch",
                                            "connection refused",
                                            "connection reset",
                                            "timed out",
                                        ]

                                        if any(indicator in response_text for indicator in ssrf_indicators):
                                            findings.append(Finding(
                                                id="SSRF-001",
                                                severity=SeverityLevel.CRITICAL,
                                                title="SSRF: Localhost Access",
                                                description=(
                                                    f"Agent can be exploited to make requests to localhost services. "
                                                    f"Successful probe to {test_url} indicates the agent forwards "
                                                    f"requests without validating destination. This allows attackers "
                                                    f"to access internal services, bypass firewalls, and scan the internal network."
                                                ),
                                                affected_endpoint=url,
                                                evidence=f"Request to {test_url} was forwarded. Response indicators: {response.text[:100]}",
                                                remediation=(
                                                    "1. IMMEDIATELY block all requests to localhost and 127.0.0.0/8. "
                                                    "2. Implement URL validation before making any HTTP requests. "
                                                    "3. Use allowlists for permitted external domains. "
                                                    "4. Block access to private IP ranges. "
                                                    "5. Use DNS resolution checks to detect bypasses. "
                                                    "6. Consider using a forward proxy with strict egress rules."
                                                ),
                                                cwe_id="CWE-918",
                                                cvss_score=9.9,
                                                references=[
                                                    "https://portswigger.net/web-security/ssrf",
                                                    "https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html"
                                                ]
                                            ))
                                            return findings  # Found SSRF, return immediately

                                except httpx.TimeoutException:
                                    # Timeout might indicate request was attempted
                                    pass

                        except Exception:
                            continue

        return findings

    async def _test_private_network_ssrf(self, target_url: str) -> list[Finding]:
        """Test if agent can access private network ranges"""
        findings = []

        # Common private IP ranges to test
        private_targets = [
            "http://192.168.1.1",
            "http://10.0.0.1",
            "http://172.16.0.1",
        ]

        endpoints = ["/api/fetch", "/api/proxy", "/api/url"]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False) as client:
            for endpoint in endpoints:
                url = f"{target_url.rstrip('/')}{endpoint}"

                for private_ip in private_targets:
                    try:
                        response = await client.post(
                            url,
                            json={"url": private_ip},
                            timeout=5.0
                        )

                        # Check for successful access to private network
                        if response.status_code in [200, 201]:
                            findings.append(Finding(
                                id="SSRF-002",
                                severity=SeverityLevel.CRITICAL,
                                title="SSRF: Private Network Access",
                                description=(
                                    f"Agent can access private network IP ranges. "
                                    f"Request to {private_ip} was successful, allowing attackers "
                                    f"to scan and access internal corporate networks."
                                ),
                                affected_endpoint=url,
                                evidence=f"Successfully accessed private IP: {private_ip}",
                                remediation=(
                                    "1. Block all RFC1918 private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16). "
                                    "2. Block link-local addresses (169.254.0.0/16). "
                                    "3. Implement network-level egress filtering. "
                                    "4. Use DNS validation to prevent DNS rebinding attacks. "
                                    "5. Consider using a dedicated proxy service for external requests."
                                ),
                                cwe_id="CWE-918",
                                cvss_score=9.8
                            ))
                            break

                    except Exception:
                        continue

        return findings

    async def _test_cloud_metadata_ssrf(self, target_url: str) -> list[Finding]:
        """Test if agent can access cloud provider metadata endpoints"""
        findings = []

        cloud_metadata_endpoints = [
            ("AWS", "http://169.254.169.254/latest/meta-data/"),
            ("GCP", "http://metadata.google.internal/computeMetadata/v1/"),
            ("Azure", "http://169.254.169.254/metadata/instance?api-version=2021-02-01"),
        ]

        endpoints = ["/api/fetch", "/api/proxy", "/api/webhook"]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False) as client:
            for endpoint in endpoints:
                url = f"{target_url.rstrip('/')}{endpoint}"

                for cloud_provider, metadata_url in cloud_metadata_endpoints:
                    try:
                        # Some metadata endpoints require specific headers
                        payloads = [
                            {"url": metadata_url},
                            {"url": metadata_url, "headers": {"Metadata": "true"}},  # Azure
                            {"url": metadata_url, "headers": {"Metadata-Flavor": "Google"}},  # GCP
                        ]

                        for payload in payloads:
                            try:
                                response = await client.post(url, json=payload, timeout=5.0)

                                if response.status_code in [200, 201]:
                                    response_text = response.text.lower()

                                    # Check for cloud metadata indicators
                                    metadata_indicators = {
                                        "AWS": ["ami-id", "instance-id", "iam", "security-credentials"],
                                        "GCP": ["project-id", "access-token", "service-accounts"],
                                        "Azure": ["compute", "subscription", "resourcegroup"],
                                    }

                                    if any(indicator in response_text for indicator in metadata_indicators.get(cloud_provider, [])):
                                        findings.append(Finding(
                                            id="SSRF-003",
                                            severity=SeverityLevel.CRITICAL,
                                            title=f"SSRF: {cloud_provider} Metadata Access",
                                            description=(
                                                f"Agent can access {cloud_provider} instance metadata endpoint. "
                                                f"This exposes cloud credentials, IAM roles, and sensitive instance "
                                                f"information. Attackers can steal credentials and escalate privileges."
                                            ),
                                            affected_endpoint=url,
                                            evidence=f"Accessed {cloud_provider} metadata: {metadata_url}",
                                            remediation=(
                                                "1. CRITICAL: Block access to 169.254.169.254 and metadata.google.internal. "
                                                "2. Use IMDSv2 (AWS) which requires session tokens. "
                                                "3. Implement strict URL validation with metadata endpoint blocklists. "
                                                "4. Use network ACLs to prevent metadata access. "
                                                "5. Rotate any exposed credentials immediately."
                                            ),
                                            cwe_id="CWE-918",
                                            cvss_score=10.0,  # Credential theft
                                            references=[
                                                "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html",
                                                "https://cloud.google.com/compute/docs/metadata/overview"
                                            ]
                                        ))
                                        return findings  # Critical finding, return immediately

                            except httpx.TimeoutException:
                                pass

                    except Exception:
                        continue

        return findings

    async def _test_url_fetch_ssrf(self, target_url: str) -> list[Finding]:
        """Test URL fetch functionality for SSRF"""
        findings = []

        # Test if agent has URL fetch capability
        fetch_endpoints = [
            "/api/fetch",
            "/api/scrape",
            "/api/crawl",
            "/api/import",
            "/fetch",
        ]

        # Use a test payload that would indicate SSRF capability
        test_target = "http://127.0.0.1:80"

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False) as client:
            for endpoint in fetch_endpoints:
                url = f"{target_url.rstrip('/')}{endpoint}"

                try:
                    response = await client.post(
                        url,
                        json={"url": test_target},
                        timeout=5.0
                    )

                    # If endpoint accepts URL parameter, it's potentially vulnerable
                    if response.status_code in [200, 201, 400, 500] and (
                        "localhost" in response.text.lower() or "127.0.0.1" in response.text
                    ):
                            findings.append(Finding(
                                id="SSRF-004",
                                severity=SeverityLevel.HIGH,
                                title="Potential SSRF via URL Fetch",
                                description=(
                                    "Agent has URL fetch capability that may be vulnerable to SSRF. "
                                    "The endpoint accepts URL parameters and attempts to fetch them. "
                                    "Verify that proper validation is in place."
                                ),
                                affected_endpoint=url,
                                evidence="Endpoint accepts URL parameter and processes it",
                                remediation=(
                                    "1. Implement strict URL validation (protocol, domain, IP range). "
                                    "2. Use allowlists for permitted domains. "
                                    "3. Block private IP ranges and localhost. "
                                    "4. Implement rate limiting. "
                                    "5. Add request logging and monitoring."
                                ),
                                cwe_id="CWE-918",
                                cvss_score=8.6
                            ))

                except Exception:
                    continue

        return findings

    async def _test_webhook_ssrf(self, target_url: str) -> list[Finding]:
        """Test webhook/callback functionality for SSRF"""
        findings = []

        webhook_endpoints = [
            "/api/webhook",
            "/api/callback",
            "/api/notify",
            "/webhook",
        ]

        # Test with internal targets
        internal_targets = [
            "http://localhost:8080/admin",
            "http://127.0.0.1:6379",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False) as client:
            for endpoint in webhook_endpoints:
                url = f"{target_url.rstrip('/')}{endpoint}"

                for target in internal_targets:
                    try:
                        response = await client.post(
                            url,
                            json={
                                "webhook_url": target,
                                "callback_url": target,
                                "url": target,
                            },
                            timeout=5.0
                        )

                        # Check if webhook was accepted
                        if response.status_code in [200, 201, 202]:
                            findings.append(Finding(
                                id="SSRF-005",
                                severity=SeverityLevel.HIGH,
                                title="SSRF via Webhook/Callback",
                                description=(
                                    "Agent accepts webhook/callback URLs without validation. "
                                    "Attackers can register internal URLs to trigger SSRF attacks "
                                    "when events occur."
                                ),
                                affected_endpoint=url,
                                evidence=f"Webhook registered for internal URL: {target}",
                                remediation=(
                                    "1. Validate all webhook URLs before registration. "
                                    "2. Block private IP ranges and localhost. "
                                    "3. Implement webhook URL allowlists. "
                                    "4. Add webhook signature verification. "
                                    "5. Rate limit webhook registrations per user."
                                ),
                                cwe_id="CWE-918",
                                cvss_score=8.1
                            ))
                            break

                    except Exception:
                        continue

        return findings
