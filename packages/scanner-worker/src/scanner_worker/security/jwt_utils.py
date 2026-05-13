"""
JWT manipulation utilities for security testing.

Provides functions to craft malformed, expired, and unsigned JWT tokens
for testing authentication vulnerabilities in target AI agents.
"""

import base64
import json
from datetime import datetime, timedelta, timezone
from typing import Any


def base64url_encode(data: bytes | str) -> str:
    """Base64URL encode data (no padding)."""
    if isinstance(data, str):
        data = data.encode()
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def base64url_decode(data: str) -> bytes:
    """Base64URL decode data (handles missing padding)."""
    padding = 4 - len(data) % 4
    if padding != 4:
        data += "=" * padding
    return base64.urlsafe_b64decode(data)


def generate_jwt(
    payload: dict[str, Any],
    secret: str,
    algorithm: str = "HS256",
) -> str:
    """Generate a signed JWT token using python-jose."""
    from jose import jwt as jose_jwt

    return jose_jwt.encode(payload, secret, algorithm=algorithm)


def generate_expired_jwt(
    payload: dict[str, Any],
    secret: str,
    algorithm: str = "HS256",
    expired_hours: int = 24,
) -> str:
    """Generate a JWT token with exp set in the past."""
    payload = payload.copy()
    payload["exp"] = datetime.now(timezone.utc) - timedelta(hours=expired_hours)
    # python-jose checks exp at encode time by default; use options to skip
    from jose import jwt as jose_jwt

    return jose_jwt.encode(payload, secret, algorithm=algorithm)


def generate_none_algorithm_jwt(payload: dict[str, Any]) -> str:
    """Generate a JWT with 'alg: none' and empty signature.

    Hand-crafted because JWT libraries refuse to sign with the none algorithm.
    """
    header = base64url_encode(json.dumps({"alg": "none", "typ": "JWT"}, separators=(",", ":")))
    body = base64url_encode(json.dumps(payload, separators=(",", ":"), default=str))
    return f"{header}.{body}."


def generate_none_algorithm_jwt_variant(payload: dict[str, Any], alg_value: str) -> str:
    """Generate a JWT with a case-variant of 'none' (None, NONE, nOnE, etc.)."""
    header = base64url_encode(
        json.dumps({"alg": alg_value, "typ": "JWT"}, separators=(",", ":"))
    )
    body = base64url_encode(json.dumps(payload, separators=(",", ":"), default=str))
    return f"{header}.{body}."


def generate_corrupted_signature_jwt(
    payload: dict[str, Any],
    secret: str,
    algorithm: str = "HS256",
) -> str:
    """Generate a valid JWT then corrupt its signature."""
    token = generate_jwt(payload, secret, algorithm)
    parts = token.split(".")
    if len(parts) == 3:
        sig = parts[2]
        # Flip first character of signature
        corrupted = chr(ord(sig[0]) ^ 0x01) + sig[1:] if sig else "AAAA"
        return f"{parts[0]}.{parts[1]}.{corrupted}"
    return token


def generate_truncated_signature_jwt(
    payload: dict[str, Any],
    secret: str,
    algorithm: str = "HS256",
) -> str:
    """Generate a valid JWT then truncate its signature to 4 chars."""
    token = generate_jwt(payload, secret, algorithm)
    parts = token.split(".")
    if len(parts) == 3:
        return f"{parts[0]}.{parts[1]}.{parts[2][:4]}"
    return token


def decode_jwt_unverified(token: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Decode a JWT without verification, returning (header, payload)."""
    parts = token.split(".")
    if len(parts) < 2:
        return {}, {}
    header = json.loads(base64url_decode(parts[0]))
    payload = json.loads(base64url_decode(parts[1]))
    return header, payload


COMMON_WEAK_SECRETS = [
    "secret",
    "changeme",
    "password",
    "jwt-secret",
    "your-secret-key",
    "123456",
    "key",
    "test",
    "dev",
    "development",
    "",
]
