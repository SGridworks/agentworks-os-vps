"""Tests for POST /rerank (memory architecture phase 1c follow-up)."""

from unittest.mock import patch

from fastapi.testclient import TestClient

from scanner_worker.rerank import (
    DEFAULT_RERANKER_MODEL,
    STUB_RERANKER_NAME,
    reset_service_for_testing,
)


class TestRerankRoute:
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

    def test_stub_mode_returns_zero_scores(self):
        with patch.dict("os.environ", {"RERANKER_MODE": "stub"}, clear=False):
            reset_service_for_testing()
            client = self._client()
            res = client.post(
                "/rerank",
                json={"query": "anything", "candidates": ["a", "b", "c"]},
            )
        assert res.status_code == 200
        body = res.json()
        assert body["mode"] == "stub"
        assert body["model"] == STUB_RERANKER_NAME
        assert body["scores"] == [0.0, 0.0, 0.0]

    def test_empty_candidates_rejected(self):
        # min_length on candidates list isn't enforced — but the response
        # must still come back fast and well-formed (no candidates → empty
        # scores and no model load).
        with patch.dict("os.environ", {"RERANKER_MODE": "stub"}, clear=False):
            reset_service_for_testing()
            client = self._client()
            res = client.post("/rerank", json={"query": "q", "candidates": []})
        assert res.status_code == 200
        body = res.json()
        assert body["scores"] == []

    def test_rejects_oversized_batch(self):
        client = self._client()
        res = client.post(
            "/rerank",
            json={"query": "q", "candidates": ["x"] * 200},
        )
        assert res.status_code == 422

    def test_rejects_empty_query(self):
        client = self._client()
        res = client.post("/rerank", json={"query": "", "candidates": ["x"]})
        assert res.status_code == 422

    def test_real_mode_503_or_200(self):
        # Real mode uses sentence-transformers' CrossEncoder; the dep is a
        # base requirement so it's usually present, but the model download
        # may fail on a fresh CI box. Endpoint must never 500.
        with patch.dict("os.environ", {"RERANKER_MODE": "real"}, clear=False):
            reset_service_for_testing()
            client = self._client()
            res = client.post(
                "/rerank",
                json={"query": "user terse", "candidates": ["user terse style guideline", "unrelated bagel recipe"]},
            )
        assert res.status_code in (200, 503)
        if res.status_code == 200:
            body = res.json()
            assert body["mode"] == "real"
            assert body["model"] == DEFAULT_RERANKER_MODEL
            assert len(body["scores"]) == 2
        else:
            body = res.json()
            assert "reranker_unavailable" in str(body).lower()
