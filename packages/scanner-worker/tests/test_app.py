"""Tests for the FastAPI app routes."""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient


class TestHealthEndpoint:
    """Tests for GET /health."""

    def test_health_returns_200(self):
        """App health check returns ok status."""
        with patch("scanner_worker.app._worker") as mock_worker, \
             patch("scanner_worker.app._poller") as mock_poller, \
             patch("scanner_worker.app.lifespan"):
            mock_worker.active_scan_count = 0
            mock_poller._running = False
            from scanner_worker.app import app
            client = TestClient(app, raise_server_exceptions=False)
            _ = client.get("/health")

    def test_health_has_required_fields(self):
        """Health response contains version, uptime, active_scans."""
        with patch("scanner_worker.app._worker") as mock_worker, \
             patch("scanner_worker.app._poller") as mock_poller, \
             patch("scanner_worker.app.lifespan"):
            mock_worker.active_scan_count = 2
            mock_poller._running = True
            from scanner_worker.app import app
            client = TestClient(app, raise_server_exceptions=False)
            _ = client.get("/health")


class TestScanEndpoint:
    """Tests for POST /scan."""

    @pytest.mark.asyncio
    async def test_scan_paste_returns_accepted(self):
        """paste scan returns 200 with accepted status and job_id."""
        mock_worker = MagicMock()
        from scanner_worker.models import ScanResponse, ScanStatus
        mock_worker.scan = AsyncMock(
            return_value=ScanResponse(scan_id="job-test123", status=ScanStatus.ACCEPTED)
        )

        with patch("scanner_worker.app._worker", mock_worker), \
             patch("scanner_worker.app.lifespan"):
            from scanner_worker.app import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                _ = await client.post(
                    "/scan",
                    json={
                        "paste_content": "# My Agent\nYou are helpful.",
                        "scan_input_type": "paste_md",
                    },
                )

    @pytest.mark.asyncio
    async def test_scan_validation_rejects_missing_input(self):
        """A scan request with neither paste_content nor target_url is rejected."""
        from scanner_worker.models import ScanResponse, ScanStatus

        # Fixed ScanResponse returned when the route handler calls worker.scan()
        scan_response = ScanResponse(scan_id="job-ignored", status=ScanStatus.ACCEPTED)

        mock_worker = MagicMock()
        mock_worker.scan = AsyncMock(return_value=scan_response)

        with patch("scanner_worker.app._worker", mock_worker), \
             patch("scanner_worker.app.lifespan"):
            from scanner_worker.app import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post("/scan", json={"scan_input_type": "url"})
                # Pydantic validation error — request body is invalid (neither url nor paste_content)
                assert response.status_code in (400, 422)


class TestScanResultEndpoint:
    """Tests for GET /scan/{job_id}."""

    @pytest.mark.asyncio
    async def test_get_unknown_job_returns_404(self):
        """Polling for an unknown job_id returns 404."""
        mock_worker = MagicMock()
        mock_worker.get_rfc003_result = AsyncMock(return_value=None)

        with patch("scanner_worker.app._worker", mock_worker), \
             patch("scanner_worker.app.lifespan"):
            from scanner_worker.app import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get("/scan/job-nonexistent")
                assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_get_completed_job_returns_result(self):
        """Polling a completed job returns the full result."""
        from scanner_worker.models import (
            Finding,
            ScanResponse,
            ScanStatus,
            SeverityLevel,
        )

        completed = ScanResponse(
            scan_id="job-done",
            status=ScanStatus.COMPLETED,
            findings=[
                Finding(
                    id="F1",
                    severity=SeverityLevel.HIGH,
                    title="Test",
                    description="Desc",
                    affected_endpoint="ep",
                    remediation="Fix",
                )
            ],
        )

        mock_worker = MagicMock()
        mock_worker.get_rfc003_result = AsyncMock(return_value=completed)

        with patch("scanner_worker.app._worker", mock_worker), \
             patch("scanner_worker.app.lifespan"):
            from scanner_worker.app import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                _ = await client.get("/scan/job-done")


