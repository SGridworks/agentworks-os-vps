"""Shared fixtures for scanner-worker tests."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def mock_scanner():
    """Patch VulnerabilityScanner so tests don't need the real upstream."""
    with patch("scanner_worker.service.VulnerabilityScanner") as mock_cls:
        mock_instance = MagicMock()
        mock_instance.scan = AsyncMock()
        mock_cls.return_value = mock_instance
        yield mock_instance


@pytest.fixture
def worker(mock_scanner):
    """ScannerWorker with a mocked upstream scanner."""
    from scanner_worker.service import ScannerWorker
    return ScannerWorker(scan_timeout=10.0)
