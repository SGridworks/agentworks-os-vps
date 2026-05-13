"""
Authentication Security Checks

Tests for JWT vulnerabilities, session management flaws, privilege escalation,
and missing authentication on AI agent endpoints.
"""

import json
import logging
from typing import Any

import httpx

from scanner_worker.security.jwt_utils import (
    COMMON_WEAK_SECRETS,
    generate_corrupted_signature_jwt,
    generate_expired_jwt,
    generate_jwt,
    generate_none_algorithm_jwt,
    generate_none_algorithm_jwt_variant,
    generate_truncated_signature_jwt,
)
from scanner_worker.security.models import Finding, SeverityLevel

logger = logging.getLogger("agentguard.auth_checks")


class AuthenticationChecker:
    """Detects authentication and authorization vulnerabilities in AI agents."""

    def __init__(self, timeout: float = 30.0):
        self.timeout = timeout

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def check_all(self, target_url: str) -> list[Finding]:
        """Run all authentication security checks."""
        findings: list[Finding] = []

        findings.extend(await self._test_missing_auth(target_url))
        findings.extend(await self._test_expired_jwt(target_url))
        findings.extend(await self._test_none_algorithm(target_url))
        findings.extend(await self._test_algorithm_confusion(target_url))
        findings.extend(await self._test_signature_validation(target_url))
        findings.extend(await self._test_session_fixation(target_url))
        findings.extend(await self._test_horizontal_escalation(target_url))
        findings.extend(await self._test_vertical_escalation(target_url))

        return findings

    # ------------------------------------------------------------------
    # Helper methods
    # ------------------------------------------------------------------

    @staticmethod
    def _looks_like_protected_data(response_text: str) -> bool:
        """Heuristic: does the response look like it contains protected data?

        Returns True if the response appears to be JSON with sensitive-looking
        keys, indicating an endpoint that should require authentication.
        """
        try:
            data = json.loads(response_text)
        except (json.JSONDecodeError, ValueError):
            return False

        sensitive_keys = {
            "users", "user", "email", "password", "token", "api_key",
            "secret", "credentials", "data", "items", "results",
            "scans", "agents", "settings", "config", "profile",
            "account", "admin", "keys", "permissions",
        }

        if isinstance(data, dict):
            return bool(sensitive_keys & {k.lower() for k in data})
        if isinstance(data, list) and data:
            first = data[0]
            if isinstance(first, dict):
                return bool(sensitive_keys & {k.lower() for k in first})
        return False

    @staticmethod
    def _make_test_claims(role: str = "user", email: str = "scanner@agentguard.test") -> dict[str, object]:
        """Generate JWT claims for testing."""
        return {
            "sub": email,
            "role": role,
            "email": email,
        }

    # ------------------------------------------------------------------
    # AUTH-008: Missing Authentication
    # ------------------------------------------------------------------

    async def _test_missing_auth(self, target_url: str) -> list[Finding]:
        """Test if protected endpoints are accessible without authentication."""
        findings: list[Finding] = []

        protected_paths = [
            "/api/users",
            "/api/admin",
            "/api/settings",
            "/api/agents",
            "/api/scans",
            "/api/data",
            "/api/config",
            "/api/keys",
            "/api/v1/users",
            "/api/v1/agents",
            "/api/v1/scans",
            "/api/profile",
            "/api/account",
            "/api/dashboard",
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for path in protected_paths:
                try:
                    url = f"{target_url.rstrip('/')}{path}"
                    response = await client.get(url)

                    if response.status_code == 200 and self._looks_like_protected_data(
                        response.text
                    ):
                        findings.append(
                            Finding(
                                id="AUTH-008",
                                severity=SeverityLevel.CRITICAL,
                                title=f"Missing Authentication: {path}",
                                description=(
                                    f"The endpoint {path} returns sensitive data without "
                                    f"requiring authentication. Any unauthenticated user can "
                                    f"access this endpoint and retrieve protected resources."
                                ),
                                affected_endpoint=url,
                                evidence=(
                                    f"HTTP {response.status_code} with structured data returned "
                                    f"without Authorization header. "
                                    f"Response preview: {response.text[:200]}"
                                ),
                                remediation=(
                                    "1. Require authentication (Bearer token, API key) for all "
                                    "API endpoints that return user or system data. "
                                    "2. Return 401 Unauthorized for unauthenticated requests. "
                                    "3. Implement middleware-level auth checks to prevent bypass. "
                                    "4. Audit all endpoints for proper access control."
                                ),
                                cwe_id="CWE-306",
                                cvss_score=9.8,
                                references=[
                                    "https://owasp.org/API-Security/editions/2023/en/0xa2-broken-authentication/"
                                ],
                            )
                        )

                except httpx.TimeoutException:
                    logger.warning("Timeout checking auth at %s%s", target_url, path)
                except httpx.RequestError as exc:
                    logger.warning("Network error checking auth at %s%s: %s", target_url, path, exc)
                except Exception:
                    logger.error(
                        "Unexpected error checking auth at %s%s", target_url, path, exc_info=True
                    )

        return findings

    # ------------------------------------------------------------------
    # AUTH-001: Expired JWT Accepted
    # ------------------------------------------------------------------

    async def _test_expired_jwt(self, target_url: str) -> list[Finding]:
        """Test if the target accepts expired JWT tokens."""
        findings: list[Finding] = []

        test_endpoints = [
            "/api/users",
            "/api/agents",
            "/api/scans",
            "/api/profile",
            "/api/me",
            "/api/auth/me",
            "/api/dashboard",
        ]

        claims = self._make_test_claims()

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for secret in COMMON_WEAK_SECRETS:
                for hours in [24, 168]:  # 1 day, 1 week expired
                    try:
                        token = generate_expired_jwt(claims, secret, expired_hours=hours)
                    except Exception:
                        continue

                    for path in test_endpoints:
                        try:
                            url = f"{target_url.rstrip('/')}{path}"
                            response = await client.get(
                                url, headers={"Authorization": f"Bearer {token}"}
                            )

                            if response.status_code == 200 and self._looks_like_protected_data(
                                response.text
                            ):
                                findings.append(
                                    Finding(
                                        id="AUTH-001",
                                        severity=SeverityLevel.CRITICAL,
                                        title="Expired JWT Token Accepted",
                                        description=(
                                            f"The target accepted a JWT token that expired "
                                            f"{hours} hours ago. This means stolen or leaked "
                                            f"tokens remain valid indefinitely, allowing "
                                            f"attackers to maintain persistent access."
                                        ),
                                        affected_endpoint=url,
                                        evidence=(
                                            f"Expired token (exp: -{hours}h) accepted with "
                                            f"HTTP {response.status_code}. "
                                            f"Response preview: {response.text[:200]}"
                                        ),
                                        remediation=(
                                            "1. Always validate the 'exp' claim in JWT tokens. "
                                            "2. Reject tokens where exp < current time. "
                                            "3. Use short-lived tokens (15-60 minutes) with "
                                            "refresh token rotation. "
                                            "4. Implement token revocation for compromised tokens."
                                        ),
                                        cwe_id="CWE-613",
                                        cvss_score=9.1,
                                        references=[
                                            "https://cwe.mitre.org/data/definitions/613.html"
                                        ],
                                    )
                                )
                                return findings  # One finding is sufficient

                        except (httpx.TimeoutException, httpx.RequestError):
                            continue
                        except Exception:
                            logger.error(
                                "Error testing expired JWT at %s%s",
                                target_url, path, exc_info=True,
                            )

        return findings

    # ------------------------------------------------------------------
    # AUTH-002: 'none' Algorithm Accepted
    # ------------------------------------------------------------------

    async def _test_none_algorithm(self, target_url: str) -> list[Finding]:
        """Test if the target accepts JWT tokens with 'alg: none'."""
        findings: list[Finding] = []

        test_endpoints = [
            "/api/users",
            "/api/agents",
            "/api/scans",
            "/api/profile",
            "/api/me",
            "/api/auth/me",
        ]

        claims = self._make_test_claims(role="admin", email="admin@agentguard.test")
        alg_variants = ["none", "None", "NONE", "nOnE"]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for alg in alg_variants:
                if alg == "none":
                    token = generate_none_algorithm_jwt(claims)
                else:
                    token = generate_none_algorithm_jwt_variant(claims, alg)

                for path in test_endpoints:
                    try:
                        url = f"{target_url.rstrip('/')}{path}"
                        response = await client.get(
                            url, headers={"Authorization": f"Bearer {token}"}
                        )

                        if response.status_code == 200 and self._looks_like_protected_data(
                            response.text
                        ):
                            findings.append(
                                Finding(
                                    id="AUTH-002",
                                    severity=SeverityLevel.CRITICAL,
                                    title=f"JWT 'none' Algorithm Accepted (alg: {alg})",
                                    description=(
                                        f"The target accepts JWT tokens with algorithm set to "
                                        f"'{alg}' and no signature. This allows any attacker to "
                                        f"forge valid authentication tokens with arbitrary claims "
                                        f"(including admin privileges) without knowing the secret key."
                                    ),
                                    affected_endpoint=url,
                                    evidence=(
                                        f"Unsigned JWT with alg='{alg}' accepted with "
                                        f"HTTP {response.status_code}. "
                                        f"Response preview: {response.text[:200]}"
                                    ),
                                    remediation=(
                                        "1. Explicitly reject the 'none' algorithm in JWT "
                                        "validation. "
                                        "2. Maintain an allowlist of accepted algorithms "
                                        "(e.g., only HS256 or RS256). "
                                        "3. Use a JWT library that disables 'none' by default. "
                                        "4. Validate the algorithm header matches server config."
                                    ),
                                    cwe_id="CWE-287",
                                    cvss_score=9.8,
                                    references=[
                                        "https://auth0.com/blog/critical-vulnerabilities-in-json-web-token-libraries/",
                                        "https://cwe.mitre.org/data/definitions/287.html",
                                    ],
                                )
                            )
                            return findings

                    except (httpx.TimeoutException, httpx.RequestError):
                        continue
                    except Exception:
                        logger.error(
                            "Error testing none algorithm at %s%s",
                            target_url, path, exc_info=True,
                        )

        return findings

    # ------------------------------------------------------------------
    # AUTH-003: Algorithm Confusion (RS256 -> HS256)
    # ------------------------------------------------------------------

    async def _test_algorithm_confusion(self, target_url: str) -> list[Finding]:
        """Test for RS256/HS256 algorithm confusion vulnerability.

        If the target uses RS256 and exposes its public key, an attacker may
        sign a token with HS256 using the public key as the HMAC secret.
        """
        findings: list[Finding] = []

        jwks_paths = [
            "/.well-known/jwks.json",
            "/jwks.json",
            "/.well-known/openid-configuration",
            "/oauth/discovery/keys",
        ]

        test_endpoints = ["/api/users", "/api/me", "/api/auth/me", "/api/profile"]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            # Step 1: Try to find a JWKS or public key endpoint
            public_key_material = None
            for path in jwks_paths:
                try:
                    url = f"{target_url.rstrip('/')}{path}"
                    response = await client.get(url)
                    if response.status_code == 200:
                        try:
                            data = json.loads(response.text)
                            # JWKS format or OpenID config
                            if "keys" in data or "jwks_uri" in data:
                                public_key_material = response.text
                                break
                        except (json.JSONDecodeError, ValueError):
                            continue
                except (httpx.TimeoutException, httpx.RequestError):
                    continue
                except Exception:
                    continue

            if not public_key_material:
                return findings

            # Step 2: Try HS256 with the public key material as the secret
            claims = self._make_test_claims(role="admin")
            try:
                token = generate_jwt(claims, public_key_material, algorithm="HS256")
            except Exception:
                return findings

            for path in test_endpoints:
                try:
                    url = f"{target_url.rstrip('/')}{path}"
                    response = await client.get(
                        url, headers={"Authorization": f"Bearer {token}"}
                    )

                    if response.status_code == 200 and self._looks_like_protected_data(
                        response.text
                    ):
                        findings.append(
                            Finding(
                                id="AUTH-003",
                                severity=SeverityLevel.CRITICAL,
                                title="JWT Algorithm Confusion (RS256 -> HS256)",
                                description=(
                                    "The target is vulnerable to JWT algorithm confusion. "
                                    "It uses RS256 for signing but accepts HS256 tokens signed "
                                    "with the public key as the HMAC secret. An attacker can "
                                    "forge valid tokens using the publicly available key."
                                ),
                                affected_endpoint=url,
                                evidence=(
                                    f"Token signed with HS256 using public key material "
                                    f"accepted with HTTP {response.status_code}. "
                                    f"Response preview: {response.text[:200]}"
                                ),
                                remediation=(
                                    "1. Enforce the expected algorithm server-side (never trust "
                                    "the 'alg' header from the token). "
                                    "2. Use asymmetric algorithms (RS256) with proper key "
                                    "type validation. "
                                    "3. Configure the JWT library to only accept the expected "
                                    "algorithm. "
                                    "4. Never use the public key as an HMAC secret."
                                ),
                                cwe_id="CWE-327",
                                cvss_score=9.8,
                                references=[
                                    "https://auth0.com/blog/critical-vulnerabilities-in-json-web-token-libraries/",
                                    "https://portswigger.net/web-security/jwt/algorithm-confusion",
                                ],
                            )
                        )
                        return findings

                except (httpx.TimeoutException, httpx.RequestError):
                    continue
                except Exception:
                    logger.error(
                        "Error testing algorithm confusion at %s%s",
                        target_url, path, exc_info=True,
                    )

        return findings

    # ------------------------------------------------------------------
    # AUTH-004: Signature Not Validated
    # ------------------------------------------------------------------

    async def _test_signature_validation(self, target_url: str) -> list[Finding]:
        """Test if the target validates JWT signatures."""
        findings: list[Finding] = []

        test_endpoints = [
            "/api/users",
            "/api/agents",
            "/api/scans",
            "/api/profile",
            "/api/me",
            "/api/auth/me",
        ]

        claims = self._make_test_claims()

        # Try corrupted and truncated signatures with common secrets
        token_generators = [
            ("corrupted", generate_corrupted_signature_jwt),
            ("truncated", generate_truncated_signature_jwt),
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for secret in COMMON_WEAK_SECRETS[:3]:  # Limit to first 3 for speed
                for label, gen_fn in token_generators:
                    try:
                        token = gen_fn(claims, secret)
                    except Exception:
                        continue

                    for path in test_endpoints:
                        try:
                            url = f"{target_url.rstrip('/')}{path}"
                            response = await client.get(
                                url, headers={"Authorization": f"Bearer {token}"}
                            )

                            if response.status_code == 200 and self._looks_like_protected_data(
                                response.text
                            ):
                                findings.append(
                                    Finding(
                                        id="AUTH-004",
                                        severity=SeverityLevel.CRITICAL,
                                        title=f"JWT Signature Not Validated ({label})",
                                        description=(
                                            f"The target accepted a JWT with a {label} signature. "
                                            f"This means the server does not properly validate "
                                            f"token signatures, allowing attackers to forge tokens "
                                            f"with arbitrary claims."
                                        ),
                                        affected_endpoint=url,
                                        evidence=(
                                            f"JWT with {label} signature accepted with "
                                            f"HTTP {response.status_code}. "
                                            f"Response preview: {response.text[:200]}"
                                        ),
                                        remediation=(
                                            "1. Always verify JWT signatures before trusting claims. "
                                            "2. Use a well-tested JWT library with signature "
                                            "verification enabled by default. "
                                            "3. Never skip signature validation in any environment. "
                                            "4. Implement token integrity checks in auth middleware."
                                        ),
                                        cwe_id="CWE-345",
                                        cvss_score=9.8,
                                        references=[
                                            "https://cwe.mitre.org/data/definitions/345.html"
                                        ],
                                    )
                                )
                                return findings

                        except (httpx.TimeoutException, httpx.RequestError):
                            continue
                        except Exception:
                            logger.error(
                                "Error testing signature at %s%s",
                                target_url, path, exc_info=True,
                            )

        return findings

    # ------------------------------------------------------------------
    # AUTH-005: Session Fixation
    # ------------------------------------------------------------------

    async def _test_session_fixation(self, target_url: str) -> list[Finding]:
        """Test if tokens are rotated on login (session fixation resistance)."""
        findings: list[Finding] = []

        login_paths = [
            "/api/auth/login",
            "/api/login",
            "/auth/login",
            "/login",
            "/api/v1/auth/login",
        ]

        login_bodies = [
            {"email": "test@example.com", "password": "TestPass123"},
            {"username": "test@example.com", "password": "TestPass123"},
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for path in login_paths:
                url = f"{target_url.rstrip('/')}{path}"

                for body in login_bodies:
                    try:
                        resp1 = await client.post(url, json=body)
                        if resp1.status_code not in (200, 201):
                            continue

                        resp2 = await client.post(url, json=body)
                        if resp2.status_code not in (200, 201):
                            continue

                        # Extract tokens from responses
                        token1 = self._extract_token(resp1.text)
                        token2 = self._extract_token(resp2.text)

                        if token1 and token2 and token1 == token2:
                            findings.append(
                                Finding(
                                    id="AUTH-005",
                                    severity=SeverityLevel.HIGH,
                                    title="Session Fixation: Tokens Not Rotated on Login",
                                    description=(
                                        "The login endpoint returns identical tokens for "
                                        "successive login requests. Tokens should be unique "
                                        "per session to prevent session fixation attacks where "
                                        "an attacker pre-sets a known session token."
                                    ),
                                    affected_endpoint=url,
                                    evidence=(
                                        "Two consecutive login requests returned identical "
                                        "tokens, indicating no token rotation."
                                    ),
                                    remediation=(
                                        "1. Generate a new, unique token for every login. "
                                        "2. Invalidate previous tokens on new login. "
                                        "3. Include a unique jti (JWT ID) claim in each token. "
                                        "4. Implement token rotation on sensitive operations."
                                    ),
                                    cwe_id="CWE-384",
                                    cvss_score=7.5,
                                    references=[
                                        "https://owasp.org/www-community/attacks/Session_fixation"
                                    ],
                                )
                            )
                            return findings

                    except (httpx.TimeoutException, httpx.RequestError):
                        continue
                    except Exception:
                        logger.error(
                            "Error testing session fixation at %s%s",
                            target_url, path, exc_info=True,
                        )

        return findings

    @staticmethod
    def _extract_token(response_text: str) -> str | None:
        """Try to extract a JWT-like token from a JSON response."""
        try:
            data = json.loads(response_text)
        except (json.JSONDecodeError, ValueError):
            return None

        if isinstance(data, dict):
            data_str_keys: dict[str, Any] = data
            for key in ("token", "access_token", "jwt", "auth_token", "id_token"):
                if key in data_str_keys and isinstance(data_str_keys[key], str):
                    return str(data_str_keys[key])
        return None

    # ------------------------------------------------------------------
    # AUTH-006: Horizontal Privilege Escalation (IDOR)
    # ------------------------------------------------------------------

    async def _test_horizontal_escalation(self, target_url: str) -> list[Finding]:
        """Test for IDOR by accessing resources with sequential IDs."""
        findings: list[Finding] = []

        idor_paths = [
            "/api/users/{id}",
            "/api/scans/{id}",
            "/api/agents/{id}",
            "/api/profiles/{id}",
            "/api/v1/users/{id}",
        ]

        test_ids = ["1", "2", "3", "100"]

        claims = self._make_test_claims(email="user-999@agentguard.test")

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for secret in COMMON_WEAK_SECRETS[:3]:
                try:
                    token = generate_jwt(claims, secret)
                except Exception:
                    continue

                headers = {"Authorization": f"Bearer {token}"}

                for path_template in idor_paths:
                    for test_id in test_ids:
                        path = path_template.replace("{id}", test_id)
                        try:
                            url = f"{target_url.rstrip('/')}{path}"
                            response = await client.get(url, headers=headers)

                            if response.status_code == 200 and self._contains_other_user_data(
                                response.text, "user-999@agentguard.test"
                            ):
                                findings.append(
                                    Finding(
                                        id="AUTH-006",
                                        severity=SeverityLevel.HIGH,
                                        title=f"IDOR: Unauthorized Access to Resource {path}",
                                        description=(
                                            f"The endpoint {path} returns data belonging "
                                            f"to another user when accessed with a valid "
                                            f"authentication token. This indicates missing "
                                            f"object-level authorization checks."
                                        ),
                                        affected_endpoint=url,
                                        evidence=(
                                            f"Resource at {path} returned data for a "
                                            f"different user than the authenticated user. "
                                            f"Response preview: {response.text[:200]}"
                                        ),
                                        remediation=(
                                            "1. Implement object-level authorization: verify "
                                            "the authenticated user owns the requested resource. "
                                            "2. Use UUIDs instead of sequential IDs to prevent "
                                            "enumeration. "
                                            "3. Return 403 Forbidden when accessing others' "
                                            "resources. "
                                            "4. Add authorization middleware at the API layer."
                                        ),
                                        cwe_id="CWE-639",
                                        cvss_score=7.5,
                                        references=[
                                            "https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/"
                                        ],
                                    )
                                )
                                return findings

                        except (httpx.TimeoutException, httpx.RequestError):
                            continue
                        except Exception:
                            continue

        return findings

    @staticmethod
    def _contains_other_user_data(response_text: str, own_email: str) -> bool:
        """Check if response contains user data that doesn't belong to own_email."""
        try:
            data = json.loads(response_text)
        except (json.JSONDecodeError, ValueError):
            return False

        if isinstance(data, dict):
            response_email = data.get("email", "")
            if response_email and response_email != own_email:
                return True
            # Check for user_id mismatch
            if "user_id" in data or "owner_id" in data:
                return True
        return False

    # ------------------------------------------------------------------
    # AUTH-007: Vertical Privilege Escalation
    # ------------------------------------------------------------------

    async def _test_vertical_escalation(self, target_url: str) -> list[Finding]:
        """Test if elevated JWT claims grant admin access."""
        findings: list[Finding] = []

        admin_endpoints = [
            "/api/admin",
            "/api/admin/users",
            "/api/admin/settings",
            "/api/admin/config",
            "/admin",
            "/admin/dashboard",
            "/api/v1/admin",
        ]

        # Craft tokens with escalated claims
        admin_claim_sets: list[dict[str, object]] = [
            {"sub": "attacker@test.com", "role": "admin"},
            {"sub": "attacker@test.com", "is_admin": True, "role": "user"},
            {"sub": "attacker@test.com", "admin": True},
            {"sub": "attacker@test.com", "permissions": ["admin", "write", "delete"]},
        ]

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            for secret in COMMON_WEAK_SECRETS[:3]:
                for claims in admin_claim_sets:
                    try:
                        token = generate_jwt(claims, secret)
                    except Exception:
                        continue

                    headers = {"Authorization": f"Bearer {token}"}

                    for path in admin_endpoints:
                        try:
                            url = f"{target_url.rstrip('/')}{path}"
                            response = await client.get(url, headers=headers)

                            if response.status_code == 200 and self._looks_like_protected_data(
                                response.text
                            ):
                                findings.append(
                                    Finding(
                                        id="AUTH-007",
                                        severity=SeverityLevel.CRITICAL,
                                        title="Vertical Privilege Escalation via JWT Claims",
                                        description=(
                                            "Admin endpoints are accessible by crafting a JWT "
                                            "with elevated role claims. The server trusts the "
                                            "'role' or 'admin' claim in the token without "
                                            "verifying it against a server-side user database."
                                        ),
                                        affected_endpoint=url,
                                        evidence=(
                                            f"JWT with admin claims accepted at {path}. "
                                            f"HTTP {response.status_code}. "
                                            f"Response preview: {response.text[:200]}"
                                        ),
                                        remediation=(
                                            "1. Never trust role/permission claims from JWTs "
                                            "alone -- always verify against the user database. "
                                            "2. Use server-side session management for "
                                            "authorization decisions. "
                                            "3. Implement role-based access control (RBAC) at "
                                            "the application layer. "
                                            "4. Sign tokens with a strong, rotated secret."
                                        ),
                                        cwe_id="CWE-269",
                                        cvss_score=9.8,
                                        references=[
                                            "https://owasp.org/API-Security/editions/2023/en/0xa5-broken-function-level-authorization/"
                                        ],
                                    )
                                )
                                return findings

                        except (httpx.TimeoutException, httpx.RequestError):
                            continue
                        except Exception:
                            logger.error(
                                "Error testing vertical escalation at %s%s",
                                target_url, path, exc_info=True,
                            )

        return findings
