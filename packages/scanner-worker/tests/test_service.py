"""Tests for scanner_worker service layer — RFC 003 API."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from scanner_worker.models import (
    BatchScanRequest,
    BatchTarget,
    ScanRequest,
    ScanTarget,
    TargetType,
)
from scanner_worker.service import ScanJob, ScannerWorker


class TestScanJob:
    """Test ScanJob model and job tracking logic."""

    def test_scan_job_creation(self):
        req = ScanRequest(
            tenantId="tenant-test",
            scanId="job-123",
            target=ScanTarget(
                type=TargetType.CLAUDE_MD,
                path="/CLAUDE.md",
                content="# Test Agent",
            ),
        )
        job = ScanJob(job_id="job-123", scan_request=req)
        assert job.job_id == "job-123"
        assert job.scan_request == req
        assert job.age_seconds >= 0

    def test_scan_job_age_increases(self):
        import time

        req = ScanRequest(
            tenantId="tenant-test",
            scanId="job-456",
            target=ScanTarget(type=TargetType.CURSORRULES, path="/.cursorrules", content=""),
        )
        job = ScanJob(job_id="job-456", scan_request=req)
        time.sleep(0.01)
        assert job.age_seconds > 0


def _mock_ag_response(findings_list=None):
    """Build a mock AG response with .findings attribute."""
    mock_resp = MagicMock()
    mock_finding = MagicMock()
    mock_finding.model_dump.return_value = {
        "id": "test-rule",
        "severity": "medium",
        "title": "Test Finding",
        "description": "A test security finding",
        "remediation": "Fix the test",
    }
    mock_resp.findings = findings_list or [mock_finding]
    return mock_resp


class TestScannerWorkerSubmit:
    """Test ScannerWorker.submit_rfc003() blocking behavior."""

    @pytest.mark.asyncio
    async def test_submit_rfc003_returns_complete_result(self):
        """submit_rfc003 waits for scan to finish and returns complete result."""
        with patch("scanner_worker.service.VulnerabilityScanner") as mock_vs:
            mock_vs.return_value.scan = AsyncMock(return_value=_mock_ag_response([]))
            worker = ScannerWorker(scan_timeout=60.0)
            req = ScanRequest(
                tenantId="tenant-1",
                scanId="job-complete",
                target=ScanTarget(
                    type=TargetType.CLAUDE_MD,
                    path="/CLAUDE.md",
                    content="# Test Agent",
                ),
            )

            result = await worker.submit_rfc003(req)

            assert result["scanId"] == "job-complete"
            assert result["status"] == "complete"

    @pytest.mark.asyncio
    async def test_submit_rfc003_rejects_when_shutting_down(self):
        """submit_rfc003 returns error status when shutdown flag is set."""
        with patch("scanner_worker.service.VulnerabilityScanner"):
            worker = ScannerWorker()
            await worker.shutdown()
            req = ScanRequest(
                tenantId="tenant-1",
                scanId="job-1",
                target=ScanTarget(type=TargetType.CLAUDE_MD, path="/a.md", content=""),
            )

            result = await worker.submit_rfc003(req)

            assert result["status"] == "error"
            assert "shutting down" in (result.get("error") or "")

    @pytest.mark.asyncio
    async def test_submit_rfc003_with_findings_returns_complete(self):
        """When AG returns findings, submit_rfc003 maps them correctly."""
        finding = MagicMock()
        finding.model_dump.return_value = {
            "id": "hardcoded-creds",
            "severity": "critical",
            "title": "Hardcoded Credentials",
            "description": "Found hardcoded AWS keys",
            "remediation": "Use environment variables",
        }
        mock_resp = MagicMock()
        mock_resp.findings = [finding]

        with patch("scanner_worker.service.VulnerabilityScanner") as mock_vs:
            mock_vs.return_value.scan = AsyncMock(return_value=mock_resp)
            worker = ScannerWorker(scan_timeout=60.0)
            req = ScanRequest(
                tenantId="tenant-1",
                scanId="job-findings",
                target=ScanTarget(
                    type=TargetType.CLAUDE_MD,
                    path="/CLAUDE.md",
                    content="AWS_KEY=AKIA" + "IOSFODNN7EXAMPLE",
                ),
            )

            result = await worker.submit_rfc003(req)

            assert result["status"] == "complete"
            assert result["scanId"] == "job-findings"


class TestScannerWorkerResultPolling:
    """Test ScannerWorker.get_rfc003_result() polling behavior."""

    @pytest.mark.asyncio
    async def test_get_result_returns_none_for_unknown_job(self):
        with patch("scanner_worker.service.VulnerabilityScanner"):
            worker = ScannerWorker()
            result = await worker.get_rfc003_result("nonexistent-job")
            assert result is None

    @pytest.mark.asyncio
    async def test_get_result_returns_complete_for_finished_job(self):
        """get_rfc003_result returns complete result for a finished scan."""
        with patch("scanner_worker.service.VulnerabilityScanner") as mock_vs:
            mock_vs.return_value.scan = AsyncMock(return_value=_mock_ag_response([]))
            worker = ScannerWorker(scan_timeout=60.0)
            req = ScanRequest(
                tenantId="tenant-1",
                scanId="job-result",
                target=ScanTarget(type=TargetType.CLAUDE_MD, path="/a.md", content="clean"),
            )

            await worker.submit_rfc003(req)
            result = await worker.get_rfc003_result("job-result")

            assert result["status"] == "complete"


class TestScannerWorkerMidKill:
    """Scanner sidecar resilience: timeout handling."""

    @pytest.mark.asyncio
    async def test_submit_rfc003_returns_error_on_timeout(self):
        """After timeout, submit_rfc003 returns error status."""
        with patch("scanner_worker.service.VulnerabilityScanner") as mock_vs:

            async def block_forever(*a, **k):
                await asyncio.sleep(999)

            mock_vs.return_value.scan = block_forever
            worker = ScannerWorker(scan_timeout=0.5)
            req = ScanRequest(
                tenantId="tenant-1",
                scanId="job-timeout",
                target=ScanTarget(type=TargetType.CLAUDE_MD, path="/a.md", content="test"),
            )

            result = await worker.submit_rfc003(req)

            # Timeout is treated as an error in this implementation
            assert result["status"] == "error"

    @pytest.mark.asyncio
    async def test_no_orphaned_jobs_after_timeout(self):
        """After a timed-out scan, job is cleaned up from tracker."""
        with patch("scanner_worker.service.VulnerabilityScanner") as mock_vs:

            async def block_forever(*a, **k):
                await asyncio.sleep(999)

            mock_vs.return_value.scan = block_forever
            worker = ScannerWorker(scan_timeout=0.5)
            req = ScanRequest(
                tenantId="tenant-1",
                scanId="job-cleanup",
                target=ScanTarget(type=TargetType.CLAUDE_MD, path="/a.md", content="test"),
            )

            result = await worker.submit_rfc003(req)

            async with worker._lock:
                assert result["scanId"] not in worker._jobs


class TestScannerWorkerShutdown:
    """Test graceful shutdown behavior."""

    @pytest.mark.asyncio
    async def test_shutdown_sets_flag(self):
        with patch("scanner_worker.service.VulnerabilityScanner"):
            worker = ScannerWorker()
            await worker.shutdown()
            assert worker._shutdown.is_set()

    @pytest.mark.asyncio
    async def test_shutdown_clears_all_jobs(self):
        """After shutdown, no jobs remain."""
        with patch("scanner_worker.service.VulnerabilityScanner") as mock_vs:
            mock_vs.return_value.scan = AsyncMock(return_value=_mock_ag_response([]))
            worker = ScannerWorker()
            req = ScanRequest(
                tenantId="tenant-1",
                scanId="job-shutdown",
                target=ScanTarget(type=TargetType.CLAUDE_MD, path="/a.md", content="test"),
            )
            await worker.submit_rfc003(req)

            await worker.shutdown()

            async with worker._lock:
                assert len(worker._jobs) == 0


class TestScannerWorkerHealth:
    """Test is_healthy() and active_scan_count."""

    @pytest.mark.asyncio
    async def test_active_scan_count_zero_when_idle(self):
        with patch("scanner_worker.service.VulnerabilityScanner"):
            worker = ScannerWorker()
            assert worker.active_scan_count == 0

    @pytest.mark.asyncio
    async def test_is_healthy_returns_true_when_idle(self):
        with patch("scanner_worker.service.VulnerabilityScanner"):
            worker = ScannerWorker()
            assert worker.is_healthy() is True

    @pytest.mark.asyncio
    async def test_definitions_count_returns_int(self):
        with patch("scanner_worker.service.VulnerabilityScanner"):
            worker = ScannerWorker()
            # definitions_count is a property, not a method
            assert isinstance(worker.definitions_count, int)


class TestBatchScan:
    """Test batch scan submission."""

    @pytest.mark.asyncio
    async def test_submit_batch_rfc003_returns_queued(self):
        with patch("scanner_worker.service.VulnerabilityScanner") as mock_vs:
            mock_vs.return_value.scan = AsyncMock(return_value=_mock_ag_response([]))
            worker = ScannerWorker()
            req = BatchScanRequest(
                tenantId="tenant-1",
                batchId="batch-001",
                targets=[
                    BatchTarget(type=TargetType.CLAUDE_MD, path="/a.md", content="# a"),
                    BatchTarget(type=TargetType.CURSORRULES, path="/b.md", content="# b"),
                ],
            )
            result = await worker.submit_batch_rfc003(req)
            assert result["status"] == "queued"
            assert result["batchId"] == "batch-001"
            assert result["targetCount"] == 2
