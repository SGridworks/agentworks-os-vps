"""Embedding service — phase 1a of AgentWorks OS memory architecture.

Exposes BAAI/bge-base-en-v1.5 via a dependency-light wrapper. Two modes:

    EMBEDDING_MODE=real  (default)
        Loads sentence-transformers and the BAAI/bge-base-en-v1.5 model.
        First call pays the load cost (~700MB on disk, a few seconds);
        subsequent calls reuse the in-process model. Pre-warm via
        `preload()` to pay the cost at startup instead of first request.

    EMBEDDING_MODE=stub
        Returns a deterministic 768-dim hash-based vector per text.
        Useful for tests, CI, and environments where torch is unwanted.
        Model name is reported as "stub" so callers can detect mismatches
        if they later load a real model on top of stub-embedded rows.

Design intent: the agentos-d EmbedClient never sees the difference. Both
modes return the same JSON shape and the same dim. We can flip from stub
to real without a coordinated deploy.
"""

from __future__ import annotations

import hashlib
import os
import struct
import threading
from typing import Any

DEFAULT_DIM = 768
DEFAULT_MODEL_NAME = "BAAI/bge-base-en-v1.5"
STUB_MODEL_NAME = "stub"


def _stub_vector(text: str, dim: int = DEFAULT_DIM) -> list[float]:
    """Deterministic hash-based vector. Same text → same vector across runs.

    Not semantically meaningful — just enough to round-trip BLOB storage,
    test the shape of downstream code, and prevent the embedding column
    from being NULL during dev/test.
    """
    seed = hashlib.sha256(text.encode("utf-8")).digest()
    out: list[float] = []
    needed = dim
    counter = 0
    while needed > 0:
        block = hashlib.sha256(seed + counter.to_bytes(4, "little")).digest()
        # 64 bytes / 4-byte float = 16 floats per block
        for i in range(0, len(block), 4):
            if needed <= 0:
                break
            f = struct.unpack("<f", block[i : i + 4])[0]
            # Normalise to roughly [-1, 1] without NaN/inf for numerical safety
            if not (f == f) or abs(f) == float("inf"):  # NaN or inf
                f = 0.0
            else:
                # squash to a stable range
                f = max(-1.0, min(1.0, f / 1e30))
            out.append(f)
            needed -= 1
        counter += 1
    return out


class _EmbeddingService:
    """Lazy-loaded embedding service. Thread-safe model load."""

    def __init__(self) -> None:
        self._mode: str = os.environ.get("EMBEDDING_MODE", "real").strip().lower()
        self._model: Any = None
        self._model_name: str = (
            STUB_MODEL_NAME if self._mode == "stub" else DEFAULT_MODEL_NAME
        )
        self._dim: int = DEFAULT_DIM
        self._lock = threading.Lock()

    @property
    def mode(self) -> str:
        return self._mode

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def dim(self) -> int:
        return self._dim

    def _ensure_real_model(self) -> Any:
        if self._model is not None:
            return self._model
        with self._lock:
            if self._model is not None:
                return self._model
            try:
                from sentence_transformers import SentenceTransformer  # type: ignore[import-not-found]
            except ImportError as e:
                raise RuntimeError(
                    "EMBEDDING_MODE=real but sentence-transformers is not installed; "
                    "run `uv pip install sentence-transformers` or set EMBEDDING_MODE=stub"
                ) from e
            self._model = SentenceTransformer(DEFAULT_MODEL_NAME)
            self._dim = int(self._model.get_sentence_embedding_dimension() or DEFAULT_DIM)
            return self._model

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        if self._mode == "stub":
            return [_stub_vector(t, self._dim) for t in texts]

        model = self._ensure_real_model()
        # encode returns a numpy array; convert to plain Python lists for JSON
        vectors = model.encode(texts, normalize_embeddings=True)
        return [v.tolist() for v in vectors]


_singleton: _EmbeddingService | None = None
_singleton_lock = threading.Lock()


def get_service() -> _EmbeddingService:
    global _singleton
    if _singleton is None:
        with _singleton_lock:
            if _singleton is None:
                _singleton = _EmbeddingService()
    return _singleton


def reset_service_for_testing() -> None:
    global _singleton
    with _singleton_lock:
        _singleton = None


def preload() -> tuple[bool, str]:
    """Eagerly initialize the model so the first /embed call is fast.

    Best-effort: if the dep is missing or load fails we don't crash the
    service — stub mode still works and real mode will surface the same
    error on first request. Returns (loaded, message).
    """
    svc = get_service()
    if svc.mode != "real":
        return False, f"mode={svc.mode}, no preload needed"
    try:
        svc._ensure_real_model()  # noqa: SLF001 — internal warm-up
        return True, f"loaded {svc.model_name} (dim={svc.dim})"
    except Exception as e:  # noqa: BLE001 — best-effort warm-up
        return False, f"preload failed: {e}"
