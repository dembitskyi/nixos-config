"""mitmproxy addons for the AI sandbox proxy.

`StreamServerSentEvents` keeps event streams flowing to the client; `FlowStore`
archives complete flows as opaque SQLite blobs on a writer thread, best effort
and with bounded memory. No hook here may raise.
"""

from __future__ import annotations

import io
import logging
import os
import queue
import sqlite3
import threading
import time
from collections import deque
from collections.abc import Callable
from pathlib import Path

from mitmproxy import ctx, http
from mitmproxy import io as mitm_io

DEFAULT_RETENTION_SECONDS = 12 * 60 * 60
DEFAULT_PRUNE_INTERVAL_SECONDS = 5 * 60
DEFAULT_LIVE_FLOW_LIMIT = 500
DEFAULT_LIVE_FLOW_BYTES = 256 * 1024 * 1024
DEFAULT_QUEUE_DEPTH = 256
DEFAULT_RETRY_SECONDS = 30
MAX_RETRY_SECONDS = 15 * 60
SHUTDOWN_TIMEOUT_SECONDS = 5
MAX_ACTIVE_FLOWS = 4096

logger = logging.getLogger(__name__)

_SHUTDOWN = object()


def _safe_log(level: int, message: str, *args: object, **kwargs: object) -> None:
    """Log without raising; the handler dies on a closed event loop."""
    try:
        logger.log(level, message, *args, **kwargs)
    except Exception:  # noqa: BLE001, S110
        pass


def _positive_env(name: str, default: int) -> int:
    """Read a positive int from the environment, falling back on garbage."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value <= 0:
        _safe_log(
            logging.WARNING,
            "flow-store: ignoring invalid %s=%r, using %s",
            name,
            raw,
            default,
        )
        return default
    return value


def _body_bytes(flow: http.HTTPFlow) -> int:
    """Approximate a flow's retained size without decoding any body."""
    size = 0
    for message in (flow.request, flow.response):
        if message is None:
            continue
        raw = message.raw_content
        if raw:
            size += len(raw)
    websocket = flow.websocket
    if websocket is not None:
        size += sum(len(message.content) for message in websocket.messages)
    return size


class StreamServerSentEvents:
    """Forward `text/event-stream` responses chunk by chunk.

    mitmproxy otherwise buffers the whole body first, so a token stream that
    never ends reaches the client never (mitmproxy#4469). Must run in
    `responseheaders`; by `response` the body is already consumed. The proxy
    unit passes `store_streamed_bodies=true` so the body is still archived.
    """

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        response = flow.response
        if response is None:
            return
        if response.headers.get("content-type", "").startswith("text/event-stream"):
            response.stream = True


