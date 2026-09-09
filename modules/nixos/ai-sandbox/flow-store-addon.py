"""Persist complete mitmproxy HTTP flows as opaque SQLite blobs."""

from __future__ import annotations

import asyncio
import io
import os
import sqlite3
import time
from pathlib import Path
from typing import Callable

from mitmproxy import http
from mitmproxy import io as mitm_io


DEFAULT_RETENTION_SECONDS = 48 * 60 * 60
DEFAULT_PRUNE_INTERVAL_SECONDS = 5 * 60


class FlowStore:
    def __init__(
        self,
        path: str | None = None,
        retention_seconds: int | None = None,
        prune_interval_seconds: int | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._path = path
        self._retention_seconds = retention_seconds
        self._prune_interval_seconds = prune_interval_seconds
        self._clock = clock
        self._db: sqlite3.Connection | None = None
        self._last_prune = 0.0
        self._prune_task: asyncio.Task[None] | None = None
        self._active_flows: dict[str, http.HTTPFlow] = {}

    def running(self) -> None:
        self._open()
        if self._prune_task is None:
            self._prune_task = asyncio.create_task(
                self._prune_periodically(), name="ai-sandbox-proxy-flow-prune"
            )

    def request(self, flow: http.HTTPFlow) -> None:
        self._active_flows[flow.id] = flow

    def response(self, flow: http.HTTPFlow) -> None:
        if flow.websocket is None:
            self._finish(flow)

    def error(self, flow: http.HTTPFlow) -> None:
        self._finish(flow)

    def websocket_end(self, flow: http.HTTPFlow) -> None:
        self._finish(flow)

    def done(self) -> None:
        if self._prune_task is not None:
            self._prune_task.cancel()
            self._prune_task = None
        for flow in self._active_flows.values():
            self._save(flow)
        self._active_flows.clear()
        if self._db is None:
            return
        self._db.close()
        self._db = None

    def _finish(self, flow: http.HTTPFlow) -> None:
        self._save(flow)
        self._active_flows.pop(flow.id, None)

    def _open(self) -> sqlite3.Connection:
        if self._db is not None:
            return self._db

        path = Path(
            self._path
            or os.environ.get(
                "PROXY_FLOW_DATABASE",
                "~/.local/state/ai-sandbox-proxy/flows.sqlite3",
            )
        ).expanduser()
        retention = self._retention_seconds
        if retention is None:
            retention = int(
                os.environ.get(
                    "PROXY_FLOW_RETENTION_SECONDS",
                    str(DEFAULT_RETENTION_SECONDS),
                )
            )
        if retention <= 0:
            raise ValueError("PROXY_FLOW_RETENTION_SECONDS must be positive")
        prune_interval = self._prune_interval_seconds
        if prune_interval is None:
            prune_interval = int(
                os.environ.get(
                    "PROXY_FLOW_PRUNE_INTERVAL_SECONDS",
                    str(DEFAULT_PRUNE_INTERVAL_SECONDS),
                )
            )
        if prune_interval <= 0:
            raise ValueError("PROXY_FLOW_PRUNE_INTERVAL_SECONDS must be positive")

        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.parent.chmod(0o700)
        self._db = sqlite3.connect(path, timeout=30)
        path.chmod(0o600)
        self._db.execute("PRAGMA busy_timeout=30000")
        self._db.execute("PRAGMA journal_mode=DELETE")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute("PRAGMA secure_delete=ON")
        self._db.execute("PRAGMA auto_vacuum=INCREMENTAL")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS flows (
                flow_id TEXT PRIMARY KEY,
                stored_at REAL NOT NULL,
                flow BLOB NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS flows_stored_at_idx ON flows (stored_at);
            """
        )
        self._retention_seconds = retention
        self._prune_interval_seconds = prune_interval
        self._prune(force=True)
        return self._db

    def _save(self, flow: http.HTTPFlow) -> None:
        database = self._open()
        now = self._clock()
        payload = io.BytesIO()
        mitm_io.FlowWriter(payload).add(flow)

        database.execute(
            """
            INSERT INTO flows (
                flow_id,
                stored_at,
                flow
            ) VALUES (?, ?, ?)
            ON CONFLICT (flow_id) DO UPDATE SET
                stored_at = excluded.stored_at,
                flow = excluded.flow
            """,
            (
                flow.id,
                now,
                sqlite3.Binary(payload.getvalue()),
            ),
        )
        database.commit()
        self._prune(now=now)

    def _prune(self, now: float | None = None, force: bool = False) -> None:
        database = self._db
        if database is None:
            return
        current = self._clock() if now is None else now
        if not force and 0 <= current - self._last_prune < self._prune_interval_seconds:
            return
        cursor = database.execute(
            "DELETE FROM flows WHERE stored_at < ?",
            (current - self._retention_seconds,),
        )
        database.commit()
        self._last_prune = current
        if cursor.rowcount > 0:
            database.execute("PRAGMA incremental_vacuum")
            database.commit()

    async def _prune_periodically(self) -> None:
        while True:
            await asyncio.sleep(self._prune_interval_seconds)
            self._prune(force=True)


addons = [FlowStore()]
