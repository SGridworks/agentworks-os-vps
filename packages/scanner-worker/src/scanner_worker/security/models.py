"""
Scan-related Pydantic models for the AgentGuard scanner.
"""

from datetime import datetime
from enum import Enum
from typing import Self

from pydantic import BaseModel, Field, HttpUrl, field_validator, model_validator


class SeverityLevel(str, Enum):  # noqa: UP042
    """Vulnerability severity levels"""
    CRITICAL = "CRITICAL"
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"
    INFO = "INFO"


class ScanType(str, Enum):  # noqa: UP042
    """Types of scans available"""
    FULL = "full"
    QUICK = "quick"
    CUSTOM = "custom"


class ScanInputType(str, Enum):  # noqa: UP042
    """How the scan input is provided"""
    URL = "url"
    PASTE = "paste"
    PASTE_MD = "paste_md"
    PASTE_SKILL = "paste_skill"


class Finding(BaseModel):
    """A single security finding"""
    id: str = Field(..., description="Finding identifier (e.g., CVE-2026-25253)")
    severity: SeverityLevel
    title: str = Field(..., description="Short description")
    description: str = Field(..., description="Detailed explanation")
    affected_endpoint: str = Field(..., description="URL or endpoint affected")
    evidence: str | None = Field(None, description="Proof of vulnerability")
    remediation: str = Field(..., description="How to fix this issue")
    cwe_id: str | None = Field(None, description="CWE identifier")
    cvss_score: float | None = Field(None, ge=0.0, le=10.0, description="CVSS score")
    references: list[str] = Field(default_factory=list, description="Links to documentation")


VALID_CHECK_NAMES = {
    "exposed_endpoints",
    "authentication",
    "secret_leakage",
    "prompt_injection",
    "mcp_security",
    "ssrf",
    "tool_execution",
    "config_security",
    "data_exfiltration",
    "typosquatting",
    "excessive_agency",
    "canary_tokens",
}


class ScanRequest(BaseModel):
    """Request to start a scan"""
    target_url: HttpUrl | None = Field(None, description="URL of the AI agent to scan")
    paste_content: str | None = Field(None, description="Pasted content to analyze", max_length=50000)
    scan_input_type: ScanInputType = Field(default=ScanInputType.URL, description="Input method")
    scan_type: ScanType = Field(default=ScanType.FULL, description="Type of scan")
    agent_name: str | None = Field(None, description="User-provided name for this agent")
    checks: list[str] | None = Field(None, description="Checks to run (custom scan only)")

    @field_validator("checks", mode="before")
    @classmethod
    def validate_checks(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return v
        invalid = set(v) - VALID_CHECK_NAMES
        if invalid:
            raise ValueError(f"Invalid check names: {', '.join(sorted(invalid))}")
        return v

    @model_validator(mode="after")
    def validate_input(self) -> Self:
        if self.scan_input_type == ScanInputType.URL and not self.target_url:
            raise ValueError("target_url is required for URL scans")
        paste_types = {ScanInputType.PASTE, ScanInputType.PASTE_MD, ScanInputType.PASTE_SKILL}
        if self.scan_input_type in paste_types and not self.paste_content:
            raise ValueError("paste_content is required for paste scans")
        return self


class ScanResult(BaseModel):
    """Complete scan results"""
    scan_id: str = Field(..., description="Unique scan identifier")
    target_url: str | None = None
    scan_input_type: ScanInputType = ScanInputType.URL
    agent_name: str | None = None
    framework: str = Field(default="generic", description="Detected framework")
    scan_type: ScanType
    findings: list[Finding]
    scan_started: datetime
    scan_completed: datetime
    duration_seconds: float

    @property
    def findings_count(self) -> int:
        return len(self.findings)

    @property
    def by_severity(self) -> dict[str, int]:
        """Count findings by severity"""
        counts = {
            "critical": 0,
            "high": 0,
            "medium": 0,
            "low": 0,
            "info": 0
        }
        for finding in self.findings:
            counts[finding.severity.value.lower()] += 1
        return counts

    @property
    def risk_score(self) -> float:
        """Calculate risk score (0-10) based on findings"""
        score = (
            self.by_severity["critical"] * 10 +
            self.by_severity["high"] * 5 +
            self.by_severity["medium"] * 2 +
            self.by_severity["low"] * 0.5
        )
        return min(score, 10.0)
