"""
mitmdump addon that logs every request and response with pretty-printed JSON bodies.

Writes timestamped, human-readable entries to the log file specified by the
PROXY_LOG_FILE environment variable (defaults to /tmp/opencode-proxy.log).
"""

import json
import os
import time

from mitmproxy import http

LOG_FILE = os.environ.get("PROXY_LOG_FILE", "/tmp/opencode-proxy.log")
LOG_GATE = "/tmp/fastmcp-proxy-log"
SEPARATOR = "=" * 100


def _pretty_json(raw: bytes) -> str:
    try:
        return json.dumps(json.loads(raw), indent=2, ensure_ascii=False)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return raw.decode("utf-8", errors="replace")


def _pretty_body(raw: bytes) -> str:
    """Pretty-print a response body, handling SSE `data:` lines."""
    text = raw.decode("utf-8", errors="replace")
    lines = text.split("\n")

    has_sse = any(line.startswith("data: ") for line in lines)
    if not has_sse:
        return _pretty_json(raw)

    result: list[str] = []
    for line in lines:
        if line.startswith("data: "):
            payload = line[len("data: ") :]
            try:
                parsed = json.loads(payload)
                result.append(
                    "data: " + json.dumps(parsed, indent=2, ensure_ascii=False)
                )
            except (json.JSONDecodeError, ValueError):
                result.append(line)
        else:
            result.append(line)
    return "\n".join(result)


def _should_log() -> bool:
    return os.path.exists(LOG_GATE)


def _write(lines: list[str]) -> None:
    with open(LOG_FILE, "a") as f:
        f.write("\n".join(lines) + "\n\n")


def request(flow: http.HTTPFlow) -> None:
    if not _should_log():
        return
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    req = flow.request
    lines = [
        SEPARATOR,
        f"[{ts}] >>> REQUEST  {req.method} {req.pretty_url}",
        SEPARATOR,
        "",
        "Headers:",
    ]
    for k, v in req.headers.items():
        # Redact auth tokens in logs.
        if k.lower() in ("authorization", "x-api-key", "api-key"):
            v = v[:12] + "..." if len(v) > 12 else "***"
        lines.append(f"  {k}: {v}")

    if req.content:
        lines.append("")
        lines.append("Body:")
        lines.append(_pretty_json(req.content))

    _write(lines)


def response(flow: http.HTTPFlow) -> None:
    if flow.response is None or not _should_log():
        return

    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    res = flow.response
    lines = [
        SEPARATOR,
        f"[{ts}] <<< RESPONSE {res.status_code} {res.reason} "
        f"for {flow.request.method} {flow.request.pretty_url}",
        SEPARATOR,
        "",
        "Headers:",
    ]
    for k, v in res.headers.items():
        lines.append(f"  {k}: {v}")

    if res.content:
        lines.append("")
        lines.append("Body:")
        lines.append(_pretty_body(res.content))

    _write(lines)
