"""Tests for scanner_worker models — RFC 003 contract + internal models."""

import pytest

from scanner_worker.models import (
    BatchScanRequest,
    BatchTarget,
    Finding,
    FindingLocation,
    HealthResponse,
    ScanInputType,
    ScanRequest,
    ScanResponse,
    ScanResult,
    ScanStatus,
    ScanTarget,
    Severity,
    TargetType,
    WatchDirectoryConfig,
    WatchEvent,
)


class TestSeverity:
    """RFC 003 Severity — lowercase strings."""

    def test_all_severity_values_are_valid(self):
        for sev in Severity:
            assert sev.value in ("critical", "high", "medium", "low", "info")

    def test_severity_from_string(self):
        assert Severity("critical") == Severity.CRITICAL
        assert Severity("high") == Severity.HIGH

    def test_severity_invalid_raises(self):
        with pytest.raises(ValueError):
            Severity("INVALID")


class TestTargetType:
    """RFC 003 TargetType enum."""

    def test_all_target_types(self):
        assert TargetType.CLAUDE_MD.value == "claude_md"
        assert TargetType.CURSORRULES.value == "cursorrules"
        assert TargetType.MCP_CONFIG.value == "mcp_config"
        assert TargetType.N8N_WORKFLOW.value == "n8n_workflow"


class TestScanInputType:
    """Internal ScanInputType (agentguard-scanner bridge)."""

    def test_all_input_types(self):
        assert ScanInputType.URL.value == "url"
        assert ScanInputType.PASTE.value == "paste"
        assert ScanInputType.PASTE_MD.value == "paste_md"
        assert ScanInputType.PASTE_SKILL.value == "paste_skill"

    def test_input_type_from_string(self):
        assert ScanInputType("url") == ScanInputType.URL
        assert ScanInputType("paste_md") == ScanInputType.PASTE_MD


class TestScanStatus:
    def test_all_status_values(self):
        values = {s.value for s in ScanStatus}
        assert values >= {"accepted", "running", "completed", "failed", "crashed"}

    def test_status_from_string(self):
        assert ScanStatus("completed") == ScanStatus.COMPLETED
        assert ScanStatus("crashed") == ScanStatus.CRASHED


class TestFindingLocation:
    """RFC 003 FindingLocation."""

    def test_location_creation(self):
        loc = FindingLocation(file="/path/to/CLAUDE.md", line=42, column=5)
        assert loc.file == "/path/to/CLAUDE.md"
        assert loc.line == 42
        assert loc.column == 5


class TestFinding:
    """RFC 003 Finding — uses ruleId + location + remediation."""

    def test_finding_valid(self):
        f = Finding(
            id="CONFIG-001",
            severity=Severity.HIGH,
            ruleId="AG-001",
            title="Missing safety boundary instructions",
            description="The agent config lacks a refuse/resist instruction block.",
            location=FindingLocation(file="/CLAUDE.md", line=1, column=1),
            remediation="Add explicit refusal guidelines",
        )
        assert f.id == "CONFIG-001"
        assert f.severity == Severity.HIGH
        assert f.ruleId == "AG-001"
        assert f.location.line == 1

    def test_finding_round_trip(self):
        f = Finding(
            id="CVE-2026-0001",
            severity=Severity.CRITICAL,
            ruleId="AG-002",
            title="Prompt Injection",
            description="Attacker can override system prompts",
            location=FindingLocation(file="CLAUDE.md", line=10, column=1),
            remediation="Remove the injection text",
        )
        data = f.model_dump(by_alias=True)
        assert data["ruleId"] == "AG-002"
        assert data["location"]["line"] == 10


class TestScanTarget:
    """RFC 003 ScanTarget."""

    def test_scan_target_valid(self):
        target = ScanTarget(
            type=TargetType.CLAUDE_MD,
            path="/home/user/.claude/CLAUDE.md",
            content="# My Agent\nYou are helpful.",
        )
        assert target.type == TargetType.CLAUDE_MD
        assert "My Agent" in target.content


class TestScanRequest:
    """RFC 003 ScanRequest — tenantId + scanId + target."""

    def test_scan_request_valid(self):
        req = ScanRequest(
            tenantId="tenant-abc",
            scanId="scan-123",
            target=ScanTarget(
                type=TargetType.CLAUDE_MD,
                path="/CLAUDE.md",
                content="# Agent",
            ),
        )
        assert req.tenant_id == "tenant-abc"
        assert req.scan_id == "scan-123"
        assert req.target.type == TargetType.CLAUDE_MD
        assert req.policy_mode == "shadow"  # default
        assert req.priority == "standard"  # default

    def test_scan_request_explicit_policy_mode(self):
        req = ScanRequest(
            tenantId="tenant-1",
            scanId="scan-1",
            target=ScanTarget(type=TargetType.CURSORRULES, path="/.cursorrules", content=""),
            policyMode="enforce",
            priority="high",
        )
        assert req.policy_mode == "enforce"
        assert req.priority == "high"

    def test_scan_request_by_alias(self):
        """JSON input uses camelCase keys."""
        data = {
            "tenantId": "t1",
            "scanId": "s1",
            "target": {"type": "claude_md", "path": "/a.md", "content": "hi"},
        }
        req = ScanRequest(**data)
        assert req.tenant_id == "t1"


