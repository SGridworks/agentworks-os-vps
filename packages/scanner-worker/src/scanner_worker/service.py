"""Scanner worker service — RFC 003 API contract, wraps VulnerabilityScanner with resilience and job tracking."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import datetime, timezone
from typing import Any

import structlog

from scanner_worker.models import (
    BatchScanRequest,
    Finding,
    FindingLocation,
    ScanRequest,
    ScanTarget,
    Severity,
)
from scanner_worker.security import ScanInputType, ScanType, VulnerabilityScanner
from scanner_worker.security import ScanRequest as AGScanRequest

logger = structlog.get_logger(__name__)

SCANNER_VERSION = "0.1.0"

# ---------------------------------------------------------------------------
# Severity mapping (agentguard-scanner internal → RFC 003)
# ---------------------------------------------------------------------------


def _map_severity(ag_sev: str) -> Severity:
    """Map upstream severity string to RFC 003 Severity enum."""
    mapping = {
        "CRITICAL": Severity.CRITICAL,
        "HIGH": Severity.HIGH,
        "MEDIUM": Severity.MEDIUM,
        "LOW": Severity.LOW,
        "INFO": Severity.INFO,
    }
    return mapping.get(ag_sev.upper(), Severity.INFO)


# ---------------------------------------------------------------------------
# Finding location (agentguard-scanner has no location, we infer it)
# ---------------------------------------------------------------------------


def _infer_location(target_content: str, target_path: str) -> FindingLocation:
    """Infer the primary location of a finding within the config content.

    agentguard-scanner does not provide per-finding line/column locations.
    We scan the content for the first line containing keywords related to
    the finding title and return that line number.
    """
    lines = target_content.splitlines()
    for idx, line in enumerate(lines, start=1):
        if any(
            keyword in line.lower()
            for keyword in ["system", "role", "instruct", "never", "always", "tool", "mcp"]
        ):
            return FindingLocation(file=target_path, line=idx, column=1)
    return FindingLocation(file=target_path, line=1, column=1)


# ---------------------------------------------------------------------------
# agentguard-scanner request adapter
# ---------------------------------------------------------------------------


_INPUT_TYPE_MAP: dict[str, ScanInputType] = {
    "claude_md": ScanInputType.PASTE_MD,
    "cursorrules": ScanInputType.PASTE,
    "mcp_config": ScanInputType.PASTE,
    "n8n_workflow": ScanInputType.PASTE,
}

_SCAN_TYPE_MAP: dict[str, ScanType] = {
    "shadow": ScanType.FULL,
    "enforce": ScanType.FULL,
}


def _to_ag_request(
    target_content: str,
    target_path: str,
    target_type: str,
    agent_name: str | None,
) -> AGScanRequest:
    """Convert RFC 003 target to agentguard-scanner request format."""
    scan_input_type = _INPUT_TYPE_MAP.get(target_type, ScanInputType.PASTE_MD)
    return AGScanRequest(
        target_url=None,
        paste_content=target_content,
        scan_input_type=scan_input_type,
        scan_type=ScanType.FULL,
        agent_name=agent_name,
        checks=None,
    )


# ---------------------------------------------------------------------------
# Internal job tracking
# ---------------------------------------------------------------------------


class ScanJob:
    """A tracked in-flight scan job (RFC 003 tracks by scanId)."""

    __slots__ = ("job_id", "scan_request", "started_at", "_future", "_result", "_error")

    def __init__(self, job_id: str, scan_request: ScanRequest) -> None:
        self.job_id = job_id
        self.scan_request = scan_request
        self.started_at: datetime = datetime.now(timezone.utc)
        self._future: asyncio.Future[dict[str, Any]] | None = None
        # _result: result dict if scan completed synchronously (polling after return)
        # _error: True if scan completed with an error that must not be re-polled
        self._result: dict[str, Any] | None = None
        self._error: bool = False

    @property
    def age_seconds(self) -> float:
        return (datetime.now(timezone.utc) - self.started_at).total_seconds()


class BatchJob:
    """A tracked in-flight batch scan job."""

    __slots__ = ("batch_id", "targets", "started_at", "_scan_ids", "_results")

    def __init__(
        self,
        batch_id: str,
        targets: list[BatchScanRequest],
        scan_ids: list[str],
    ) -> None:
        self.batch_id = batch_id
        self.targets = targets
        self.started_at: datetime = datetime.now(timezone.utc)
        self._scan_ids = scan_ids
        self._results: dict[str, Any] = {}

    @property
    def age_seconds(self) -> float:
        return (datetime.now(timezone.utc) - self.started_at).total_seconds()


# ---------------------------------------------------------------------------
# ScannerWorker — RFC 003 API surface
# ---------------------------------------------------------------------------


class ScannerWorker:
    """Thread-safe scanner wrapper with RFC 003 job tracking and graceful shutdown.

    - RFC 003: submit_scan returns immediately (sync) or 202 (async).
    - agentos-d polls /scan/{scanId} for results.
    - No scan result is ever written to disk here — agentos-d persists.
    """

    def __init__(self, scan_timeout: float = 60.0) -> None:
        self._scanner: VulnerabilityScanner = VulnerabilityScanner()
        self._timeout = scan_timeout
        self._jobs: dict[str, ScanJob] = {}
        self._batch_jobs: dict[str, BatchJob] = {}
        self._lock = asyncio.Lock()
        self._shutdown = asyncio.Event()
        self._definitions_count: int = 47  # agentguard-scanner ships ~47 rules

    # ------------------------------------------------------------------
    # RFC 003 public API
    # ------------------------------------------------------------------

    async def submit_rfc003(self, request: ScanRequest) -> dict[str, Any]:
        """Submit a scan per RFC 003 § POST /scan.

        Synchronous: returns dict with scanId, status="complete", findings, scannedAt.
        Async (queued): returns dict with scanId, status="queued", estimatedSeconds.
        """
        scan_id = request.scan_id
        target = request.target

        if self._shutdown.is_set():
            return {
                "scanId": scan_id,
                "status": "error",
                "findings": [],
                "scannedAt": datetime.now(timezone.utc).isoformat(),
                "error": "scanner-worker is shutting down",
            }

        # Validate target type
        valid_types = {"claude_md", "cursorrules", "mcp_config", "n8n_workflow"}
        if target.type.value not in valid_types:
            raise ValueError(f"Invalid target type: {target.type}. "
                             f"Must be one of: {', '.join(valid_types)}")

        # Build the async scan task
        async with self._lock:
            job = ScanJob(scan_id, request)
            self._jobs[scan_id] = job

        task = asyncio.create_task(self._run_scan(job))
        job._future = task

        # For RFC 003 v0.1: all scans are synchronous (complete within 60s timeout)
        # Return immediately with sync result since our timeout covers full scan time
        try:
            result = await asyncio.wait_for(task, timeout=self._timeout + 1.0)
            job._result = result
            job._future = None
            return result
        except TimeoutError:
            task.cancel()
            async with self._lock:
                self._jobs.pop(scan_id, None)
            # Await task to allow cleanup; ignore any cancellation or timeout errors
            with suppress(Exception):
                await task
            job._future = None
            job._error = True
            return {
                "scanId": scan_id,
                "status": "error",
                "findings": [],
                "scannedAt": datetime.now(timezone.utc),
                "error": f"scan timed out after {self._timeout}s",
            }

        except Exception as exc:
            async with self._lock:
                self._jobs.pop(scan_id, None)
            return {
                "scanId": scan_id,
                "status": "error",
                "findings": [],
                "scannedAt": datetime.now(timezone.utc),
                "error": str(exc),
            }

    async def get_rfc003_result(self, scan_id: str) -> dict[str, Any] | None:
        """Poll for an async scan result — RFC 003 § GET /scan/{scanId}."""
        async with self._lock:
            job = self._jobs.get(scan_id)

        if job is None:
            return None

        # Completed synchronously (job._future is None, result stored on job)
        if job._future is None and job._result is not None:
            return job._result

        if job._future is None:
            # _future is None with no result means "error during timeout path"
            # — still return the stored error dict if available
            return None

        if not job._future.done():
            return {
                "scanId": scan_id,
                "status": "running",
                "findings": [],
                "scannedAt": None,
            }

        try:
            result = await job._future
            return result
        except asyncio.CancelledError:
            async with self._lock:
                self._jobs.pop(scan_id, None)
            return {
                "scanId": scan_id,
                "status": "error",
                "findings": [],
                "scannedAt": datetime.now(timezone.utc),
                "error": "scan cancelled",
            }
        except Exception as exc:
            return {
                "scanId": scan_id,
                "status": "error",
                "findings": [],
                "scannedAt": datetime.now(timezone.utc),
                "error": str(exc),
            }

    async def submit_batch_rfc003(self, request: BatchScanRequest) -> dict[str, Any]:
        """Submit a batch scan — RFC 003 § POST /scan/batch.

        v0.1: always returns 202 with batchId. Individual scanIds can be polled.
        """
        batch_id = request.batch_id
        targets = request.targets

        if self._shutdown.is_set():
            return {
                "batchId": batch_id,
                "status": "error",
                "error": "scanner-worker is shutting down",
            }

        # Validate all target types
        valid_types = {"claude_md", "cursorrules", "mcp_config", "n8n_workflow"}
        for t in targets:
            if t.type.value not in valid_types:
                raise ValueError(f"Invalid target type: {t.type}")

        # Submit each target as an individual scan
        scan_ids: list[str] = []
        for idx, t in enumerate(targets):
            scan_id = f"{batch_id}-{idx:03d}"
            scan_ids.append(scan_id)

            # Convert BatchTarget → ScanTarget for the ScanRequest
            scan_target = ScanTarget(
                type=t.type,
                path=t.path,
                content=t.content,
            )
            # Run synchronously for batch (v0.1: no async batch queue)
            job = ScanJob(scan_id, ScanRequest(
                tenant_id=request.tenant_id,
                scan_id=scan_id,
                target=scan_target,
                policy_mode=request.policy_mode,
                priority=request.priority,
            ))

            async with self._lock:
                self._jobs[scan_id] = job

            task = asyncio.create_task(self._run_scan(job))
            job._future = task

        return {
            "batchId": batch_id,
            "status": "queued",
            "targetCount": len(targets),
            "estimatedSeconds": len(targets) * 10,
        }

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def shutdown(self) -> None:
        """Graceful shutdown: stop accepting new scans, cancel in-flight."""
        logger.info("scanner-worker shutting down")
        self._shutdown.set()

        async with self._lock:
            active = [
                j for j in self._jobs.values()
                if j._future is not None and not j._future.done()
            ]

        for job in active:
            logger.info("cancelling active scan", job_id=job.job_id)
            if job._future:
                job._future.cancel()

        if active:
            await asyncio.wait(
                [j._future for j in active if j._future],
                timeout=10.0,
            )

        async with self._lock:
            self._jobs.clear()
            self._batch_jobs.clear()

    @property
    def active_scan_count(self) -> int:
        """Number of scans currently executing."""
        return sum(
            1
            for j in self._jobs.values()
            if j._future is not None and not j._future.done()
        )

    @property
    def definitions_count(self) -> int:
        """Number of loaded security rule definitions (agentguard-scanner ships ~47)."""
        return self._definitions_count

    def is_healthy(self) -> bool:
        """True unless we have stalled jobs older than 5x timeout."""
        now = datetime.now(timezone.utc)
        for job in self._jobs.values():
            age = (now - job.started_at).total_seconds()
            if job._future is None or job._future.done():
                continue
            if age > self._timeout * 5:
                return False
        return True

    # ------------------------------------------------------------------
    # Internal scan execution
    # ------------------------------------------------------------------

    async def _run_scan(self, job: ScanJob) -> dict[str, Any]:
        """Execute the upstream scan, map result to RFC 003 format."""
        scan_request = job.scan_request
        target = scan_request.target

        try:
            ag_req = _to_ag_request(
                target_content=target.content,
                target_path=target.path,
                target_type=target.type.value,
                agent_name=None,
            )

            result = await asyncio.wait_for(
                self._scanner.scan(ag_req),
                timeout=self._timeout,
            )

            scanned_at = datetime.now(timezone.utc)

            # Map findings to RFC 003 format with location
            findings: list[Finding] = []
            for ag_finding in result.findings:
                if not hasattr(ag_finding, "model_dump"):
                    continue
                raw = ag_finding.model_dump()
                location = _infer_location(target.content, target.path)
                findings.append(
                    Finding(
                        id=str(raw.get("id", "UNKNOWN")),
                        severity=_map_severity(str(raw.get("severity", "INFO"))),
                        rule_id=str(raw.get("id", "UNKNOWN")),
                        title=str(raw.get("title", "")),
                        description=str(raw.get("description", "")),
                        location=location,
                        remediation=str(raw.get("remediation", "")),
                    )
                )

            return {
                "scanId": job.job_id,
                "status": "complete",
                "findings": findings,
                "scannedAt": scanned_at,
            }

        except TimeoutError:
            # Propagate timeout to outer handler for job cleanup
            raise

        except Exception as exc:
            logger.error("scan failed", job_id=job.job_id, error=str(exc))
            job._result = {
                "scanId": job.job_id,
                "status": "error",
                "findings": [],
                "scannedAt": datetime.now(timezone.utc),
                "error": str(exc),
            }
            return job._result
