"""FastAPI application — RFC 003 HTTP interface between agentos-d and scanner-worker sidecar."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import structlog
import uvicorn
from fastapi import FastAPI, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from scanner_worker.embed import get_service as get_embed_service
from scanner_worker.rerank import get_service as get_rerank_service

from scanner_worker.models import (
    BatchCompleteResponse,
    BatchQueuedResponse,
    BatchScanRequest,
    HealthResponse,
    QueuedResponse,
    ScanRequest,
    ScanResult,
    WatchDirectoryConfig,
    WatchEvent,
)
from scanner_worker.security.formatters.json_fmt import format_json
from scanner_worker.security.formatters.sarif import format_sarif
from scanner_worker.service import ScannerWorker
from scanner_worker.watcher import WatchDirectoryPoller

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.add_log_level,
        structlog.processors.JSONRenderer(),
    ],
)

log = structlog.get_logger(__name__)

# Global singletons
_worker: ScannerWorker | None = None
_poller: WatchDirectoryPoller | None = None
_start_time: float = time.time()
_scanner_version: str = "0.1.0"


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage scanner-worker lifecycle: start poller, clean up on shutdown."""
    global _worker, _poller, _start_time
    _start_time = time.time()

    _worker = ScannerWorker(scan_timeout=60.0)

    # Build watch configs from env or use sensible defaults
    watch_dirs = _build_watch_configs()
    if watch_dirs:
        _poller = WatchDirectoryPoller(
            configs=watch_dirs,
            on_event=_handle_watch_event,
        )
        await _poller.start()

    # Pre-warm the embedding model so the first /embed call is fast. Best-
    # effort — if the dep is missing or the load fails we log a warning and
    # the service stays up; /embed will surface the same error on first call.
    from scanner_worker.embed import preload as _embed_preload

    _embed_loaded, _embed_msg = _embed_preload()
    log.info("embedding warm-up", loaded=_embed_loaded, detail=_embed_msg)

    # Pre-warm the cross-encoder reranker too. Same best-effort policy as
    # /embed — if the model fails to load the service stays up and /rerank
    # surfaces the error on first call.
    from scanner_worker.rerank import preload as _rerank_preload

    _rerank_loaded, _rerank_msg = _rerank_preload()
    log.info("reranker warm-up", loaded=_rerank_loaded, detail=_rerank_msg)

    log.info(
        "scanner-worker started",
        version=_scanner_version,
        watch_dirs=[str(c.path) for c in watch_dirs],
    )

    yield

    if _poller:
        await _poller.stop()
    if _worker:
        await _worker.shutdown()
    log.info("scanner-worker stopped")


def _build_watch_configs() -> list[WatchDirectoryConfig]:
    """Build watch configs from WATCH_DIRS env var or defaults."""
    import os

    raw = os.environ.get("WATCH_DIRS", "")
    if not raw:
        return []

    parts = raw.rsplit(":", 1)
    if len(parts) == 2 and parts[1].isdigit():
        raw_paths = parts[0]
        default_interval = int(parts[1])
    else:
        raw_paths = raw
        default_interval = 30

    configs: list[WatchDirectoryConfig] = []
    for segment in raw_paths.split(":"):
        if not segment:
            continue
        path = segment.strip()
        if path and Path(path).exists():
            configs.append(
                WatchDirectoryConfig(
                    path=path,
                    poll_interval_seconds=default_interval,
                )
            )
    return configs


