"""
Shared fixtures for agentguard-scanner standalone tests.

No database, no network, no backend dependencies.
"""

import json
from datetime import datetime, timezone

import pytest

from scanner_worker.security.analyzers.agent_config import AgentConfigAnalyzer
from scanner_worker.security.analyzers.paste import PasteAnalyzer
from scanner_worker.security.analyzers.skill import SkillAnalyzer
from scanner_worker.security.models import (
    Finding,
    ScanInputType,
    ScanResult,
    ScanType,
    SeverityLevel,
)

# ---------------------------------------------------------------------------
# Analyzer fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def paste_analyzer():
    return PasteAnalyzer()


@pytest.fixture
def agent_config_analyzer():
    return AgentConfigAnalyzer()


@pytest.fixture
def skill_analyzer():
    return SkillAnalyzer()


# ---------------------------------------------------------------------------
# Sample Finding / ScanResult fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_finding():
    """A single representative Finding for reuse in formatter tests."""
    return Finding(
        id="TEST-001",
        severity=SeverityLevel.HIGH,
        title="Test Finding",
        description="A test finding for unit tests.",
        affected_endpoint="pasted content",
        evidence="test evidence",
        remediation="Fix it.",
        cwe_id="CWE-000",
        cvss_score=7.5,
    )


@pytest.fixture
def sample_scan_result(sample_finding):
    """A minimal ScanResult for formatter tests."""
    now = datetime.now(timezone.utc)
    return ScanResult(
        scan_id="scan-test123",
        target_url=None,
        scan_input_type=ScanInputType.PASTE,
        agent_name="test-agent",
        framework="paste-analysis",
        scan_type=ScanType.FULL,
        findings=[sample_finding],
        scan_started=now,
        scan_completed=now,
        duration_seconds=0.42,
    )


@pytest.fixture
def empty_scan_result():
    """A ScanResult with no findings."""
    now = datetime.now(timezone.utc)
    return ScanResult(
        scan_id="scan-empty",
        target_url="https://example.com",
        scan_input_type=ScanInputType.URL,
        framework="generic",
        scan_type=ScanType.QUICK,
        findings=[],
        scan_started=now,
        scan_completed=now,
        duration_seconds=0.01,
    )


# ---------------------------------------------------------------------------
# Tool definition helpers
# ---------------------------------------------------------------------------

@pytest.fixture
def openai_tool_json():
    """Factory that builds an OpenAI-style tool definition JSON string."""
    def _build(name="get_weather", description="Get weather for a city", properties=None):
        if properties is None:
            properties = {"city": {"type": "string", "enum": ["NYC", "LA"]}}
        return json.dumps({
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": description,
                        "parameters": {
                            "type": "object",
                            "properties": properties,
                        },
                    },
                }
            ]
        })
    return _build


@pytest.fixture
def mcp_server_json():
    """Factory that builds an MCP server config JSON string."""
    def _build(server_name="my-server", command="node", args=None, extras=None):
        config = {"command": command, "args": args or ["server.js"]}
        if extras:
            config.update(extras)
        return json.dumps({"mcpServers": {server_name: config}})
    return _build
