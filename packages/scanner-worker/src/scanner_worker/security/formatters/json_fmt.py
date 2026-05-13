"""JSON output formatter for scan results."""


from scanner_worker.security.models import ScanResult


def format_json(result: ScanResult, indent: int = 2) -> str:
    """Format scan results as JSON."""
    return result.model_dump_json(indent=indent)