async def _handle_watch_event(event: WatchEvent) -> None:
    """Fire a scan for a watch-directory change."""
    if _worker is None:
        return

    try:
        content = Path(event.config_path).read_text(encoding="utf-8")
    except Exception as exc:
        log.error(
            "failed to read config for watch scan",
            path=event.config_path,
            error=str(exc),
        )
        return

    from scanner_worker.models import ScanRequest as RFC003ScanRequest
    from scanner_worker.models import ScanTarget, TargetType

    scan_id = f"watch-{uuid.uuid4().hex[:12]}"
    tenant_id = event.tenant_id or "default"
    agent_name = event.agent_name

    # Infer target type from file extension
    if event.config_path.endswith(".md") or "CLAUDE.md" in event.config_path:
        target_type = TargetType.CLAUDE_MD
    elif ".cursorrules" in event.config_path:
        target_type = TargetType.CURSORRULES
    elif "mcp.json" in event.config_path:
        target_type = TargetType.MCP_CONFIG
    else:
        target_type = TargetType.CLAUDE_MD

    scan_req = RFC003ScanRequest(
        tenant_id=tenant_id,
        scan_id=scan_id,
        target=ScanTarget(
            type=target_type,
            path=event.config_path,
            content=content,
        ),
        policy_mode="shadow",
        priority="standard",
    )

    result = await _worker.submit_rfc003(scan_req)
    log.info(
        "watch scan submitted",
        scan_id=result.get("scanId", scan_id),
        config_path=event.config_path,
        agent_name=agent_name,
    )


# ---------------------------------------------------------------------------
# FastAPI app (RFC 003 contract)
# ---------------------------------------------------------------------------

app = FastAPI(
    title="scanner-worker",
    description="AgentGuard scanner sidecar for AgentWorks OS — RFC 003 HTTP API",
    version=_scanner_version,
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# GET /health — RFC 003 §
# ---------------------------------------------------------------------------


@app.get(
    "/health",
    response_model=HealthResponse,
    tags=["health"],
    summary="Liveness/readiness probe",
)
async def health() -> HealthResponse:
    """Liveness/readiness probe from agentos-d.

    Returns scannerVersion, definitionsLoaded, definitionsCount per RFC 003.
    Returns 503 if definitions failed to load.
    """
    global _worker, _start_time

    if _worker is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "status": "unhealthy",
                "scannerVersion": _scanner_version,
                "definitionsLoaded": False,
                "definitionsCount": 0,
            },
        )

    definitions_ok = _worker.is_healthy()
    definitions_count = _worker.definitions_count

    if not definitions_ok:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "status": "unhealthy",
                "scannerVersion": _scanner_version,
                "definitionsLoaded": False,
                "definitionsCount": definitions_count,
            },
        )

    return HealthResponse(
        status="healthy",
        scanner_version=_scanner_version,
        definitions_loaded=True,
        definitions_count=definitions_count,
    )


# ---------------------------------------------------------------------------
# POST /scan — RFC 003 §
# ---------------------------------------------------------------------------


@app.post(
    "/scan",
    tags=["scanner"],
    summary="Submit a scan",
    description="Submit an agent config for scanning. Returns 200 with findings, "
    "or 202 if the scan is queued for async processing.",
)
async def scan(request: ScanRequest) -> ScanResult | QueuedResponse:
    """Submit a scan for a single target.

    Synchronous (scan completes within timeout) → 200 with ScanResult.
    Async (long-running scan) → 202 with QueuedResponse.
    400 on invalid target type.
    503 if scanner is unavailable.
    """
    global _worker

    if _worker is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "scanner_unavailable",
                "message": "Scanner worker is not responding. Scan paused.",
            },
        )

    try:
        result = await _worker.submit_rfc003(request)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "invalid_target_type",
                "message": str(exc),
                "details": {},
            },
        ) from exc
    except Exception as exc:
        log.error("scan submission failed", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "scanner_unavailable",
                "message": f"Scanner worker encountered an error: {exc}",
            },
        ) from exc

    # RFC 003: async scans return 202 Accepted with estimatedSeconds
    if result.get("status") == "queued":
        return QueuedResponse(
            scan_id=result["scan_id"],
            status="queued",
            estimated_seconds=result.get("estimated_seconds", 30),
        )

    # Synchronous complete – handle both raw dicts and Pydantic ScanResponse
    result_dict = result.model_dump() if hasattr(result, "model_dump") else result
    scan_id_val: str = result_dict.get("scan_id") or result_dict.get("scanId") or ""
    scanned_at_val = result_dict.get("scanned_at") or result_dict.get("scannedAt") or datetime.now(timezone.utc)
    status_val: str = result_dict.get("status") or "complete"
    return ScanResult(
        scan_id=scan_id_val,
        status=status_val,
        findings=result_dict.get("findings", []),
        scanned_at=scanned_at_val,
    )


