"""Record what fits from every flow, keep mitmweb's memory bounded, hide credentials.

mitmproxy holds each body in full before forwarding it, and mitmweb never
forgets a flow, so an always-on tracing proxy eventually runs out of memory.
Here responses, and requests that may exceed 8 MiB, pass through as they
arrive. A body is recorded only if it fits in 8 MiB; bigger ones keep just
their headers. WebSocket, TCP and UDP flows keep their newest 8 MiB of
messages. Every flow counts against the budget from its first event: once the
recorded data passes 1.5 GiB or 5000 flows, the oldest finished flows are
dropped. Open flows are never dropped (that would cut their connection); they
stay until they finish.

The recorded bytes are not all of the process (Python and glibc keep freed
memory), so its resident size is watched too. Past 5 GiB the finished flows
are shed down to a quarter of the budget and freed memory is handed back to
the system; past 6.5 GiB every finished flow goes and open flows stop
recording until memory falls back under 5 GiB. The service's hard limit is
8 GiB (proxy.nix).

Credentials (authorization, API-key and cookie headers) are blanked in the
recorded flow as soon as the request has gone out, which is no later than the
first response bytes. Replaying such a flow therefore fails authentication.
"""

from __future__ import annotations

import asyncio
import ctypes
import gc
import logging
import os
import time
from collections import OrderedDict

from mitmproxy import ctx, flow, http

log = logging.getLogger(__name__)

MAX_BODY = 8 * 1024 * 1024
MAX_TOTAL = 1536 * 1024 * 1024
MAX_FLOWS = 5000
# Rough cost of a flow without its bodies: headers, connections, certificates.
FLOW_OVERHEAD = 32 * 1024

SOFT_RSS = 5 * 1024**3
HARD_RSS = 6656 * 1024**2
CHECK_SECONDS = 5
# Shedding at the soft mark repeats at most this often.
SOFT_SECONDS = 60
# Freed memory is handed back once this much has been dropped.
TRIM_BYTES = 256 * 1024 * 1024

REQUEST_SECRETS = (
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "x-goog-api-key",
    "cookie",
)
RESPONSE_SECRETS = ("set-cookie",)
REDACTED = "[redacted]"

PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")
try:
    _malloc_trim = ctypes.CDLL("libc.so.6").malloc_trim
except (OSError, AttributeError):
    _malloc_trim = None


def _rss() -> int:
    with open("/proc/self/statm") as statm:
        return int(statm.read().split()[1]) * PAGE_SIZE


def _release_memory(collect: bool = False) -> None:
    """Return the freed heap to the system without pausing the event loop."""
    if collect:
        # Blocks every stream while it runs, so only in an emergency.
        gc.collect()
    if _malloc_trim is not None:
        # ctypes drops the GIL for the call, so a worker thread does the trim
        # while the event loop keeps forwarding.
        asyncio.get_running_loop().run_in_executor(None, _malloc_trim, 0)


def _mask(value: str) -> str:
    # Keep the scheme ("Bearer", "Basic") so the trace still shows the kind.
    scheme, sep, rest = value.partition(" ")
    if sep and rest and scheme.isalpha():
        return f"{scheme} {REDACTED}"
    return REDACTED


def _redact(headers: http.Headers, names: tuple[str, ...]) -> bool:
    changed = False
    for name in names:
        values = headers.get_all(name)
        masked = [v if v.endswith(REDACTED) else _mask(v) for v in values]
        if masked != values:
            headers.set_all(name, masked)
            changed = True
    return changed


def _finished(f: flow.Flow) -> bool:
    # A TCP flow whose connection failed keeps live=True forever.
    return not f.live or f.error is not None


def _kind(f: flow.Flow) -> str:
    return (
        "WebSocket"
        if isinstance(f, http.HTTPFlow)
        else type(f).__name__.removesuffix("Flow")
    )


def _messages(f: flow.Flow) -> list | None:
    if isinstance(f, http.HTTPFlow):
        return f.websocket.messages if f.websocket is not None else None
    return getattr(f, "messages", None)


class _Tee:
    """Forwards every chunk untouched; keeps a copy while the body fits."""

    __slots__ = ("copy", "reason", "settled", "size", "started")

    def __init__(self, record: bool) -> None:
        self.copy: bytearray | None = bytearray() if record else None
        self.reason = "" if record else " (memory pressure)"
        self.size = 0
        self.settled = False
        self.started = False

    def __call__(self, data: bytes) -> bytes:
        self.started = True
        self.size += len(data)
        if self.copy is not None:
            if self.size > MAX_BODY:
                self.copy = None
            else:
                self.copy.extend(data)
        return data

    def stop(self) -> None:
        if self.copy is not None:
            self.copy = None
            self.reason = " (memory pressure)"


