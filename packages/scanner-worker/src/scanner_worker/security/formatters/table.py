"""Plain-text table formatter for scan results (no Rich dependency)."""

from scanner_worker.security.models import ScanResult, SeverityLevel


def format_table(result: ScanResult) -> str:
    """Format scan results as a plain-text table.

    Produces human-readable output suitable for terminal display without
    any third-party formatting libraries.
    """
    lines: list[str] = []

    # Header
    lines.append("AgentGuard Security Scan")
    lines.append("=" * 60)

    # Target info
    target = result.target_url or "pasted content"
    lines.append(f"Target: {target}")
    lines.append(
        f"Duration: {result.duration_seconds:.2f}s | Findings: {result.findings_count}"
    )
    lines.append("")

    # Severity summary
    by_sev = result.by_severity
    summary_parts = []
    if by_sev["critical"]:
        summary_parts.append(f" CRITICAL ({by_sev['critical']}) ")
    if by_sev["high"]:
        summary_parts.append(f" HIGH ({by_sev['high']}) ")
    if by_sev["medium"]:
        summary_parts.append(f" MEDIUM ({by_sev['medium']}) ")
    if by_sev["low"]:
        summary_parts.append(f" LOW ({by_sev['low']}) ")
    if by_sev["info"]:
        summary_parts.append(f" INFO ({by_sev['info']}) ")

    if summary_parts:
        lines.append("  ".join(summary_parts))
    else:
        lines.append("No findings -- all clear!")

    lines.append("")

    if not result.findings:
        lines.append("Use --format json for machine-readable output.")
        return "\n".join(lines)

    # Determine column widths
    sev_width = 10
    id_width = max(len(f.id) for f in result.findings)
    id_width = max(id_width, 10)  # minimum width

    # Table header
    header = f"{'Severity':<{sev_width}} | {'ID':<{id_width}} | Title"
    lines.append(header)
    lines.append(
        "-" * sev_width + "-+-" + "-" * id_width + "-+-" + "-" * 38
    )

    # Sort findings: CRITICAL first, then HIGH, MEDIUM, LOW, INFO
    severity_order = {
        SeverityLevel.CRITICAL: 0,
        SeverityLevel.HIGH: 1,
        SeverityLevel.MEDIUM: 2,
        SeverityLevel.LOW: 3,
        SeverityLevel.INFO: 4,
    }
    sorted_findings = sorted(
        result.findings, key=lambda f: severity_order.get(f.severity, 5)
    )

    for finding in sorted_findings:
        sev = finding.severity.value
        lines.append(
            f"{sev:<{sev_width}} | {finding.id:<{id_width}} | {finding.title}"
        )

    lines.append("")
    lines.append("Use --format json for machine-readable output.")

    return "\n".join(lines)