class FlowStore:
    def __init__(
        self,
        path: str | None = None,
        retention_seconds: int | None = None,
        prune_interval_seconds: int | None = None,
        live_flow_limit: int | None = None,
        live_flow_bytes: int | None = None,
        queue_depth: int | None = None,
        retry_seconds: int = DEFAULT_RETRY_SECONDS,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._path = path
        self._retention_seconds = retention_seconds
        self._prune_interval_seconds = prune_interval_seconds
        self._live_flow_limit = live_flow_limit
        self._live_flow_bytes = live_flow_bytes
        self._queue_depth = queue_depth
        self._base_retry_seconds = retry_seconds
        self._clock = clock
        self._configured = False

        # Event-loop state.
        self._active_flows: dict[str, http.HTTPFlow] = {}
        self._retained: deque[tuple[http.HTTPFlow, int]] = deque()
        self._retained_ids: set[str] = set()
        self._retained_bytes = 0
        self._dropped = 0
        self._queue: queue.Queue | None = None

        # Writer-thread state.
        self._db: sqlite3.Connection | None = None
        self._retry_at = 0.0
        self._retry_seconds = retry_seconds
        self._degraded = False
        self._last_prune = 0.0
        self._writer: threading.Thread | None = None

    def running(self) -> None:
        self._configure()
        if self._writer is None:
            self._queue = queue.Queue(maxsize=self._queue_depth or DEFAULT_QUEUE_DEPTH)
            self._writer = threading.Thread(
                target=self._run_writer,
                name="ai-sandbox-proxy-flow-store",
                daemon=True,
            )
            self._writer.start()

    def request(self, flow: http.HTTPFlow) -> None:
        if len(self._active_flows) >= MAX_ACTIVE_FLOWS:
            self._active_flows.pop(next(iter(self._active_flows)), None)
        self._active_flows[flow.id] = flow

    def response(self, flow: http.HTTPFlow) -> None:
        if flow.websocket is None:
            self._finish(flow)

    def error(self, flow: http.HTTPFlow) -> None:
        self._finish(flow)

    def websocket_end(self, flow: http.HTTPFlow) -> None:
        self._finish(flow)

    def done(self) -> None:
        pending = list(self._active_flows.values())
        self._active_flows.clear()
        self._retained.clear()
        self._retained_ids.clear()
        self._retained_bytes = 0
        for flow in pending:
            self._enqueue(flow)
        self._stop_writer()

    def _finish(self, flow: http.HTTPFlow) -> None:
        # Bookkeeping that bounds memory must not sit behind work that may fail.
        self._active_flows.pop(flow.id, None)
        self._retain(flow)
        self._enqueue(flow)

    def _retain(self, flow: http.HTTPFlow) -> None:
        """Bound mitmweb's in-memory flow list."""
        self._configure()
        limit = self._live_flow_limit
        budget = self._live_flow_bytes
        if limit is None or budget is None:
            return
        # A flow can finish twice (an error after a response).
        if flow.id in self._retained_ids:
            return
        size = _body_bytes(flow)
        self._retained.append((flow, size))
        self._retained_ids.add(flow.id)
        self._retained_bytes += size
        while self._retained and (
            len(self._retained) > limit or self._retained_bytes > budget
        ):
            oldest, oldest_size = self._retained.popleft()
            self._retained_ids.discard(oldest.id)
            self._retained_bytes -= oldest_size
            self._evict(oldest)

    def _evict(self, flow: http.HTTPFlow) -> None:
        master = getattr(ctx, "master", None)
        if master is None:
            return
        try:
            master.commands.call("view.flows.remove", [flow])
        except Exception:  # noqa: BLE001
            _safe_log(
                logging.DEBUG,
                "flow-store: could not evict flow %s",
                flow.id,
                exc_info=True,
            )

    def _enqueue(self, flow: http.HTTPFlow) -> None:
        """Hand a flow to the writer thread. Never blocks, never raises."""
        pending = self._queue
        if pending is None:
            return
        try:
            pending.put_nowait(flow)
        except queue.Full:
            try:
                pending.get_nowait()
                pending.task_done()
            except queue.Empty:
                pass
            try:
                pending.put_nowait(flow)
            except queue.Full:
                pass
            self._dropped += 1
            if self._dropped == 1 or self._dropped % 1000 == 0:
                _safe_log(
                    logging.WARNING,
                    "flow-store: write queue full, dropped %s flow(s) so far",
                    self._dropped,
                )

    def _run_writer(self) -> None:
        pending = self._queue
        if pending is None:
            return
        interval = max(
            1, self._prune_interval_seconds or DEFAULT_PRUNE_INTERVAL_SECONDS
        )
        while True:
            try:
                try:
                    # The timeout doubles as the retention sweep timer.
                    item = pending.get(timeout=interval)
                except queue.Empty:
                    self._sweep()
                    continue
                try:
                    if item is _SHUTDOWN:
                        return
                    self._archive(item)
                finally:
                    pending.task_done()
            except Exception:  # noqa: BLE001
                # Sole consumer of the queue: absorb anything and keep draining.
                _safe_log(
                    logging.DEBUG, "flow-store: writer iteration failed", exc_info=True
                )
                time.sleep(0.1)

    def _stop_writer(self) -> None:
        pending = self._queue
        writer = self._writer
        if pending is None or writer is None:
            self._close()
            return
        try:
            pending.put_nowait(_SHUTDOWN)
        except queue.Full:
            try:
                pending.get_nowait()
                pending.task_done()
                pending.put_nowait(_SHUTDOWN)
            except (queue.Empty, queue.Full):
                pass
        writer.join(timeout=SHUTDOWN_TIMEOUT_SECONDS)
        if writer.is_alive():
            _safe_log(
                logging.WARNING, "flow-store: writer did not stop within the timeout"
            )
        self._writer = None
        self._queue = None
        self._close()

    def _sweep(self) -> None:
        """Periodic retention prune. Never raises."""
        try:
            if self._open() is not None:
                self._prune(force=True)
        except Exception as error:  # noqa: BLE001
            _safe_log(
                logging.DEBUG, "flow-store: retention sweep failed", exc_info=True
            )
            self._degrade(error)

    def _archive(self, flow: http.HTTPFlow) -> None:
        """Persist one flow. Never raises."""
        try:
            self._save(flow)
        except Exception as error:  # noqa: BLE001
            _safe_log(
                logging.DEBUG,
                "flow-store: archiving %s failed",
                flow.id,
                exc_info=True,
            )
            self._degrade(error)

    def _degrade(self, error: BaseException) -> None:
        """Turn archiving off until the retry window elapses."""
        self._close()
        self._retry_at = self._clock() + self._retry_seconds
        if not self._degraded:
            self._degraded = True
            _safe_log(
                logging.WARNING,
                "flow-store: archiving paused for %ss after error: %s",
                self._retry_seconds,
                error,
            )
        self._retry_seconds = min(self._retry_seconds * 2, MAX_RETRY_SECONDS)

    def _close(self) -> None:
        if self._db is None:
            return
        try:
            self._db.close()
        except Exception:  # noqa: BLE001
            _safe_log(
                logging.DEBUG, "flow-store: closing the database failed", exc_info=True
            )
        self._db = None

    def _configure(self) -> None:
        if self._configured:
            return
        if self._retention_seconds is None:
            self._retention_seconds = _positive_env(
                "PROXY_FLOW_RETENTION_SECONDS", DEFAULT_RETENTION_SECONDS
            )
        if self._prune_interval_seconds is None:
            self._prune_interval_seconds = _positive_env(
                "PROXY_FLOW_PRUNE_INTERVAL_SECONDS", DEFAULT_PRUNE_INTERVAL_SECONDS
            )
        if self._live_flow_limit is None:
            self._live_flow_limit = _positive_env(
                "PROXY_FLOW_LIVE_LIMIT", DEFAULT_LIVE_FLOW_LIMIT
            )
        if self._live_flow_bytes is None:
            self._live_flow_bytes = _positive_env(
                "PROXY_FLOW_LIVE_BYTES", DEFAULT_LIVE_FLOW_BYTES
            )
        if self._queue_depth is None:
            self._queue_depth = _positive_env(
                "PROXY_FLOW_QUEUE_DEPTH", DEFAULT_QUEUE_DEPTH
            )
        self._configured = True

    def _open(self) -> sqlite3.Connection | None:
        """Return a usable connection, or None while archiving is degraded."""
        if self._db is not None:
            return self._db
        if self._clock() < self._retry_at:
            return None
        try:
            self._db = self._connect()
        except Exception as error:  # noqa: BLE001
            _safe_log(
                logging.DEBUG, "flow-store: opening the database failed", exc_info=True
            )
            self._degrade(error)
            return None
        self._retry_seconds = self._base_retry_seconds
        if self._degraded:
            self._degraded = False
            _safe_log(logging.INFO, "flow-store: archiving resumed")
        return self._db

    def _connect(self) -> sqlite3.Connection:
        path = Path(
            self._path
            or os.environ.get(
                "PROXY_FLOW_DATABASE",
                "~/.local/state/ai-sandbox-proxy/flows.sqlite3",
            )
        ).expanduser()

        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.parent.chmod(0o700)
        database = sqlite3.connect(path, timeout=5)
        path.chmod(0o600)
        database.execute("PRAGMA busy_timeout=5000")
        database.execute("PRAGMA journal_mode=DELETE")
        database.execute("PRAGMA synchronous=FULL")
        database.execute("PRAGMA secure_delete=ON")
        database.execute("PRAGMA auto_vacuum=INCREMENTAL")
        database.executescript(
            """
            CREATE TABLE IF NOT EXISTS flows (
                flow_id TEXT PRIMARY KEY,
                stored_at REAL NOT NULL,
                flow BLOB NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS flows_stored_at_idx ON flows (stored_at);
            """
        )
        # Fail on open rather than on every response if the file is read-only.
        database.execute("DELETE FROM flows WHERE 0")
        database.commit()
        return database

    def _save(self, flow: http.HTTPFlow) -> None:
        database = self._open()
        if database is None:
            return
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


addons = [StreamServerSentEvents(), FlowStore()]