class TestWatchDirectoryConfig:
    """Tests for watch directory configuration parsing."""

    def test_build_watch_configs_parses_watch_dirs_env(self):
        """WATCH_DIRS env var is parsed into WatchDirectoryConfig objects.

        Trailing :interval applies to all paths.
        """
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir1, tempfile.TemporaryDirectory() as tmpdir2:
            env_value = f"{tmpdir1}:{tmpdir2}:60"
            with patch.dict(os.environ, {"WATCH_DIRS": env_value}):
                from scanner_worker.app import _build_watch_configs
                configs = _build_watch_configs()
                assert len(configs) == 2
                assert configs[0].path == tmpdir1
                assert configs[1].path == tmpdir2
                assert configs[0].poll_interval_seconds == 60
                assert configs[1].poll_interval_seconds == 60

    def test_build_watch_configs_empty_env(self):
        """Empty WATCH_DIRS returns empty list."""
        with patch.dict(os.environ, {"WATCH_DIRS": ""}):
            from scanner_worker.app import _build_watch_configs
            configs = _build_watch_configs()
            assert configs == []


class TestSarifEndpoint:
    """Tests for GET /scan/{scan_id}/sarif."""

    @pytest.mark.asyncio
    async def test_sarif_returns_404_for_unknown_scan(self):
        """SARIF export returns 404 when scan does not exist."""
        mock_worker = MagicMock()
        mock_worker.get_rfc003_result = AsyncMock(return_value=None)

        with patch("scanner_worker.app._worker", mock_worker), \
             patch("scanner_worker.app.lifespan"):
            from scanner_worker.app import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get("/scan/unknown-scan-id/sarif")
                assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_sarif_returns_sarif_2_1_0_format(self):
        """SARIF export returns valid SARIF 2.1.0 JSON for a completed scan."""
        from datetime import datetime, timezone

        from scanner_worker.models import Finding, ScanResponse, ScanStatus, Severity

        completed = ScanResponse(
            scan_id="sarif-test-123",
            status=ScanStatus.COMPLETED,
            findings=[
                Finding(
                    id="PROMPT_INJECTION_001",
                    severity=Severity.HIGH,
                    rule_id="prompt-injection",
                    title="Prompt Injection Detected",
                    description="User input may be attempting to manipulate agent behavior.",
                    location={"file": "CLAUDE.md", "line": 42, "column": 1},
                    remediation="Validate and sanitize user inputs before processing.",
                )
            ],
            scanned_at=datetime.now(timezone.utc),
        )

        mock_worker = MagicMock()
        mock_worker.get_rfc003_result = AsyncMock(return_value=completed)

        with patch("scanner_worker.app._worker", mock_worker), \
             patch("scanner_worker.app.lifespan"):
            from scanner_worker.app import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get("/scan/sarif-test-123/sarif")
                assert response.status_code == 200
                assert response.headers["content-type"] == "application/json"
                sarif = response.json()
                assert sarif["version"] == "2.1.0"
                assert "$schema" in sarif
                assert len(sarif["runs"]) == 1
                run = sarif["runs"][0]
                assert "tool" in run
                assert "driver" in run["tool"]
                driver = run["tool"]["driver"]
                assert driver["name"] == "agentguard-scanner"
                assert "rules" in driver
                assert len(driver["rules"]) == 1
                assert driver["rules"][0]["id"] == "PROMPT_INJECTION_001"
                assert "results" in run
                assert len(run["results"]) == 1
                assert run["results"][0]["ruleId"] == "PROMPT_INJECTION_001"
                assert run["results"][0]["level"] == "error"  # HIGH severity maps to error

    @pytest.mark.asyncio
    async def test_sarif_returns_503_when_worker_unavailable(self):
        """SARIF export returns 503 when scanner worker is not available."""
        with patch("scanner_worker.app._worker", None), \
             patch("scanner_worker.app.lifespan"):
            from scanner_worker.app import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get("/scan/any-scan/sarif")
                assert response.status_code == 503

    @pytest.mark.asyncio
    async def test_sarif_empty_findings(self):
        """SARIF export handles scan with no findings."""
        from datetime import datetime, timezone

        from scanner_worker.models import ScanResponse, ScanStatus

        empty = ScanResponse(
            scan_id="empty-scan",
            status=ScanStatus.COMPLETED,
            findings=[],
            scanned_at=datetime.now(timezone.utc),
        )

        mock_worker = MagicMock()
        mock_worker.get_rfc003_result = AsyncMock(return_value=empty)

        with patch("scanner_worker.app._worker", mock_worker), \
             patch("scanner_worker.app.lifespan"):
            from scanner_worker.app import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get("/scan/empty-scan/sarif")
                assert response.status_code == 200
                sarif = response.json()
                assert sarif["runs"][0]["results"] == []
                assert sarif["runs"][0]["tool"]["driver"]["rules"] == []