# ---------------------------------------------------------------------------
# GET /scan/{scanId} — RFC 003 §
# ---------------------------------------------------------------------------


@app.get(
    "/scan/{scan_id}",
    tags=["scanner"],
    summary="Poll for async scan result",
)
async def get_scan(scan_id: str) -> ScanResult:
    """Poll for the result of a previously submitted async scan.

    Returns 200 with ScanResult if found.
    Returns 404 if scanId is not known.
    """
    global _worker

    if _worker is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "scanner_unavailable",
                "message": "Scanner worker is not responding.",
            },
        )

    result = await _worker.get_rfc003_result(scan_id)

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "scan_not_found", "message": f"Scan {scan_id} not found."},
        )

    # Prefer RFC 003 field names, fall back to internal model keys
    result_dict = result.model_dump() if hasattr(result, "model_dump") else result
    scan_id_val: str = result_dict.get("scan_id") or result_dict.get("scanId") or ""
    scanned_at_val = result_dict.get("scanned_at") or result_dict.get("scannedAt") or datetime.now(timezone.utc)
    status_val: str = result_dict.get("status") or "complete"
    return ScanResult(
        scan_id=scan_id_val,
        status=status_val,
        findings=result_dict.get("findings", []),
        scanned_at=scanned_at_val,
    )


# ---------------------------------------------------------------------------
# POST /scan/batch — RFC 003 §
# ---------------------------------------------------------------------------


@app.post(
    "/scan/batch",
    tags=["scanner"],
    summary="Submit a batch scan",
    description="Submit multiple targets in one request for nightly full-scan.",
)
async def scan_batch(request: BatchScanRequest) -> BatchQueuedResponse | BatchCompleteResponse:
    """Submit a batch scan.

    If all targets complete synchronously → 200 with BatchCompleteResponse.
    Otherwise → 202 with BatchQueuedResponse (poll individual scanIds).
    """
    global _worker

    if _worker is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "scanner_unavailable",
                "message": "Scanner worker is not responding. Scan paused.",
            },
        )

    try:
        result = await _worker.submit_batch_rfc003(request)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "invalid_target_type",
                "message": str(exc),
                "details": {},
            },
        ) from exc
    except Exception as exc:
        log.error("batch scan failed", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "scanner_unavailable",
                "message": f"Scanner worker encountered an error: {exc}",
            },
        ) from exc

    if result.get("status") == "queued":
        return BatchQueuedResponse(
            batch_id=result["batch_id"],
            status="queued",
            target_count=result["target_count"],
            estimated_seconds=result.get("estimated_seconds", 300),
        )

    return BatchCompleteResponse(
        batch_id=result["batch_id"],
        status="complete",
        results=result.get("results", []),
    )


# ---------------------------------------------------------------------------
# GET /scan/{scanId}/sarif — SARIF 2.1.0 output format
# ---------------------------------------------------------------------------