class FlowLimit:
    def __init__(self) -> None:
        # Tracked flows, oldest first, with their counted size.
        self.sizes: OrderedDict[str, int] = OrderedDict()
        self.total = 0
        # Recorded message bytes and dropped messages of WebSocket/TCP/UDP flows.
        self.kept: dict[str, int] = {}
        self.dropped: dict[str, list[int]] = {}
        self.notes: dict[str, dict[str, str]] = {}
        self.recording = True
        self.freed = 0
        self.last_soft = 0.0
        self.task: asyncio.Task | None = None

    # --- Lifecycle ---

    def running(self) -> None:
        self.task = asyncio.get_running_loop().create_task(self._watch())

    def done(self) -> None:
        if self.task is not None:
            self.task.cancel()

    # --- HTTP ---

    def requestheaders(self, f: http.HTTPFlow) -> None:
        # Only requests that may not fit in memory stream; small ones keep
        # mitmproxy's normal path.
        size = f.request.headers.get("content-length", "")
        if not size.isdigit() or int(size) > MAX_BODY:
            f.request.stream = _Tee(self.recording)
        self._track(f, shed=False)

    def request(self, f: http.HTTPFlow) -> None:
        self._settle(f, f.request, complete=True)
        tee = f.request.stream
        # A streamed request has already gone out; a buffered one leaves after this hook.
        if isinstance(tee, _Tee) and tee.started:
            self._redact_request(f)
        self._track(f)

    def responseheaders(self, f: http.HTTPFlow) -> None:
        # The server answered, so the request is on the wire.
        self._redact_request(f)
        if not self.recording and f.request.stream is None and f.request.raw_content:
            # mitmproxy buffered this one itself; it is no longer needed.
            size = len(f.request.raw_content)
            f.request.raw_content = None
            self._note(
                f,
                "request",
                f"request body not recorded: {size} bytes (memory pressure)",
            )
        if f.response is not None:
            f.response.stream = _Tee(self.recording)

    def response(self, f: http.HTTPFlow) -> None:
        self._settle(f, f.response, complete=True)
        self._redact_request(f)
        self._redact_response(f)
        self._track(f)

    def error(self, f: http.HTTPFlow) -> None:
        self._settle(f, f.request, complete=False)
        self._settle(f, f.response, complete=False)
        self._redact_request(f)
        if f.response is not None and _redact(f.response.headers, RESPONSE_SECRETS):
            self._refresh(f)
        self._track(f)

    # --- WebSocket ---

    def websocket_message(self, f: http.HTTPFlow) -> None:
        self._trim(f)
        self._track(f)

    def websocket_end(self, f: http.HTTPFlow) -> None:
        self._trim(f, final=True)
        self._track(f)

    # --- TCP and UDP ---

    def tcp_start(self, f: flow.Flow) -> None:
        self._track(f, shed=False)

    def tcp_message(self, f: flow.Flow) -> None:
        self._trim(f)
        self._track(f)

    def tcp_end(self, f: flow.Flow) -> None:
        self._trim(f, final=True)
        self._track(f)

    def tcp_error(self, f: flow.Flow) -> None:
        self.tcp_end(f)

    def udp_start(self, f: flow.Flow) -> None:
        self._track(f, shed=False)

    def udp_message(self, f: flow.Flow) -> None:
        self._trim(f)
        self._track(f)

    def udp_end(self, f: flow.Flow) -> None:
        self._trim(f, final=True)
        self._track(f)

    def udp_error(self, f: flow.Flow) -> None:
        self.udp_end(f)

    # --- DNS ---

    def dns_request(self, f: flow.Flow) -> None:
        self._track(f, shed=False)

    def dns_response(self, f: flow.Flow) -> None:
        self._track(f)

    def dns_error(self, f: flow.Flow) -> None:
        self._track(f)

    # --- Recording ---

    def _note(self, f: flow.Flow, key: str, text: str) -> None:
        notes = self.notes.setdefault(f.id, {})
        notes[key] = text
        f.comment = "; ".join(notes.values())

    def _settle(
        self, f: http.HTTPFlow, message: http.Message | None, complete: bool
    ) -> None:
        """Give a message its recorded body once, or note why it has none."""
        tee = message.stream if message is not None else None
        if not isinstance(tee, _Tee) or tee.settled:
            return
        tee.settled = True
        copy, tee.copy = tee.copy, None
        if message.raw_content is not None:
            return
        if copy is None:
            side = "request" if message is f.request else "response"
            self._note(
                f, side, f"{side} body not recorded: {tee.size} bytes{tee.reason}"
            )
        elif complete or copy:
            message.raw_content = bytes(copy)

    def _trim(self, f: flow.Flow, final: bool = False) -> None:
        """Keep the newest 8 MiB of a flow's messages (none under memory pressure)."""
        messages = _messages(f)
        if not messages:
            return
        kept = self.kept.get(f.id, 0)
        if not final:
            kept += len(messages[-1].content or b"")
        limit = MAX_BODY if self.recording else 0
        # The newest message is still being forwarded while the flow is open.
        floor = 0 if final else 1
        drop = dropped_bytes = 0
        while kept > limit and len(messages) - drop > floor:
            size = len(messages[drop].content or b"")
            kept -= size
            dropped_bytes += size
            drop += 1
        self.kept[f.id] = kept
        if drop:
            del messages[:drop]
            totals = self.dropped.setdefault(f.id, [0, 0])
            totals[0] += drop
            totals[1] += dropped_bytes
            self.freed += dropped_bytes
            self._note(
                f,
                "messages",
                f"{totals[0]} earlier {_kind(f)} messages not kept ({totals[1]} bytes)",
            )

    # --- Credentials ---

    def _refresh(self, f: flow.Flow) -> None:
        # Push the redacted flow to open mitmweb pages, not just the store.
        view = ctx.master.addons.get("view")
        if view is not None:
            view.update([f])

    def _redact_request(self, f: http.HTTPFlow) -> None:
        if _redact(f.request.headers, REQUEST_SECRETS):
            self._refresh(f)

    def _redact_response(self, f: http.HTTPFlow) -> None:
        response = f.response
        if response is None or not any(n in response.headers for n in RESPONSE_SECRETS):
            return
        tee = response.stream
        if isinstance(tee, _Tee) and tee.started:
            # Streamed: the headers went to the client before the body.
            if _redact(response.headers, RESPONSE_SECRETS):
                self._refresh(f)
            return

        # A response without a body is sent right after this hook.
        def later() -> None:
            if f.response is not None and _redact(f.response.headers, RESPONSE_SECRETS):
                self._refresh(f)

        asyncio.get_running_loop().call_later(1.0, later)

    # --- Budget ---

    def _size(self, f: flow.Flow) -> int:
        size = FLOW_OVERHEAD + self.kept.get(f.id, 0)
        for message in (getattr(f, "request", None), getattr(f, "response", None)):
            if isinstance(message, http.Message):
                size += len(message.raw_content or b"")
        return size

    def _track(self, f: flow.Flow, shed: bool = True) -> None:
        size = self._size(f)
        self.total += size - self.sizes.get(f.id, 0)
        self.sizes[f.id] = size
        if shed and (self.total > MAX_TOTAL or len(self.sizes) > MAX_FLOWS):
            self._shed(MAX_TOTAL, MAX_FLOWS)

    def _forget(self, flow_id: str) -> int:
        size = self.sizes.pop(flow_id, 0)
        self.total -= size
        self.kept.pop(flow_id, None)
        self.dropped.pop(flow_id, None)
        self.notes.pop(flow_id, None)
        return size

    def _shed(self, max_total: int, max_flows: int) -> int:
        """Drop the oldest finished flows until both limits hold; returns the count."""
        view = ctx.master.addons.get("view")
        total, count = self.total, len(self.sizes)
        doomed: list[str] = []
        for flow_id, size in self.sizes.items():
            if total <= max_total and count <= max_flows:
                break
            f = view.get_by_id(flow_id) if view is not None else None
            if f is not None and not _finished(f):
                continue  # Still open: it stays until it finishes.
            doomed.append(flow_id)
            total -= size
            count -= 1
        for flow_id in doomed:
            self.freed += self._forget(flow_id)
            f = view.get_by_id(flow_id) if view is not None else None
            if f is not None:
                view.remove([f])
        return len(doomed)

    # --- Memory watchdog ---

    async def _watch(self) -> None:
        while True:
            await asyncio.sleep(CHECK_SECONDS)
            try:
                self._check_memory()
            except Exception:
                log.exception("flow-limit: memory check failed")

    def _check_memory(self) -> None:
        rss = _rss()
        now = time.monotonic()
        if rss >= HARD_RSS:
            self._relieve(rss, hard=True)
        elif rss >= SOFT_RSS and now - self.last_soft >= SOFT_SECONDS:
            self.last_soft = now
            self._relieve(rss, hard=False)
        elif rss < SOFT_RSS:
            if not self.recording:
                self.recording = True
                log.warning(
                    "flow-limit: memory back to %d MiB, recording resumed", rss >> 20
                )
            if self.freed >= TRIM_BYTES:
                self.freed = 0
                _release_memory()

    def _relieve(self, rss: int, hard: bool) -> None:
        entering = hard and self.recording
        if hard:
            # Everything finished goes; open flows stop recording.
            self.recording = False
            shed = self._shed(0, 0)
            view = ctx.master.addons.get("view")
            for flow_id in list(self.sizes):
                f = view.get_by_id(flow_id) if view is not None else None
                if f is None:
                    continue
                for message in (
                    getattr(f, "request", None),
                    getattr(f, "response", None),
                ):
                    if isinstance(message, http.Message) and isinstance(
                        message.stream, _Tee
                    ):
                        message.stream.stop()
                if _messages(f):
                    self._trim(f, final=True)
                    self._track(f)
        else:
            shed = self._shed(MAX_TOTAL // 4, MAX_FLOWS // 4)
        self.freed = 0
        _release_memory(collect=hard)
        if hard and not entering and not shed:
            return
        log.warning(
            "flow-limit: resident memory %d MiB is past the %s mark; dropped %d finished flows%s",
            rss >> 20,
            "hard" if hard else "soft",
            shed,
            "; open flows stopped recording" if hard else "",
        )


addons = [FlowLimit()]
