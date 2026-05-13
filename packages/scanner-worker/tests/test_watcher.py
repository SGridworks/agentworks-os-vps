"""Tests for scanner_worker.watcher.

Covers AWO-68 — watch a directory for agent configs (CLAUDE.md, .cursorrules,
MCP configs) and trigger scans when files change.

The ``watchfiles.awatch`` integration is exercised end-to-end against a real
tmp directory; the matching, event filtering, and agent-name inference are
unit-tested directly because they are pure functions on the poller.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from scanner_worker.models import WatchDirectoryConfig, WatchEvent
from scanner_worker.watcher import WatchDirectoryPoller

# ---------------------------------------------------------------------------
# Construction / lifecycle
# ---------------------------------------------------------------------------


class TestLifecycle:
    async def test_start_is_idempotent(self, tmp_path: Path) -> None:
        on_event: AsyncMock = AsyncMock()
        cfg = WatchDirectoryConfig(path=str(tmp_path))
        poller = WatchDirectoryPoller(configs=[cfg], on_event=on_event)
        await poller.start()
        # Capture the task id; second start() must not replace it.
        first_task = poller._task
        await poller.start()
        assert poller._task is first_task
        await poller.stop()

    async def test_stop_is_idempotent(self, tmp_path: Path) -> None:
        cfg = WatchDirectoryConfig(path=str(tmp_path))
        poller = WatchDirectoryPoller(configs=[cfg], on_event=AsyncMock())
        await poller.stop()  # never started — no-op
        await poller.start()
        await poller.stop()
        await poller.stop()  # double stop — no-op
        assert poller._task is None

    async def test_run_idle_when_no_paths_exist(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        # Passing a non-existent path should warn + return without crashing.
        bogus = tmp_path / "does-not-exist"
        cfg = WatchDirectoryConfig(path=str(bogus))
        poller = WatchDirectoryPoller(configs=[cfg], on_event=AsyncMock())
        await poller.start()
        # Give the loop a moment to detect the missing path and exit.
        await asyncio.sleep(0.05)
        await poller.stop()


# ---------------------------------------------------------------------------
# Pattern matching — pure
# ---------------------------------------------------------------------------


class TestPatternMatching:
    def _make(self, root: Path, patterns: list[str] | None = None) -> WatchDirectoryPoller:
        cfg = WatchDirectoryConfig(
            path=str(root),
            patterns=patterns or ["CLAUDE.md", ".cursorrules", "mcp.json", "*.json"],
        )
        return WatchDirectoryPoller(configs=[cfg], on_event=AsyncMock())

    def test_matches_claude_md(self, tmp_path: Path) -> None:
        poller = self._make(tmp_path)
        assert poller._matches_any_config(tmp_path / "agents" / "claude" / "CLAUDE.md")

    def test_matches_cursorrules(self, tmp_path: Path) -> None:
        poller = self._make(tmp_path)
        assert poller._matches_any_config(tmp_path / ".cursorrules")

    def test_matches_mcp_json(self, tmp_path: Path) -> None:
        poller = self._make(tmp_path)
        assert poller._matches_any_config(tmp_path / "config" / "mcp.json")

    def test_matches_glob_extension(self, tmp_path: Path) -> None:
        poller = self._make(tmp_path)
        assert poller._matches_any_config(tmp_path / "anything.json")

    def test_rejects_files_outside_config_path(self, tmp_path: Path) -> None:
        poller = self._make(tmp_path)
        # File with a matching name but outside the configured root.
        outside = Path("/tmp") / "stray-CLAUDE.md"
        assert not poller._matches_any_config(outside)

    def test_rejects_unrelated_extension(self, tmp_path: Path) -> None:
        poller = self._make(tmp_path, patterns=["CLAUDE.md"])
        assert not poller._matches_any_config(tmp_path / "hello.txt")

    def test_rejects_partial_name_collision(self, tmp_path: Path) -> None:
        poller = self._make(tmp_path, patterns=["CLAUDE.md"])
        # "CLAUDE.md.swp" must not match the literal "CLAUDE.md" pattern.
        assert not poller._matches_any_config(tmp_path / "CLAUDE.md.swp")


# ---------------------------------------------------------------------------
# Event emission
# ---------------------------------------------------------------------------


class TestEmit:
    async def test_emit_skips_editor_temp_files(self, tmp_path: Path) -> None:
        on_event: AsyncMock = AsyncMock()
        cfg = WatchDirectoryConfig(path=str(tmp_path))
        poller = WatchDirectoryPoller(configs=[cfg], on_event=on_event)
        for swap in [
            tmp_path / "CLAUDE.md.swp",
            tmp_path / "CLAUDE.md.tmp",
            tmp_path / "CLAUDE.md.bak",
        ]:
            await poller._emit(swap, change_type=1)
        on_event.assert_not_awaited()

    async def test_emit_calls_on_event_with_watch_event(self, tmp_path: Path) -> None:
        on_event: AsyncMock = AsyncMock()
        cfg = WatchDirectoryConfig(path=str(tmp_path))
        poller = WatchDirectoryPoller(configs=[cfg], on_event=on_event)
        target = tmp_path / "CLAUDE.md"
        await poller._emit(target, change_type=1)

        on_event.assert_awaited_once()
        assert on_event.await_args is not None
        evt = on_event.await_args.args[0]
        assert isinstance(evt, WatchEvent)
        assert evt.config_path == str(target)

    async def test_emit_swallows_handler_exceptions(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        async def boom(_evt: WatchEvent) -> None:
            raise RuntimeError("handler exploded")

        cfg = WatchDirectoryConfig(path=str(tmp_path))
        poller = WatchDirectoryPoller(configs=[cfg], on_event=boom)
        # Must not raise — error should be logged and swallowed so one bad
        # handler call doesn't kill the watch loop.
        await poller._emit(tmp_path / "CLAUDE.md", change_type=1)


# ---------------------------------------------------------------------------
# Agent-name inference
# ---------------------------------------------------------------------------


class TestAgentNameInference:
    def _poller(self, tmp_path: Path) -> WatchDirectoryPoller:
        cfg = WatchDirectoryConfig(path=str(tmp_path))
        return WatchDirectoryPoller(configs=[cfg], on_event=AsyncMock())

    def test_infers_from_claude_md_parent(self, tmp_path: Path) -> None:
        poller = self._poller(tmp_path)
        assert (
            poller._infer_agent_name(Path("/Users/x/agents/claude-code/CLAUDE.md"))
            == "claude-code"
        )

    def test_infers_from_cursorrules_parent(self, tmp_path: Path) -> None:
        poller = self._poller(tmp_path)
        assert (
            poller._infer_agent_name(Path("/Users/x/projects/cool-app/.cursorrules"))
            == "cool-app"
        )

    def test_infers_from_mcp_json_parent(self, tmp_path: Path) -> None:
        poller = self._poller(tmp_path)
        assert (
            poller._infer_agent_name(Path("/Users/x/.codex/mcp.json")) == ".codex"
        )

    def test_returns_none_for_root_files(self, tmp_path: Path) -> None:
        poller = self._poller(tmp_path)
        # Root-level CLAUDE.md has no parent dir we can name an agent from.
        assert poller._infer_agent_name(Path("/CLAUDE.md")) is None

    def test_returns_none_for_unrelated_filename(self, tmp_path: Path) -> None:
        poller = self._poller(tmp_path)
        assert (
            poller._infer_agent_name(Path("/Users/x/agent/random.txt"))
            is None
        )


# ---------------------------------------------------------------------------
# End-to-end against the real filesystem
#
# These tests exercise watchfiles.awatch — they spin a real poller, write a
# file, then assert the on_event handler is called within a short timeout.
# They are scoped tight (small debounce, short timeout) so they don't pad
# the suite.
# ---------------------------------------------------------------------------


class TestEndToEnd:
    async def test_writing_claude_md_triggers_event(self, tmp_path: Path) -> None:
        events: list[WatchEvent] = []
        seen = asyncio.Event()

        async def on_event(evt: WatchEvent) -> None:
            events.append(evt)
            seen.set()

        cfg = WatchDirectoryConfig(path=str(tmp_path))
        poller = WatchDirectoryPoller(
            configs=[cfg], on_event=on_event, debounce_seconds=0.05
        )
        await poller.start()
        try:
            # Give watchfiles a moment to register the watch.
            await asyncio.sleep(0.1)
            target = tmp_path / "CLAUDE.md"
            target.write_text("You are an agent. Do not ignore prior instructions.")
            await asyncio.wait_for(seen.wait(), timeout=3.0)
        finally:
            await poller.stop()

        assert len(events) >= 1
        assert events[0].config_path.endswith("CLAUDE.md")

    async def test_writing_unrelated_file_does_not_trigger(
        self, tmp_path: Path
    ) -> None:
        on_event: AsyncMock = AsyncMock()
        cfg = WatchDirectoryConfig(path=str(tmp_path))
        poller = WatchDirectoryPoller(
            configs=[cfg], on_event=on_event, debounce_seconds=0.05
        )
        await poller.start()
        try:
            await asyncio.sleep(0.1)
            (tmp_path / "notes.txt").write_text("not a config")
            # Wait longer than debounce so any spurious event would have fired.
            await asyncio.sleep(0.5)
        finally:
            await poller.stop()
        on_event.assert_not_awaited()