@app.get(
    "/scan/{scan_id}/sarif",
    tags=["scanner"],
    summary="Export scan results as SARIF 2.1.0",
    responses={
        200: {"content": {"application/json": {}}},
        404: {"description": "Scan not found"},
        503: {"description": "Scanner unavailable"},
    },
)
async def get_scan_sarif(scan_id: str) -> JSONResponse:
    """Export completed scan results in SARIF 2.1.0 format.

    Returns 404 if the scanId is not known.
    Returns 503 if the scanner worker is unavailable.
    """
    global _worker

    if _worker is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "scanner_unavailable",
                "message": "Scanner worker is not responding.",
            },
        )

    result = await _worker.get_rfc003_result(scan_id)

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "scan_not_found", "message": f"Scan {scan_id} not found."},
        )

    result_dict = result.model_dump() if hasattr(result, "model_dump") else result
    scan_id_val: str = result_dict.get("scan_id") or result_dict.get("scanId") or scan_id
    findings_list = result_dict.get("findings", [])
    scanned_at_val = result_dict.get("scanned_at") or result_dict.get("scannedAt") or datetime.now(timezone.utc)

    # Build a ScanResult in the security model's format for the formatter
    from scanner_worker.security.models import Finding as AGFinding
    from scanner_worker.security.models import ScanInputType as AGScanInputType
    from scanner_worker.security.models import ScanResult as AGScanResult
    from scanner_worker.security.models import ScanType as AGScanType
    from scanner_worker.security.models import SeverityLevel as AGSeverityLevel

    ag_findings = []
    for f in findings_list:
        ag_findings.append(AGFinding(
            id=f.get("id", "unknown"),
            severity=AGSeverityLevel(f.get("severity", "INFO").upper()),
            title=f.get("title", f.get("id", "Unknown finding")),
            description=f.get("description", ""),
            affected_endpoint=(lambda loc_val: loc_val.get("file", f.get("affected_endpoint", "unknown")) if isinstance(loc_val, dict) else (str(loc_val) if loc_val else f.get("affected_endpoint", "unknown")))(f.get("location", {})),
            evidence=f.get("evidence"),
            remediation=f.get("remediation", "No remediation provided."),
            cwe_id=f.get("cwe_id"),
            cvss_score=f.get("cvss_score"),
            references=f.get("references", []),
        ))

    ag_result = AGScanResult(
        scan_id=scan_id_val,
        scan_input_type=AGScanInputType.URL,
        scan_type=AGScanType.FULL,
        findings=ag_findings,
        scan_started=scanned_at_val,
        scan_completed=scanned_at_val,
        duration_seconds=0.0,
    )

    return JSONResponse(content=json.loads(format_sarif(ag_result)))


# ---------------------------------------------------------------------------
# GET /scan/{scanId}/json — JSON output format
# ---------------------------------------------------------------------------


@app.get(
    "/scan/{scan_id}/json",
    tags=["scanner"],
    summary="Export scan results as formatted JSON",
    responses={
        200: {"content": {"application/json": {}}},
        404: {"description": "Scan not found"},
        503: {"description": "Scanner unavailable"},
    },
)
async def get_scan_json(scan_id: str) -> JSONResponse:
    """Export completed scan results in pretty-printed JSON format.

    Returns 404 if the scanId is not known.
    Returns 503 if the scanner worker is unavailable.
    """
    global _worker

    if _worker is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "scanner_unavailable",
                "message": "Scanner worker is not responding.",
            },
        )

    result = await _worker.get_rfc003_result(scan_id)

    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "scan_not_found", "message": f"Scan {scan_id} not found."},
        )

    result_dict = result.model_dump() if hasattr(result, "model_dump") else result
    scan_id_val: str = result_dict.get("scan_id") or result_dict.get("scanId") or scan_id
    findings_list = result_dict.get("findings", [])
    scanned_at_val = result_dict.get("scanned_at") or result_dict.get("scannedAt") or datetime.now(timezone.utc)

    # Build a ScanResult in the security model's format for the formatter
    from scanner_worker.security.models import Finding as AGFinding
    from scanner_worker.security.models import ScanInputType as AGScanInputType
    from scanner_worker.security.models import ScanResult as AGScanResult
    from scanner_worker.security.models import ScanType as AGScanType
    from scanner_worker.security.models import SeverityLevel as AGSeverityLevel

    ag_findings = []
    for f in findings_list:
        ag_findings.append(AGFinding(
            id=f.get("id", "unknown"),
            severity=AGSeverityLevel(f.get("severity", "INFO").upper()),
            title=f.get("title", f.get("id", "Unknown finding")),
            description=f.get("description", ""),
            affected_endpoint=(lambda loc_val: loc_val.get("file", f.get("affected_endpoint", "unknown")) if isinstance(loc_val, dict) else (str(loc_val) if loc_val else f.get("affected_endpoint", "unknown")))(f.get("location", {})),
            evidence=f.get("evidence"),
            remediation=f.get("remediation", "No remediation provided."),
            cwe_id=f.get("cwe_id"),
            cvss_score=f.get("cvss_score"),
            references=f.get("references", []),
        ))

    ag_result = AGScanResult(
        scan_id=scan_id_val,
        scan_input_type=AGScanInputType.URL,
        scan_type=AGScanType.FULL,
        findings=ag_findings,
        scan_started=scanned_at_val,
        scan_completed=scanned_at_val,
        duration_seconds=0.0,
    )

    return JSONResponse(content=json.loads(format_json(ag_result)))