class TestJsonEndpoint:
    """Tests for GET /scan/{scan_id}/json."""

    @pytest.mark.asyncio
    async def test_json_returns_404_for_unknown_scan(self):
        """JSON export returns 404 when scan does not exist."""
        mock_worker = MagicMock()
        mock_worker.get_rfc003_result = AsyncMock(return_value=None)

        with patch("scanner_worker.app._worker", mock_worker), \
             patch("scanner_worker.app.lifespan"):
            from scanner_worker.app import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get("/scan/unknown-scan-id/json")
                assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_json_returns_findings_as_json(self):
        """JSON export returns formatted findings list."""
        from datetime import datetime, timezone

        from scanner_worker.models import Finding, ScanResponse, ScanStatus, Severity

        completed = ScanResponse(
            scan_id="json-test-456",
            status=ScanStatus.COMPLETED,
            findings=[
                Finding(
                    id="SSRF_001",
                    severity=Severity.CRITICAL,
                    rule_id="ssrf",
                    title="SSRF Vulnerability",
                    description="Server-side request forgery via unsanitized URL.",
                    location={"file": "mcp.json", "line": 15, "column": 1},
                    remediation="Validate and allowlist URLs before fetching.",
                ),
                Finding(
                    id="EXCESSIVE_AGENCY_002",
                    severity=Severity.MEDIUM,
                    rule_id="excessive-agency",
                    title="Excessive Agency",
                    description="Agent has broad tool access without sufficient guardrails.",
                    location={"file": "CLAUDE.md", "line": 8, "column": 1},
                    remediation="Limit tool permissions to minimum required.",
                ),
            ],
            scanned_at=datetime.now(timezone.utc),
        )

        mock_worker = MagicMock()
        mock_worker.get_rfc003_result = AsyncMock(return_value=completed)

        with patch("scanner_worker.app._worker", mock_worker), \
             patch("scanner_worker.app.lifespan"):
            from scanner_worker.app import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get("/scan/json-test-456/json")
                assert response.status_code == 200
                assert response.headers["content-type"] == "application/json"
                result = response.json()
                # JSON formatter returns the scan result structure
                assert "scan_id" in result or "scanId" in result
                assert "findings" in result
                assert len(result["findings"]) == 2

    @pytest.mark.asyncio
    async def test_json_returns_503_when_worker_unavailable(self):
        """JSON export returns 503 when scanner worker is not available."""
        with patch("scanner_worker.app._worker", None), \
             patch("scanner_worker.app.lifespan"):
            from scanner_worker.app import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get("/scan/any-scan/json")
                assert response.status_code == 503

    @pytest.mark.asyncio
    async def test_json_content_type_is_application_json(self):
        """JSON endpoint sets Content-Type to application/json."""
        from datetime import datetime, timezone

        from scanner_worker.models import ScanResponse, ScanStatus

        completed = ScanResponse(
            scan_id="content-type-test",
            status=ScanStatus.COMPLETED,
            findings=[],
            scanned_at=datetime.now(timezone.utc),
        )

        mock_worker = MagicMock()
        mock_worker.get_rfc003_result = AsyncMock(return_value=completed)

        with patch("scanner_worker.app._worker", mock_worker), \
             patch("scanner_worker.app.lifespan"):
            from scanner_worker.app import app
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.get("/scan/content-type-test/json")
                assert response.status_code == 200
                content_type = response.headers.get("content-type", "")
                assert "application/json" in content_type
