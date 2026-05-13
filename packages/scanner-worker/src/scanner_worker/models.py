"""Pydantic models for the scanner-worker HTTP API — RFC 003 contract."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Target types (RFC 003)
# ---------------------------------------------------------------------------


class TargetType(StrEnum):
    """Target configuration type — RFC 003."""

    CLAUDE_MD = "claude_md"
    CURSORRULES = "cursorrules"
    MCP_CONFIG = "mcp_config"
    N8N_WORKFLOW = "n8n_workflow"


# ---------------------------------------------------------------------------
# Severity (RFC 003 — lowercase strings)
# ---------------------------------------------------------------------------


class Severity(StrEnum):
    """Finding severity — RFC 003 lowercase format."""

    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


# ---------------------------------------------------------------------------
# Internal adapter models (agentguard-scanner bridge)
# Keep for backward compat while service layer adapts.
# ---------------------------------------------------------------------------


class ScanInputType(StrEnum):
    """How the scan input is provided (agentguard-scanner internal)."""

    URL = "url"
    PASTE = "paste"
    PASTE_MD = "paste_md"
    PASTE_SKILL = "paste_skill"


class ScanType(StrEnum):
    """Type of scan (agentguard-scanner internal)."""

    FULL = "full"
    QUICK = "quick"
    CUSTOM = "custom"


# ---------------------------------------------------------------------------
# RFC 003 request models
# ---------------------------------------------------------------------------


class ScanTarget(BaseModel):
    """Target of a scan — RFC 003 § POST /scan."""

    type: TargetType
    path: str = Field(description="Absolute path to the target file")
    content: str = Field(description="Raw file content")


class ScanRequest(BaseModel):
    """Incoming scan request from agentos-d — RFC 003 § POST /scan.

    Uses RFC 003 wire format: {tenantId, scanId, target, policyMode, priority}.
    The service layer converts this to the agentguard-scanner internal format.
    """

    tenant_id: Annotated[str, Field(alias="tenantId")]
    scan_id: Annotated[str, Field(alias="scanId")]
    target: ScanTarget
    policy_mode: Annotated[
        str, Field(alias="policyMode", default="shadow")
    ]  # "shadow" | "enforce"
    priority: Annotated[
        str, Field(alias="priority", default="standard")
    ]  # "standard" | "high"

    model_config = {
        "populate_by_name": True,
        "str_strip_whitespace": True,
    }


class BatchTarget(BaseModel):
    """A single target inside a batch request — RFC 003 § POST /scan/batch."""

    type: TargetType
    path: str
    content: str


class BatchScanRequest(BaseModel):
    """Batch scan request — RFC 003 § POST /scan/batch."""

    tenant_id: Annotated[str, Field(alias="tenantId")]
    batch_id: Annotated[str, Field(alias="batchId")]
    targets: list[BatchTarget]
    policy_mode: Annotated[str, Field(alias="policyMode", default="shadow")]
    priority: Annotated[str, Field(alias="priority", default="standard")]

    model_config = {"populate_by_name": True, "str_strip_whitespace": True}


# ---------------------------------------------------------------------------
# RFC 003 response models
# ---------------------------------------------------------------------------


class FindingLocation(BaseModel):
    """Location of a finding within a file — RFC 003."""

    file: str
    line: int
    column: int


class Finding(BaseModel):
    """A single security finding.

    Supports two formats:
    - RFC 003 wire format: {id, severity, ruleId, title, description, location, remediation}
    - Internal agentguard-scanner format: {id, severity, title, description,
        affected_endpoint, evidence, remediation, cwe_id, cvss_score, references}

    The service layer populates internal fields; app routes map to RFC 003 wire
    format for the HTTP response (using FindingLocation derived from affected_endpoint).
    """

    # RFC 003 fields
    id: str
    severity: Severity
    rule_id: Annotated[str | None, Field(alias="ruleId", default=None)]
    title: str
    description: str
    location: FindingLocation | None = None
    remediation: str | None = None

    # Internal agentguard-scanner adapter fields
    affected_endpoint: str | None = None
    evidence: str | None = None
    cwe_id: str | None = None
    cvss_score: float | None = None
    references: list[str] = Field(default_factory=list)

    model_config = {"populate_by_name": True}

    # ---------------------------------------------------------------------------
    # Alias accessors for RFC 003 wire format (tests/admin-ui access by alias)
    # ---------------------------------------------------------------------------
    # ruff: N802 — camelCase property names intentionally match RFC 003 wire format
    @property
    def ruleId(self) -> str | None:  # noqa: N802
        """RFC 003 alias for rule_id."""
        return self.rule_id

    # ---------------------------------------------------------------------------
    # Derived helpers (used by admin-ui and test assertions)
    # ---------------------------------------------------------------------------

    @property
    def findings_count(self) -> int:
        """Compatibility: always 1 for a single finding."""
        return 1

    @property
    def risk_score(self) -> float:
        """Risk score 0-10 based on severity and cvss_score.

        CRITICAL=10, HIGH=5, MEDIUM=2, LOW=0.5, INFO=0.
        Capped at 10. If cvss_score is present, use the higher of the two.
        """
        severity_scores = {
            Severity.CRITICAL: 10.0,
            Severity.HIGH: 5.0,
            Severity.MEDIUM: 2.0,
            Severity.LOW: 0.5,
            Severity.INFO: 0.0,
        }
        base = severity_scores.get(self.severity, 0.0)
        if self.cvss_score is not None:
            return min(10.0, max(base, self.cvss_score))
        return base


class ScanResult(BaseModel):
    """Complete scan result — RFC 003 § POST /scan response body."""

    scan_id: Annotated[str, Field(alias="scanId")]
    status: str  # "complete" | "error"
    findings: list[Finding] = Field(default_factory=list)
    scanned_at: Annotated[datetime, Field(alias="scannedAt")]

    model_config = {"populate_by_name": True}

    # ruff: N802 — camelCase property names intentionally match RFC 003 wire format
    @property
    def scanId(self) -> str:  # noqa: N802
        """RFC 003 alias for scan_id."""
        return self.scan_id

    # ruff: N802 — camelCase property names intentionally match RFC 003 wire format
    @property
    def scannedAt(self) -> datetime:  # noqa: N802
        """RFC 003 alias for scanned_at."""
        return self.scanned_at


class QueuedResponse(BaseModel):
    """Async scan queued response — RFC 003 § 202 Accepted."""

    scan_id: Annotated[str, Field(alias="scanId")]
    status: str = "queued"
    estimated_seconds: Annotated[int, Field(alias="estimatedSeconds")]

    model_config = {"populate_by_name": True}


class BatchQueuedResponse(BaseModel):
    """Batch queued response — RFC 003 § POST /scan/batch 202."""

    batch_id: Annotated[str, Field(alias="batchId")]
    status: str = "queued"
    target_count: Annotated[int, Field(alias="targetCount")]
    estimated_seconds: Annotated[int, Field(alias="estimatedSeconds")]

    model_config = {"populate_by_name": True}


class BatchCompleteResponse(BaseModel):
    """Batch fully-complete response — RFC 003 § POST /scan/batch 200."""

    batch_id: Annotated[str, Field(alias="batchId")]
    status: str = "complete"
    results: list[ScanResult]

    model_config = {"populate_by_name": True}


# ---------------------------------------------------------------------------
# Error response (RFC 003 § 400/503)
# ---------------------------------------------------------------------------


class ErrorDetail(BaseModel):
    """RFC 003 error detail tree."""

    error: str
    message: str
    details: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Health (RFC 003 § GET /health)
# ---------------------------------------------------------------------------


class HealthResponse(BaseModel):
    """Health/readiness probe — RFC 003 § GET /health."""

    status: str  # "healthy" | "unhealthy"
    scanner_version: Annotated[str, Field(validation_alias="scannerVersion")]
    definitions_loaded: Annotated[bool, Field(validation_alias="definitionsLoaded")]
    definitions_count: Annotated[int, Field(validation_alias="definitionsCount")]

    model_config = {"populate_by_name": True}

    # ruff: N802 — camelCase property names intentionally match RFC 003 wire format
    @property
    def scannerVersion(self) -> str:  # noqa: N802
        """RFC 003 alias for scanner_version."""
        return self.scanner_version

    # ruff: N802 — camelCase property names intentionally match RFC 003 wire format
    @property
    def definitionsLoaded(self) -> bool:  # noqa: N802
        """RFC 003 alias for definitions_loaded."""
        return self.definitions_loaded

    # ruff: N802 — camelCase property names intentionally match RFC 003 wire format
    @property
    def definitionsCount(self) -> int:  # noqa: N802
        """RFC 003 alias for definitions_count."""
        return self.definitions_count


# ---------------------------------------------------------------------------
# Internal adapter models (agentguard-scanner bridge)
# These power the service layer; app routes convert RFC 003 ↔ internal.
# ---------------------------------------------------------------------------

SeverityLevel = Severity  # alias for service layer compat


class _FindingInternal(BaseModel):
    """Internal finding model (agentguard-scanner bridge)."""

    id: str
    severity: Severity
    title: str
    description: str
    affected_endpoint: str
    evidence: str | None = None
    remediation: str
    cwe_id: str | None = None
    cvss_score: float | None = None
    references: list[str] = Field(default_factory=list)
    # RFC 003 location (populated by service layer)
    location: FindingLocation | None = None


class _ScanResponseInternal(BaseModel):
    """Internal scan response used by the service layer."""

    scan_id: str
    status: str
    target_url: str | None = None
    scan_input_type: ScanInputType = ScanInputType.PASTE_MD
    agent_name: str | None = None
    framework: str = "agent-config-analysis"
    scan_type: ScanType = ScanType.FULL
    findings: list[_FindingInternal] = Field(default_factory=list)
    scan_started: datetime | None = None
    scan_completed: datetime | None = None
    duration_seconds: float | None = None
    error: str | None = None


class ScanStatus(StrEnum):
    """Scan lifecycle state (internal)."""

    ACCEPTED = "accepted"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CRASHED = "crashed"


# ---------------------------------------------------------------------------
# Legacy compat — keep old names for existing service layer
# ---------------------------------------------------------------------------


class ScanResponse(BaseModel):
    """Internal scan response used by the service layer and tests.

    This is the internal/job-tracking model returned by ScannerWorker.
    The RFC 003 wire format is ScanResult (synchronous complete) or
    QueuedResponse (async).
    """

    scan_id: str = Field(..., description="Unique scan identifier")
    status: ScanStatus
    target_url: str | None = None
    scan_input_type: ScanInputType = ScanInputType.PASTE_MD
    agent_name: str | None = None
    framework: str = "agent-config-analysis"
    scan_type: ScanType = ScanType.FULL
    findings: list[Finding] = Field(default_factory=list)
    scan_started: datetime | None = None
    scan_completed: datetime | None = None
    duration_seconds: float | None = None
    error: str | None = Field(
        None, description="Error message if status is failed or crashed"
    )

    model_config = {"populate_by_name": True}

    @property
    def findings_count(self) -> int:
        return len(self.findings)

    @property
    def risk_score(self) -> float:
        score = 0.0
        for f in self.findings:
            sev = f.severity
            if isinstance(sev, str):
                sev_lower = sev.lower()
                if sev_lower == "critical":
                    score += 10.0
                elif sev_lower == "high":
                    score += 5.0
                elif sev_lower == "medium":
                    score += 2.0
                elif sev_lower == "low":
                    score += 0.5
            elif hasattr(sev, "value"):
                sev_lower = sev.value.lower()
                if sev_lower == "critical":
                    score += 10.0
                elif sev_lower == "high":
                    score += 5.0
                elif sev_lower == "medium":
                    score += 2.0
                elif sev_lower == "low":
                    score += 0.5
            # cvss_score from the Finding contributes if present
            if f.cvss_score is not None:
                score = max(score, min(f.cvss_score, 10.0))
        return min(score, 10.0)


# ---------------------------------------------------------------------------
# Watch directory poller models (used by watcher.py)
# ---------------------------------------------------------------------------


class WatchDirectoryConfig(BaseModel):
    """Configuration for the watch-directory poller."""

    path: str = Field(..., description="Absolute path to watch")
    patterns: list[str] = Field(
        default=["CLAUDE.md", ".cursorrules", "mcp.json", "*.json"],
        description="File patterns to scan",
    )
    poll_interval_seconds: int = Field(
        default=30, ge=5, le=3600, description="Seconds between polls"
    )


class WatchEvent(BaseModel):
    """A watch-directory trigger event emitted on the internal queue."""

    config_path: str = Field(..., description="Absolute path to the changed file")
    tenant_id: str | None = None
    agent_name: str | None = Field(
        None, description="Inferred agent name from file path"
    )
