"""Stream every body through mitmweb, record only what fits, and cap the flow list.

mitmproxy holds each body in full before forwarding it, and mitmweb never
forgets a flow, so an always-on tracing proxy eventually runs out of memory.
Here responses, and requests that may exceed 8 MiB, pass through as they
arrive. A body is recorded only if it fits in 8 MiB; bigger ones keep just
their headers. Once the recorded bodies pass 1.75 GiB or 5000 flows, the
oldest finished flows are dropped.
"""

from __future__ import annotations

from collections import OrderedDict

from mitmproxy import ctx, http

MAX_BODY = 8 * 1024 * 1024
MAX_TOTAL = 1792 * 1024 * 1024
MAX_FLOWS = 5000


class _Tee:
    """Forwards every chunk untouched; keeps a copy while the body fits."""

    __slots__ = ("copy", "size", "settled")

    def __init__(self) -> None:
        self.copy: bytearray | None = bytearray()
        self.size = 0
        self.settled = False

    def __call__(self, data: bytes) -> bytes:
        self.size += len(data)
        if self.copy is not None:
            if self.size > MAX_BODY:
                self.copy = None
            else:
                self.copy.extend(data)
        return data


def _settle(flow: http.HTTPFlow, message: http.Message | None, complete: bool) -> None:
    """Give a message its recorded body once, or note why it has none."""
    tee = message.stream if message is not None else None
    if not isinstance(tee, _Tee) or tee.settled:
        return
    tee.settled = True
    copy, tee.copy = tee.copy, None
    if message.raw_content is not None:
        return
    if copy is None:
        side = "request" if message is flow.request else "response"
        note = f"{side} body not recorded: {tee.size} bytes"
        flow.comment = f"{flow.comment}; {note}" if flow.comment else note
    elif complete or copy:
        message.raw_content = bytes(copy)


def _recorded_bytes(flow: http.HTTPFlow) -> int:
    return sum(len(m.raw_content or b"") for m in (flow.request, flow.response) if m is not None)


class FlowLimit:
    def __init__(self) -> None:
        self.sizes: OrderedDict[str, int] = OrderedDict()
        self.total = 0

    def requestheaders(self, flow: http.HTTPFlow) -> None:
        # Only requests that may not fit in memory stream; small ones keep
        # mitmproxy's normal path.
        size = flow.request.headers.get("content-length", "")
        if not size.isdigit() or int(size) > MAX_BODY:
            flow.request.stream = _Tee()

    def request(self, flow: http.HTTPFlow) -> None:
        _settle(flow, flow.request, complete=True)
        if flow.id in self.sizes:  # The response finished first.
            self._track(flow)

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        if flow.response is not None:
            flow.response.stream = _Tee()

    def response(self, flow: http.HTTPFlow) -> None:
        _settle(flow, flow.response, complete=True)
        self._track(flow)

    def error(self, flow: http.HTTPFlow) -> None:
        _settle(flow, flow.request, complete=False)
        _settle(flow, flow.response, complete=False)
        self._track(flow)

    def _track(self, flow: http.HTTPFlow) -> None:
        size = _recorded_bytes(flow)
        self.total += size - self.sizes.get(flow.id, 0)
        self.sizes[flow.id] = size
        view = ctx.master.addons.get("view")
        while len(self.sizes) > 1 and (self.total > MAX_TOTAL or len(self.sizes) > MAX_FLOWS):
            old_id, old_size = self.sizes.popitem(last=False)
            self.total -= old_size
            old = view.get_by_id(old_id) if view is not None else None
            if old is not None and not old.killable:
                view.remove([old])


addons = [FlowLimit()]
