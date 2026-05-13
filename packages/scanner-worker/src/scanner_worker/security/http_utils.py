"""
Resilient HTTP utilities for the scanner engine.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

logger = logging.getLogger("agentguard.http")


async def resilient_get(
    client: httpx.AsyncClient,
    url: str,
    *,
    max_retries: int = 2,
    **kwargs: Any,
) -> httpx.Response:
    """GET with automatic retry on transient network errors.

    Retries on ``httpx.TimeoutException`` and ``httpx.RequestError`` with
    exponential back-off (0.5s, 1s).  Non-retryable errors are re-raised
    immediately.

    Args:
        client: An already-open ``httpx.AsyncClient``.
        url: Target URL.
        max_retries: Maximum number of retry attempts (default 2).
        **kwargs: Forwarded to ``client.get()``.

    Returns:
        The ``httpx.Response`` on success.

    Raises:
        httpx.TimeoutException: If all retries exhausted due to timeouts.
        httpx.RequestError: If all retries exhausted due to connection errors.
    """
    last_exc: Exception | None = None
    for attempt in range(1 + max_retries):
        try:
            return await client.get(url, **kwargs)
        except (httpx.TimeoutException, httpx.RequestError) as exc:
            last_exc = exc
            if attempt < max_retries:
                delay = 0.5 * (2 ** attempt)
                logger.warning(
                    "Retry %d/%d for %s after %s: %s",
                    attempt + 1,
                    max_retries,
                    url,
                    type(exc).__name__,
                    exc,
                )
                await asyncio.sleep(delay)
    raise last_exc  # type: ignore[misc]
