"""Cross-encoder reranker — phase 1c follow-up.

Takes a query plus a list of candidate texts and returns scores. Default
model is BAAI/bge-reranker-base. Two modes:

    RERANKER_MODE=real  (default)
        Loads sentence-transformers' CrossEncoder with BAAI/bge-reranker-base.
        First call pays the load cost (~280MB on disk, a few seconds);
        subsequent calls reuse the in-process model.

    RERANKER_MODE=stub
        Returns 0.0 for every candidate. Lets retrieval.ts run end-to-end
        in environments where torch isn't wanted (tests, CI, ultra-lean
        deploys). Caller decides whether to re-sort by rerank score.
"""

from __future__ import annotations

import os
import threading
from typing import Any

DEFAULT_RERANKER_MODEL = "BAAI/bge-reranker-base"
STUB_RERANKER_NAME = "stub"


class _RerankService:
    """Lazy-loaded cross-encoder. Thread-safe model load."""

    def __init__(self) -> None:
        self._mode: str = os.environ.get("RERANKER_MODE", "real").strip().lower()
        self._model: Any = None
        self._model_name: str = (
            STUB_RERANKER_NAME if self._mode == "stub" else DEFAULT_RERANKER_MODEL
        )
        self._lock = threading.Lock()

    @property
    def mode(self) -> str:
        return self._mode

    @property
    def model_name(self) -> str:
        return self._model_name

    def _ensure_real_model(self) -> Any:
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is not None:
                return self._model
            try:
                from sentence_transformers import CrossEncoder  # type: ignore[import-not-found]
            except ImportError as e:
                raise RuntimeError(
                    "RERANKER_MODE=real but sentence-transformers is not installed; "
                    "run `uv pip install sentence-transformers` or set RERANKER_MODE=stub"
                ) from e
            self._model = CrossEncoder(DEFAULT_RERANKER_MODEL)
            return self._model

    def score(self, query: str, candidates: list[str]) -> list[float]:
        if not candidates:
            return []
        if self._mode == "stub":
            return [0.0] * len(candidates)
        model = self._ensure_real_model()
        pairs = [[query, c] for c in candidates]
        # CrossEncoder.predict returns numpy floats; convert to plain Python.
        scores = model.predict(pairs)
        return [float(s) for s in scores]


_singleton: _RerankService | None = None
_singleton_lock = threading.Lock()


def get_service() -> _RerankService:
    global _singleton
    if _singleton is None:
        with _singleton_lock:
            if _singleton is None:
                _singleton = _RerankService()
    return _singleton


def reset_service_for_testing() -> None:
    global _singleton
    with _singleton_lock:
        _singleton = None


def preload() -> tuple[bool, str]:
    """Best-effort warm-up. Returns (loaded, message)."""
    svc = get_service()
    if svc.mode != "real":
        return False, f"mode={svc.mode}, no preload needed"
    try:
        svc._ensure_real_model()  # noqa: SLF001
        return True, f"loaded {svc.model_name}"
    except Exception as e:  # noqa: BLE001
        return False, f"preload failed: {e}"