class TestBatchScanRequest:
    """RFC 003 BatchScanRequest."""

    def test_batch_request_valid(self):
        req = BatchScanRequest(
            tenantId="tenant-abc",
            batchId="batch-001",
            targets=[
                BatchTarget(type=TargetType.CLAUDE_MD, path="/a.md", content="# a"),
                BatchTarget(type=TargetType.CURSORRULES, path="/b.md", content="# b"),
            ],
        )
        assert len(req.targets) == 2
        assert req.policy_mode == "shadow"  # default


class TestScanResponse:
    """Internal ScanResponse — used by service layer."""

    def test_scan_response_findings_count(self):
        resp = ScanResponse(scan_id="job-123", status=ScanStatus.COMPLETED)
        assert resp.findings_count == 0

    def test_scan_response_risk_score_zero_findings(self):
        resp = ScanResponse(scan_id="job-123", status=ScanStatus.COMPLETED)
        assert resp.risk_score == 0.0

    def test_scan_response_risk_score_calculation(self):
        resp = ScanResponse(scan_id="job-123", status=ScanStatus.COMPLETED)
        resp.findings = [
            Finding(
                id="1",
                severity=Severity.CRITICAL,
                ruleId="r1",
                title="x",
                description="x",
                location=FindingLocation(file="x", line=1, column=1),
                remediation="x",
            ),
            Finding(
                id="2",
                severity=Severity.HIGH,
                ruleId="r2",
                title="x",
                description="x",
                location=FindingLocation(file="x", line=1, column=1),
                remediation="x",
            ),
            Finding(
                id="3",
                severity=Severity.MEDIUM,
                ruleId="r3",
                title="x",
                description="x",
                location=FindingLocation(file="x", line=1, column=1),
                remediation="x",
            ),
            Finding(
                id="4",
                severity=Severity.LOW,
                ruleId="r4",
                title="x",
                description="x",
                location=FindingLocation(file="x", line=1, column=1),
                remediation="x",
            ),
        ]
        # CRITICAL*10 + HIGH*5 + MEDIUM*2 + LOW*0.5 = 10+5+2+0.5=17.5, capped at 10
        assert resp.risk_score == 10.0

    def test_scan_response_risk_score_uncapped_under_10(self):
        resp = ScanResponse(scan_id="job-123", status=ScanStatus.COMPLETED)
        resp.findings = [
            Finding(
                id="1",
                severity=Severity.HIGH,
                ruleId="r1",
                title="x",
                description="x",
                location=FindingLocation(file="x", line=1, column=1),
                remediation="x",
            ),
        ]
        assert resp.risk_score == 5.0


class TestWatchDirectoryConfig:
    def test_watch_config_defaults(self):
        cfg = WatchDirectoryConfig(path="/tmp/watch")
        assert cfg.patterns == ["CLAUDE.md", ".cursorrules", "mcp.json", "*.json"]
        assert cfg.poll_interval_seconds == 30

    def test_watch_config_interval_bounds(self):
        with pytest.raises(ValueError):
            WatchDirectoryConfig(path="/tmp", poll_interval_seconds=2)
        with pytest.raises(ValueError):
            WatchDirectoryConfig(path="/tmp", poll_interval_seconds=5000)


class TestWatchEvent:
    def test_watch_event(self):
        evt = WatchEvent(
            config_path="/home/user/.claude/CLAUDE.md",
            tenant_id="tenant-1",
            agent_name="claude-desktop",
        )
        assert evt.config_path == "/home/user/.claude/CLAUDE.md"
        assert evt.tenant_id == "tenant-1"


class TestHealthResponse:
    """RFC 003 HealthResponse — definitionsCount + scannerVersion."""

    def test_health_response_fields(self):
        hr = HealthResponse(
            status="healthy",
            scannerVersion="0.1.0",
            definitionsLoaded=True,
            definitionsCount=47,
        )
        assert hr.status == "healthy"
        assert hr.scannerVersion == "0.1.0"
        assert hr.definitionsCount == 47
        assert hr.definitionsLoaded is True

    def test_health_by_alias(self):
        data = {
            "status": "healthy",
            "scannerVersion": "0.1.0",
            "definitionsLoaded": True,
            "definitionsCount": 47,
        }
        hr = HealthResponse(**data)
        assert hr.scannerVersion == "0.1.0"


class TestScanResult:
    """RFC 003 ScanResult — the synchronous complete response."""

    def test_scan_result_fields(self):
        result = ScanResult(
            scanId="scan-abc",
            status="complete",
            findings=[
                Finding(
                    id="F1",
                    severity=Severity.HIGH,
                    ruleId="AG-001",
                    title="Test",
                    description="Desc",
                    location=FindingLocation(file="CLAUDE.md", line=5, column=1),
                    remediation="Fix it",
                )
            ],
            scannedAt="2026-04-27T10:00:00Z",
        )
        assert result.scanId == "scan-abc"
        assert result.status == "complete"
        assert len(result.findings) == 1
