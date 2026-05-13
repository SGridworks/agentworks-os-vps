"""Watch-directory poller for agent config files.

Monitors configured directories for CLAUDE.md, .cursorrules, MCP configs,
and triggers scans when files change.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import suppress
from pathlib import Path

import structlog
import watchfiles

from scanner_worker.models import WatchDirectoryConfig, WatchEvent

logger = structlog.get_logger(__name__)


class WatchDirectoryPoller:
    """Polls one or more directories for agent config changes and fires events.

    File writes are debounced: only emit after a file has been stable for
    ``debounce_seconds`` (default 3s) to avoid triggering on editors that
    write atomically in stages.
    """

    def __init__(
        self,
        configs: list[WatchDirectoryConfig],
        on_event: Callable[[WatchEvent], Awaitable[None]],
        debounce_seconds: float = 3.0,
    ) -> None:
        self._configs = configs
        self._on_event = on_event
        self._debounce = debounce_seconds
        self._running = False
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        """Start the poller (non-blocking)."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run())
        logger.info("watch-directory poller started", paths=[c.path for c in self._configs])

    async def stop(self) -> None:
        """Stop the poller and wait for the loop to exit."""
        self._running = False
        if self._task:
            self._task.cancel()
            with suppress(asyncio.CancelledError):
                await self._task
            self._task = None
        logger.info("watch-directory poller stopped")

    async def _run(self) -> None:
        """Watch loop using watchfiles."""

        watch_paths: list[Path] = []
        for cfg in self._configs:
            p = Path(cfg.path)
            if not p.exists():
                logger.warning("watch path does not exist, skipping", path=str(p))
                continue
            watch_paths.append(p)

        if not watch_paths:
            logger.warning("no valid watch paths — poller idle")
            return

        try:
            async for changes in watchfiles.awatch(
                *watch_paths, debounce=int(self._debounce * 1000)
            ):
                if not self._running:
                    break
                for change_type, path_str in changes:
                    path = Path(path_str)
                    if not self._matches_any_config(path):
                        continue
                    await self._emit(path, change_type)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("watch loop error", error=str(exc))

    def _matches_any_config(self, path: Path) -> bool:
        """Return True if path matches any watch config pattern."""
        name = path.name
        for cfg in self._configs:
            if not str(path).startswith(str(Path(cfg.path).resolve())):
                continue
            for pattern in cfg.patterns:
                if pattern.startswith("*."):
                    ext = pattern[1:]
                    if name.endswith(ext):
                        return True
                elif name == pattern:
                    return True
        return False

    async def _emit(self, path: Path, change_type: int) -> None:
        """Emit a WatchEvent for a changed file."""
        if path.suffix in {".swp", ".tmp", ".bak", "~"}:
            return

        agent_name = self._infer_agent_name(path)

        event = WatchEvent(
            config_path=str(path),
            agent_name=agent_name,
        )
        logger.info("config change detected", path=str(path), agent_name=agent_name)
        try:
            await self._on_event(event)
        except Exception as exc:
            logger.error("watch event handler error", error=str(exc))

    def _infer_agent_name(self, path: Path) -> str | None:
        """Infer agent name from a config file path.

        e.g. ~/agents/claude-code/CLAUDE.md -> claude-code

        Returns None for filesystem-root files (``/CLAUDE.md``) where the
        parent dir is the root marker rather than an agent label.
        """
        try:
            parts = path.parts
            if path.name in ("CLAUDE.md", ".cursorrules"):
                idx = next((i for i, p in enumerate(parts) if p in ("CLAUDE.md", ".cursorrules")), -1)
                if idx > 0:
                    parent = parts[idx - 1]
                    if parent and parent not in ("/", ""):
                        return parent
            elif path.name == "mcp.json":
                idx = next((i for i, p in enumerate(parts) if p == "mcp.json"), -1)
                if idx > 0:
                    parent = parts[idx - 1]
                    if parent and parent not in ("/", ""):
                        return parent
        except Exception:
            pass
        return None
