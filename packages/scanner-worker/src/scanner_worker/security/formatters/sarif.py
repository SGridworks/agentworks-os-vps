"""SARIF 2.1.0 output formatter for scan results."""

import json
from typing import Any

from scanner_worker.security.__version__ import __version__
from scanner_worker.security.models import ScanResult, SeverityLevel


def _severity_to_level(severity: SeverityLevel) -> str:
    """Map AgentGuard severity to SARIF level."""
    if severity in (SeverityLevel.CRITICAL, SeverityLevel.HIGH):
        return "error"
    if severity == SeverityLevel.MEDIUM:
        return "warning"
    return "note"


def format_sarif(result: ScanResult) -> str:
    """Format scan results as SARIF 2.1.0 JSON.

    Produces a valid SARIF document with a single run containing all findings
    mapped to SARIF results, with a rules array built from unique finding IDs.
    """
    # Build rules from unique finding IDs
    seen_rule_ids: dict[str, dict[str, object]] = {}
    for finding in result.findings:
        if finding.id not in seen_rule_ids:
            rule: dict[str, object] = {
                "id": finding.id,
                "shortDescription": {"text": finding.title},
                "fullDescription": {"text": finding.description},
                "help": {"text": finding.remediation},
            }
            if finding.cwe_id:
                rule["properties"] = {"cwe": finding.cwe_id}
            seen_rule_ids[finding.id] = rule

    rules = list(seen_rule_ids.values())

    # Build rule index lookup for result.ruleIndex
    rule_index_map = {rule["id"]: idx for idx, rule in enumerate(rules)}

    # Build SARIF results
    sarif_results = []
    for finding in result.findings:
        sarif_result: dict[str, Any] = {
            "ruleId": finding.id,
            "ruleIndex": rule_index_map[finding.id],
            "level": _severity_to_level(finding.severity),
            "message": {"text": finding.description},
            "locations": [
                {
                    "physicalLocation": {
                        "artifactLocation": {
                            "uri": finding.affected_endpoint,
                        }
                    }
                }
            ],
        }
        if finding.cvss_score is not None:
            sarif_result.setdefault("properties", {})["cvss_score"] = finding.cvss_score
        if finding.evidence:
            sarif_result.setdefault("properties", {})["evidence"] = finding.evidence
        sarif_results.append(sarif_result)

    sarif_document = {
        "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
        "version": "2.1.0",
        "runs": [
            {
                "tool": {
                    "driver": {
                        "name": "agentguard-scanner",
                        "version": __version__,
                        "informationUri": "https://github.com/SGridworks/agentguard",
                        "rules": rules,
                    }
                },
                "results": sarif_results,
            }
        ],
    }

    return json.dumps(sarif_document, indent=2)
