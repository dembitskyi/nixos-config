#!/usr/bin/env python3
"""OpenCode AI usage monitor and cost estimator for GitHub Copilot Enterprise."""

import argparse
import gc
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError

PRICING_PATH = Path(__file__).parent / "pricing.json"
DEFAULT_HOST = "http://127.0.0.1:4096"
VERBOSE = False

# Fetch messages in pages to avoid loading entire conversation history at once.
MESSAGE_PAGE_SIZE = 20


def log(msg: str):
    if VERBOSE:
        print(f"  [debug] {msg}", file=sys.stderr, flush=True)


def load_pricing(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def api_get_json(host: str, endpoint: str) -> any:
    """Fetch JSON from the API. Returns parsed object."""
    url = f"{host}{endpoint}"
    req = Request(url)
    try:
        with urlopen(req, timeout=60) as resp:
            raw = resp.read()
            log(f"GET {endpoint} → {len(raw):,} bytes")
            result = json.loads(raw)
            return result
    except URLError as e:
        print(f"Error: cannot reach OpenCode server at {host}: {e}", file=sys.stderr)
        sys.exit(1)


def get_sessions_page(host: str, limit: int, start: int | None = None) -> list:
    """Fetch a page of sessions. Uses 'start' timestamp filter and 'limit'."""
    params = f"limit={limit}"
    if start is not None:
        params += f"&start={start}"
    return api_get_json(host, f"/session?{params}")


def get_all_sessions(host: str, start_ts: int | None = None) -> list:
    """Fetch all sessions matching the start filter.

    Session metadata is small so we request a high limit to get everything in
    one shot. The heavy data (message content) is paginated separately.
    """
    sessions = get_sessions_page(host, 10000, start=start_ts)
    log(f"Sessions fetched: {len(sessions)}")
    return sessions


def get_messages_page(
    host: str, session_id: str, limit: int, before: str | None = None
) -> tuple[list, str | None]:
    """Fetch a page of messages. Returns (messages, next_cursor)."""
    params = f"limit={limit}"
    if before:
        params += f"&before={before}"
    url = f"{host}/session/{session_id}/message?{params}"
    req = Request(url)
    try:
        with urlopen(req, timeout=60) as resp:
            raw = resp.read()
            log(f"GET /session/{session_id}/message?{params} → {len(raw):,} bytes")
            # Extract cursor from response headers.
            next_cursor = resp.headers.get("X-Next-Cursor")
            messages = json.loads(raw)
            return messages, next_cursor
    except URLError as e:
        log(f"Error fetching messages for {session_id}: {e}")
        return [], None


def aggregate_session_into(agg: dict, host: str, session_id: str):
    """Fetch messages for a session page-by-page and aggregate usage into agg dict."""
    current_model = None
    current_provider = None
    cursor = None
    first_page = True

    while True:
        messages, next_cursor = get_messages_page(
            host, session_id, MESSAGE_PAGE_SIZE, cursor if not first_page else None
        )
        first_page = False

        if not messages:
            break

        for msg in messages:
            info = msg.get("info", {})
            role = info.get("role")

            if role == "user":
                model_info = info.get("model") or {}
                current_model = model_info.get("modelID", current_model)
                current_provider = model_info.get("providerID", current_provider)

            elif role == "assistant":
                for part in msg.get("parts", []):
                    if part.get("type") != "step-finish":
                        continue
                    tokens = part.get("tokens", {})
                    cache = tokens.get("cache", {})

                    model = current_model or "unknown"
                    if model not in agg:
                        agg[model] = {
                            "model": model,
                            "provider": current_provider or "unknown",
                            "steps": 0,
                            "input": 0,
                            "output": 0,
                            "reasoning": 0,
                            "cache_read": 0,
                            "cache_write": 0,
                            "total": 0,
                        }
                    a = agg[model]
                    a["steps"] += 1
                    a["input"] += tokens.get("input", 0)
                    a["output"] += tokens.get("output", 0)
                    a["reasoning"] += tokens.get("reasoning", 0)
                    a["cache_read"] += cache.get("read", 0)
                    a["cache_write"] += cache.get("write", 0)
                    a["total"] += tokens.get("total", 0)

        # Free the page immediately.
        del messages
        gc.collect()

        if not next_cursor:
            break
        cursor = next_cursor


def determine_billing_mode(pricing: dict, force_mode: str | None = None) -> str:
    """Determine which billing mode is active based on current date."""
    if force_mode:
        return force_mode

    now = datetime.now(timezone.utc).date()
    ai_credits = pricing["billing_modes"]["ai_credits"]
    effective_from = datetime.strptime(ai_credits["effective_from"], "%Y-%m-%d").date()

    if now >= effective_from:
        return "ai_credits"
    return "premium_requests"


def estimate_premium_requests(agg: dict, pricing: dict) -> dict:
    """Estimate cost using premium-request billing."""
    pr_config = pricing["billing_modes"]["premium_requests"]
    multipliers = pr_config["model_multipliers"]
    included = pr_config["included_per_user_month"]
    overage_rate = pr_config["overage_per_request_usd"]

    model_costs = {}
    total_weighted = 0.0

    for model, data in agg.items():
        mult = multipliers.get(model, 1.0)
        weighted = data["steps"] * mult
        total_weighted += weighted
        model_costs[model] = {
            "steps": data["steps"],
            "multiplier": mult,
            "weighted_requests": weighted,
        }

    overage = max(0, total_weighted - included)
    overage_cost = overage * overage_rate

    return {
        "mode": "premium_requests",
        "model_costs": model_costs,
        "total_weighted_requests": total_weighted,
        "included_allowance": included,
        "overage_requests": overage,
        "overage_cost_usd": overage_cost,
        "total_cost_usd": overage_cost,
    }


def estimate_ai_credits(agg: dict, pricing: dict) -> dict:
    """Estimate cost using token-based AI credits billing."""
    ac_config = pricing["billing_modes"]["ai_credits"]
    token_rates = ac_config["model_token_rates"]
    included_usd = ac_config["included_credits_per_user_month_usd"]

    model_costs = {}
    total_cost = 0.0

    for model, data in agg.items():
        rates = token_rates.get(model)
        if not rates:
            # Fallback: use gpt-5.4 rates for unknown models.
            rates = token_rates.get(
                "gpt-5.4",
                {
                    "input_per_1m": 2.50,
                    "output_per_1m": 10.00,
                    "cache_read_per_1m": 0.625,
                    "cache_write_per_1m": 2.50,
                },
            )

        cost_input = (data["input"] / 1_000_000) * rates["input_per_1m"]
        cost_output = ((data["output"] + data["reasoning"]) / 1_000_000) * rates[
            "output_per_1m"
        ]
        cost_cache_read = (data["cache_read"] / 1_000_000) * rates["cache_read_per_1m"]
        cost_cache_write = (data["cache_write"] / 1_000_000) * rates[
            "cache_write_per_1m"
        ]
        model_total = cost_input + cost_output + cost_cache_read + cost_cache_write

        model_costs[model] = {
            "cost_input": cost_input,
            "cost_output": cost_output,
            "cost_cache_read": cost_cache_read,
            "cost_cache_write": cost_cache_write,
            "total_usd": model_total,
        }
        total_cost += model_total

    overage = max(0, total_cost - included_usd)

    return {
        "mode": "ai_credits",
        "model_costs": model_costs,
        "total_token_cost_usd": total_cost,
        "included_credits_usd": included_usd,
        "overage_usd": overage,
        "total_cost_usd": overage,
    }


def fmt_num(n: int | float) -> str:
    """Format large numbers with comma separators."""
    if isinstance(n, float):
        return f"{n:,.2f}"
    return f"{n:,}"


def print_usage_table(agg: dict, date_range: tuple[str, str]):
    """Print token usage table."""
    print()
    print(f"  OpenCode Usage Report ({date_range[0]} → {date_range[1]})")
    print(f"  {'─' * 100}")

    header = f"  {'Model':<22} {'Steps':>7} {'Input':>12} {'Output':>12} {'Reasoning':>11} {'Cache Read':>14} {'Cache Write':>13} {'Total':>14}"
    print(header)
    print(f"  {'─' * 100}")

    totals = {
        "steps": 0,
        "input": 0,
        "output": 0,
        "reasoning": 0,
        "cache_read": 0,
        "cache_write": 0,
        "total": 0,
    }

    for model in sorted(agg.keys()):
        d = agg[model]
        print(
            f"  {model:<22} {fmt_num(d['steps']):>7} {fmt_num(d['input']):>12} {fmt_num(d['output']):>12} "
            f"{fmt_num(d['reasoning']):>11} {fmt_num(d['cache_read']):>14} {fmt_num(d['cache_write']):>13} {fmt_num(d['total']):>14}"
        )
        for k in totals:
            totals[k] += d[k]

    print(f"  {'─' * 100}")
    print(
        f"  {'TOTAL':<22} {fmt_num(totals['steps']):>7} {fmt_num(totals['input']):>12} {fmt_num(totals['output']):>12} "
        f"{fmt_num(totals['reasoning']):>11} {fmt_num(totals['cache_read']):>14} {fmt_num(totals['cache_write']):>13} {fmt_num(totals['total']):>14}"
    )
    print()


def print_cost_table_premium(estimate: dict):
    """Print cost breakdown for premium-request billing."""
    print("  Billing Mode: Premium Requests")
    print(f"  {'─' * 70}")
    header = f"  {'Model':<22} {'Steps':>7} {'Multiplier':>11} {'Weighted Req':>13}"
    print(header)
    print(f"  {'─' * 70}")

    for model in sorted(estimate["model_costs"].keys()):
        mc = estimate["model_costs"][model]
        print(
            f"  {model:<22} {fmt_num(mc['steps']):>7} {mc['multiplier']:>11.2f} {fmt_num(mc['weighted_requests']):>13}"
        )

    print(f"  {'─' * 70}")
    print(f"  Total weighted requests:  {fmt_num(estimate['total_weighted_requests'])}")
    print(f"  Included allowance:       {fmt_num(estimate['included_allowance'])}")
    print(f"  Overage requests:         {fmt_num(estimate['overage_requests'])}")
    print(f"  Overage cost:             ${estimate['overage_cost_usd']:,.2f}")
    print(f"  {'─' * 70}")
    print(f"  Estimated total cost:     ${estimate['total_cost_usd']:,.2f}")
    print()


def print_cost_table_credits(estimate: dict):
    """Print cost breakdown for AI credits billing."""
    print("  Billing Mode: AI Credits (token-based)")
    print(f"  {'─' * 85}")
    header = f"  {'Model':<22} {'Input $':>9} {'Output $':>10} {'Cache Rd $':>11} {'Cache Wr $':>11} {'Total $':>9}"
    print(header)
    print(f"  {'─' * 85}")

    for model in sorted(estimate["model_costs"].keys()):
        mc = estimate["model_costs"][model]
        print(
            f"  {model:<22} {mc['cost_input']:>9.2f} {mc['cost_output']:>10.2f} "
            f"{mc['cost_cache_read']:>11.2f} {mc['cost_cache_write']:>11.2f} {mc['total_usd']:>9.2f}"
        )

    print(f"  {'─' * 85}")
    print(f"  Total token cost:         ${estimate['total_token_cost_usd']:,.2f}")
    print(f"  Included credits:         ${estimate['included_credits_usd']:,.2f}")
    print(f"  Overage:                  ${estimate['overage_usd']:,.2f}")
    print(f"  {'─' * 85}")
    print(f"  Estimated total cost:     ${estimate['total_cost_usd']:,.2f}")
    print()


def current_month_boundaries() -> tuple[str, str]:
    """Return (first day of current month, first day of next month) as YYYY-MM-DD."""
    now = datetime.now(timezone.utc)
    first_of_month = now.replace(day=1)
    if now.month == 12:
        first_of_next = first_of_month.replace(year=now.year + 1, month=1)
    else:
        first_of_next = first_of_month.replace(month=now.month + 1)
    return first_of_month.strftime("%Y-%m-%d"), first_of_next.strftime("%Y-%m-%d")


def resolve_date_range(
    days: int | None, since: str | None, until: str | None
) -> tuple[int | None, int | None]:
    """Resolve date arguments into (start_ts_ms, end_ts_ms). Defaults to current month."""
    if days is not None:
        now = datetime.now(timezone.utc)
        start_ts = int((now.timestamp() - days * 86400) * 1000)
        return start_ts, None

    if since is None and until is None:
        since, until = current_month_boundaries()

    start_ts = None
    end_ts = None
    if since:
        start_ts = int(
            datetime.strptime(since, "%Y-%m-%d")
            .replace(tzinfo=timezone.utc)
            .timestamp()
            * 1000
        )
    if until:
        end_ts = int(
            datetime.strptime(until, "%Y-%m-%d")
            .replace(tzinfo=timezone.utc)
            .timestamp()
            * 1000
        )

    return start_ts, end_ts


def main():
    parser = argparse.ArgumentParser(
        prog="opencode-usage",
        description="Monitor OpenCode AI token usage and estimate GitHub Copilot costs.",
    )
    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help="OpenCode server address (default: %(default)s)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=None,
        help="Show usage for the last N days (default: current month)",
    )
    parser.add_argument("--since", default=None, help="Start date filter (YYYY-MM-DD)")
    parser.add_argument("--until", default=None, help="End date filter (YYYY-MM-DD)")
    parser.add_argument(
        "--pricing", default=str(PRICING_PATH), help="Path to pricing JSON file"
    )
    parser.add_argument(
        "--mode",
        choices=["premium_requests", "ai_credits", "both"],
        default=None,
        help="Force billing mode (default: auto-detect by date)",
    )
    parser.add_argument(
        "--json", action="store_true", help="Output raw JSON instead of tables"
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Show debug logs with memory usage per request",
    )
    args = parser.parse_args()

    global VERBOSE
    VERBOSE = args.verbose

    pricing = load_pricing(Path(args.pricing))

    start_ts, end_ts = resolve_date_range(args.days, args.since, args.until)

    # Use the 'start' query param to let the server filter by update time.
    print("  Fetching sessions from OpenCode...", end="", flush=True)
    sessions = get_all_sessions(args.host, start_ts=start_ts)

    # Client-side filter: the server's 'start' filters by updated time, but we
    # want sessions whose activity falls within [start_ts, end_ts). Filter by
    # updated time on both ends for consistency with billing periods.
    if start_ts is not None:
        sessions = [s for s in sessions if s["time"]["updated"] >= start_ts]
    if end_ts is not None:
        sessions = [s for s in sessions if s["time"]["updated"] < end_ts]

    print(f" {len(sessions)} sessions in range.")

    if not sessions:
        print("  No sessions match the given date range.")
        sys.exit(0)

    # Determine date range for display.
    if start_ts:
        earliest = datetime.fromtimestamp(start_ts / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%d"
        )
    else:
        earliest = datetime.fromtimestamp(
            min(s["time"]["updated"] for s in sessions) / 1000, tz=timezone.utc
        ).strftime("%Y-%m-%d")
    if end_ts:
        latest = datetime.fromtimestamp(end_ts / 1000, tz=timezone.utc).strftime(
            "%Y-%m-%d"
        )
    else:
        latest = datetime.fromtimestamp(
            max(s["time"]["updated"] for s in sessions) / 1000, tz=timezone.utc
        ).strftime("%Y-%m-%d")

    print(f"  Processing {len(sessions)} sessions ({earliest} → {latest})...")

    agg = {}
    t0 = time.monotonic()
    for i, session in enumerate(sessions):
        aggregate_session_into(agg, args.host, session["id"])
        if VERBOSE and (i + 1) % 10 == 0:
            elapsed = time.monotonic() - t0
            steps_so_far = sum(d["steps"] for d in agg.values())
            log(
                f"Processed {i + 1}/{len(sessions)} sessions, {steps_so_far} steps ({elapsed:.1f}s)"
            )

    total_steps = sum(d["steps"] for d in agg.values())
    elapsed = time.monotonic() - t0
    print(f"  Done: {total_steps} steps collected in {elapsed:.1f}s.")
    log("Final memory check")

    if not agg:
        print("  No usage data found.")
        sys.exit(0)

    # Determine billing mode.
    if args.mode == "both":
        modes = ["premium_requests", "ai_credits"]
    elif args.mode:
        modes = [args.mode]
    else:
        modes = [determine_billing_mode(pricing)]

    estimates = {}
    for mode in modes:
        if mode == "premium_requests":
            estimates[mode] = estimate_premium_requests(agg, pricing)
        else:
            estimates[mode] = estimate_ai_credits(agg, pricing)

    if args.json:
        output = {
            "date_range": {"from": earliest, "to": latest},
            "sessions": len(sessions),
            "steps": total_steps,
            "usage_by_model": agg,
            "estimates": estimates,
        }
        print(json.dumps(output, indent=2))
        return

    print_usage_table(agg, (earliest, latest))

    for mode in modes:
        if mode == "premium_requests":
            print_cost_table_premium(estimates[mode])
        else:
            print_cost_table_credits(estimates[mode])


if __name__ == "__main__":
    main()
