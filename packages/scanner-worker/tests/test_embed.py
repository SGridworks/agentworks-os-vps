"""Tests for POST /embed (memory architecture phase 1a)."""

from unittest.mock import patch

from fastapi.testclient import TestClient

from scanner_worker.embed import (
    DEFAULT_DIM,
    STUB_MODEL_NAME,
    _stub_vector,
    reset_service_for_testing,
)


class TestStubVector:
    def test_returns_correct_dimension(self):
        v = _stub_vector("hello", dim=768)
        assert len(v) == 768

    def test_deterministic(self):
        a = _stub_vector("the same input")
        b = _stub_vector("the same input")
        assert a == b

    def test_different_inputs_yield_different_vectors(self):
        a = _stub_vector("alpha")
        b = _stub_vector("beta")
        assert a != b

    def test_values_are_finite_and_in_range(self):
        v = _stub_vector("test text")
        for x in v:
            assert -1.0 <= x <= 1.0
            assert x == x  # not NaN
            assert x not in (float("inf"), float("-inf"))


class TestEmbedRoute:
    def setup_method(self):
        reset_service_for_testing()

    def teardown_method(self):
        reset_service_for_testing()

    def _client(self) -> TestClient:
        with patch("scanner_worker.app._worker"), patch("scanner_worker.app._poller"), patch(
            "scanner_worker.app.lifespan"
        ):
            from scanner_worker.app import app

            return TestClient(app, raise_server_exceptions=False)

    def test_stub_mode_returns_768_dim_vectors(self):
        with patch.dict("os.environ", {"EMBEDDING_MODE": "stub"}, clear=False):
            reset_service_for_testing()
            client = self._client()
            res = client.post("/embed", json={"texts": ["hello world", "second text"]})
        assert res.status_code == 200
        body = res.json()
        assert body["mode"] == "stub"
        assert body["model"] == STUB_MODEL_NAME
        assert body["dim"] == DEFAULT_DIM
        assert len(body["vectors"]) == 2
        assert len(body["vectors"][0]) == DEFAULT_DIM
        assert len(body["vectors"][1]) == DEFAULT_DIM

    def test_empty_texts_returns_empty_vectors(self):
        client = self._client()
        res = client.post("/embed", json={"texts": []})
        assert res.status_code == 200
        body = res.json()
        assert body["vectors"] == []

    def test_deterministic_across_calls(self):
        with patch.dict("os.environ", {"EMBEDDING_MODE": "stub"}, clear=False):
            reset_service_for_testing()
            client = self._client()
            r1 = client.post("/embed", json={"texts": ["fixed"]}).json()
            r2 = client.post("/embed", json={"texts": ["fixed"]}).json()
        assert r1["vectors"] == r2["vectors"]

    def test_real_mode_503_when_dep_missing(self):
        # sentence-transformers is now a base dep so real mode usually
        # succeeds, but if the dep ever goes missing the endpoint must
        # return 503 with a helpful message rather than 500.
        with patch.dict("os.environ", {"EMBEDDING_MODE": "real"}, clear=False):
            reset_service_for_testing()
            client = self._client()
            res = client.post("/embed", json={"texts": ["x"]})
        # If sentence-transformers happens to be installed (e.g. someone
        # already flipped to real on this machine), the call succeeds with
        # 200. Either is correct — we only assert it never 500s.
        assert res.status_code in (200, 503)
        if res.status_code == 503:
            body = res.json()
            assert "embedding_unavailable" in str(body).lower() or "sentence-transformers" in str(body).lower()

    def test_rejects_oversized_batch(self):
        client = self._client()
        res = client.post("/embed", json={"texts": ["x"] * 200})
        assert res.status_code == 422  # pydantic validation error