# ---------------------------------------------------------------------------
# POST /embed — phase 1a memory architecture (BAAI/bge-base-en-v1.5)
# ---------------------------------------------------------------------------


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., max_length=128)


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
    model: str
    dim: int
    mode: str


@app.post(
    "/embed",
    response_model=EmbedResponse,
    tags=["memory"],
    summary="Encode texts as dense embeddings (BAAI/bge-base-en-v1.5 or stub)",
)
async def embed(req: EmbedRequest) -> EmbedResponse:
    """Return one vector per input text. Stub mode by default — set
    EMBEDDING_MODE=real to load sentence-transformers and the BGE model.
    Empty input is allowed and returns an empty vector list."""
    svc = get_embed_service()
    try:
        vectors = svc.embed(req.texts)
    except Exception as e:  # noqa: BLE001
        # /embed must never 500. Catches missing dep, HF download failure,
        # tokenizer/model errors — any failure path becomes a 503 with a
        # clear message rather than an opaque traceback.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "embedding_unavailable", "message": str(e)},
        ) from e
    return EmbedResponse(
        vectors=vectors,
        model=svc.model_name,
        dim=svc.dim,
        mode=svc.mode,
    )


# ---------------------------------------------------------------------------
# POST /rerank — phase 1c follow-up (BAAI/bge-reranker-base cross-encoder)
# ---------------------------------------------------------------------------


class RerankRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=4096)
    candidates: list[str] = Field(..., max_length=128)


class RerankResponse(BaseModel):
    scores: list[float]
    model: str
    mode: str


@app.post(
    "/rerank",
    response_model=RerankResponse,
    tags=["memory"],
    summary="Score (query, candidate) pairs with a cross-encoder",
)
async def rerank(req: RerankRequest) -> RerankResponse:
    """Return one score per candidate. Higher = more relevant. Stub mode
    returns 0.0 across the board so callers can run end-to-end without the
    model loaded; the agentos-d caller decides whether to re-sort."""
    svc = get_rerank_service()
    try:
        scores = svc.score(req.query, req.candidates)
    except Exception as e:  # noqa: BLE001
        # Same policy as /embed: never 500. Missing dep, model load failure,
        # tokenizer errors all surface as 503 with a clear message.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"error": "reranker_unavailable", "message": str(e)},
        ) from e
    return RerankResponse(scores=scores, model=svc.model_name, mode=svc.mode)


# ---------------------------------------------------------------------------
# Entry point — runs on port 8001 (RFC 003 base URL)
# ---------------------------------------------------------------------------


def main() -> None:
    """Run the scanner-worker via uvicorn on the port configured by SCANNER_WORKER_PORT env var."""
    import os
    port = int(os.environ.get("SCANNER_WORKER_PORT", "3101"));
    uvicorn.run(
        "scanner_worker.app:app",
        host="0.0.0.0",
        port=port,
        log_level="info",
        access_log=False,
    )
