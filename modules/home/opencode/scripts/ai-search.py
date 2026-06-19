#!/usr/bin/env python3
"""AI web search via Playwright over CDP, for opencode context enrichment.

Drives an already-running Chrome (started with ``--remote-debugging-port``)
so searches run inside the user's real, logged-in session — Playwright never
launches or manages a browser. Submits a query to the chosen provider, waits
for the answer's Copy button to appear (the provider's completion signal), and
prints it as markdown on stdout so an opencode ``/search`` command can inject it
into the conversation.

Providers:
  perplexity  Types the query into perplexity.ai and copies the answer.
  google      Loads Google AI Mode (udm=50) with the query in the URL.
"""

import argparse
import os
import sys
import time
from urllib.parse import quote_plus

DEFAULT_CDP_URL = "http://127.0.0.1:9222"

PERPLEXITY_URL = "https://www.perplexity.ai/"
# Provider markup churns, so each step tries a list of selectors and tolerates
# misses. Kept together for easy tweaking.
_PPLX_ASK = [
    "textarea[placeholder]",
    "textarea",
    "div[contenteditable='true']",
    "[role='textbox']",
]
_PPLX_ANSWER = ["[id^='markdown-content']", ".prose"]
_PPLX_COPY = ["button[aria-label='Copy']", "button[data-testid='copy-code-button']"]
# The exact "Copy" action button only mounts once generation finishes — during
# streaming only a Stop control (and other copy-ish buttons) exist — so it is a
# reliable completion signal.
_PPLX_DONE = "button[aria-label='Copy']"

# Appended when the completion signal never arrived, so the answer below may be
# partial.
_TRUNCATED_NOTE = "_(Answer may be truncated: it was still generating at timeout.)_"


class SearchError(Exception):
    """Raised when the search can't be driven or scraped."""


# ── Public entry ─────────────────────────────────────────


def run_search(
    query: str,
    provider: str,
    cdp_url: str = DEFAULT_CDP_URL,
    timeout_ms: int = 60_000,
    settle_ms: int = 800,
) -> dict:
    """Run ``query`` on ``provider`` and return the scraped result.

    Returns ``{"query", "provider", "answer_md", "citations", "url"}`` where
    ``citations`` is a list of ``{"url", "title"}``. Raises :class:`SearchError`
    on any connection or scraping failure.
    """
    try:
        from playwright.sync_api import sync_playwright
        from playwright.sync_api import Error as PlaywrightError
    except ImportError as e:
        raise SearchError(
            "playwright is not installed in this environment."
        ) from e

    driver = {"perplexity": _drive_perplexity, "google": _drive_google}.get(provider)
    if driver is None:
        raise SearchError(f"Unknown provider '{provider}'. Use perplexity or google.")

    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(cdp_url)
        except PlaywrightError as e:
            raise SearchError(
                f"Could not connect to Chrome at {cdp_url}. Start the AI browser "
                f"(chromium --remote-debugging-port=9222)."
            ) from e

        # Reuse the user's logged-in context so cookies/session apply.
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()
        try:
            answer_md, citations, url = driver(
                context, page, query, timeout_ms, settle_ms
            )
        finally:
            page.close()

    return {
        "query": query,
        "provider": provider,
        "answer_md": answer_md,
        "citations": citations,
        "url": url,
    }


# ── Perplexity ───────────────────────────────────────────


def _drive_perplexity(context, page, query, timeout_ms, settle_ms):
    from playwright.sync_api import Error as PlaywrightError

    try:
        context.grant_permissions(
            ["clipboard-read", "clipboard-write"], origin=PERPLEXITY_URL
        )
    except PlaywrightError:
        pass  # Clipboard scrape is optional; DOM fallback covers it.

    page.goto(PERPLEXITY_URL, wait_until="domcontentloaded", timeout=timeout_ms)
    box = _first_visible(page, _PPLX_ASK, timeout_ms)
    if box is None:
        raise SearchError("Could not find the Perplexity search box.")
    box.click()
    page.keyboard.type(query)
    page.keyboard.press("Enter")

    text, completed = _wait_until_done(
        page, _PPLX_DONE, lambda: _longest_text(page, _PPLX_ANSWER), timeout_ms, settle_ms
    )
    if not text:
        raise SearchError("No answer appeared before the timeout.")

    answer_md = _pplx_copy_markdown(page) or text
    if not completed:
        answer_md += f"\n\n{_TRUNCATED_NOTE}"
    citations = _links_under(page, _PPLX_ANSWER, exclude="perplexity.ai")
    return answer_md, citations, page.url


def _pplx_copy_markdown(page):
    """Click Perplexity's Copy button and read markdown off the clipboard."""
    for selector in _PPLX_COPY:
        buttons = page.query_selector_all(selector)
        if not buttons:
            continue
        try:
            buttons[-1].click()
            page.wait_for_timeout(300)
            text = page.evaluate("() => navigator.clipboard.readText()")
        except Exception:
            continue
        if text and text.strip():
            return text.strip()
    return None


# ── Google AI Mode ───────────────────────────────────────

# Google rotates obfuscated class names, so as a fallback the answer is located
# structurally (the div with the most direct prose/list/heading children). The
# primary path is _google_answer below, which anchors on the answer action bar.
# udm=50 selects the AI Mode surface.
_GOOGLE_ANSWER_JS = """
() => {
  let best = null, bestScore = 0;
  for (const el of document.querySelectorAll('div')) {
    const blocks = el.querySelectorAll(
      ':scope > p, :scope > ul, :scope > ol, :scope > h1, :scope > h2, :scope > h3'
    ).length;
    if (blocks < 2) continue;
    const len = (el.innerText || '').trim().length;
    const score = blocks * 1000 + len;
    if (score > bestScore) { best = el; bestScore = score; }
  }
  return best ? best.innerText.trim() : '';
}
"""

# Google's answer action bar ("Copy text", Share, feedback) only appears once
# the AI Mode answer finishes streaming, so it is the completion signal. Note
# the page's "Stop" control belongs to the follow-up input box, not generation,
# so it cannot be used here.
_GOOGLE_DONE = "button[aria-label='Copy text']"

# Primary extractor: anchor on the "Copy text" action bar (part of the answer)
# and climb to the largest ancestor that doesn't yet swallow the verbatim query
# echo ("You said: <query>"), which sits with the page nav just above the
# answer. This yields the answer alone, free of nav noise, without depending on
# Google's obfuscated class names.
_GOOGLE_ANSWER_ANCHOR_JS = """
(query) => {
  const btn = [...document.querySelectorAll('button,[role=button]')]
    .find(b => (b.getAttribute('aria-label') || '') === 'Copy text');
  if (!btn) return '';
  const needle = query.trim().toLowerCase();
  let best = '', el = btn, depth = 0;
  while (el && depth < 18) {
    if (el.tagName === 'DIV') {
      const t = (el.innerText || '').trim();
      if (t.toLowerCase().includes(needle)) break;
      if (t.length > best.length) best = t;
    }
    el = el.parentElement;
    depth++;
  }
  return best;
}
"""


def _google_answer(page, query):
    """Extract the AI Mode answer text, robust to obfuscated class names.

    Primary path anchors on the "Copy text" action bar; the structural
    heuristic is the fallback for before that bar mounts (e.g. while still
    streaming), so quiescence checks have something to read.
    """
    try:
        text = page.evaluate(_GOOGLE_ANSWER_ANCHOR_JS, query)
    except Exception:
        text = ""
    if text and text.strip():
        return text.strip()
    return (page.evaluate(_GOOGLE_ANSWER_JS) or "").strip()


def _drive_google(context, page, query, timeout_ms, settle_ms):
    url = f"https://www.google.com/search?q={quote_plus(query)}&udm=50"
    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)

    text, completed = _wait_until_done(
        page, _GOOGLE_DONE, lambda: _google_answer(page, query), timeout_ms, settle_ms
    )
    if not text:
        raise SearchError("No answer appeared before the timeout.")

    citations = _google_citations(page)
    if not completed:
        text += f"\n\n{_TRUNCATED_NOTE}"
    return text, citations, page.url


def _google_citations(page):
    """External source links from the AI Mode answer, de-duplicated, in order."""
    raw = page.evaluate(
        """
        () => {
          const out = [];
          for (const a of document.querySelectorAll('a[href^="http"]')) {
            const h = a.href;
            if (h.includes('google.com') || h.includes('gstatic.com')) continue;
            out.push({ url: h, title: (a.innerText || '').trim() });
          }
          return out;
        }
        """
    )
    seen = {}
    for c in raw:
        url = c["url"]
        if url in seen:
            continue
        seen[url] = c["title"] or _domain(url)
    return [{"url": u, "title": t} for u, t in seen.items()]


# ── Shared helpers ───────────────────────────────────────


def _wait_until_done(page, done_selector, get_text, timeout_ms, settle_ms):
    """Wait for the provider's completion control, then return ``(text, completed)``.

    Providers stream tokens and only mount their answer action bar (the Copy
    button matched by ``done_selector``) once generation finishes, so that
    button — not text quiescence — is the completion signal. ``settle_ms`` is a
    short grace after the signal to let the final token render. ``completed`` is
    ``False`` if the timeout was hit first, in which case ``text`` may be partial.
    """
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        text = (get_text() or "").strip()
        if text and page.query_selector(done_selector):
            page.wait_for_timeout(settle_ms)
            return (get_text() or "").strip(), True
        page.wait_for_timeout(300)
    return (get_text() or "").strip(), False


def _longest_text(page, selectors):
    """Longest matching-element text currently on the page."""
    best = ""
    for selector in selectors:
        for el in page.query_selector_all(selector):
            try:
                text = (el.inner_text() or "").strip()
            except Exception:
                continue
            if len(text) > len(best):
                best = text
    return best


def _links_under(page, selectors, exclude):
    """External links inside the answer container, de-duplicated, in order."""
    seen = {}
    for selector in selectors:
        for el in page.query_selector_all(f"{selector} a[href^='http']"):
            href = el.get_attribute("href")
            if not href or exclude in href:
                continue
            title = (el.inner_text() or "").strip() or _domain(href)
            seen.setdefault(href, title)
    return [{"url": u, "title": t} for u, t in seen.items()]


def _first_visible(page, selectors, timeout_ms):
    """First visible element matching any selector within the timeout, or None."""
    deadline = time.time() + timeout_ms / 1000
    while time.time() < deadline:
        for selector in selectors:
            el = page.query_selector(selector)
            if el and el.is_visible():
                return el
        page.wait_for_timeout(200)
    return None


def _domain(url):
    from urllib.parse import urlparse

    return urlparse(url).netloc.removeprefix("www.")


# ── CLI ──────────────────────────────────────────────────


def _render(result):
    """Format the result as markdown for injection into opencode context."""
    lines = [f"# {result['provider'].title()} search: {result['query']}", ""]
    lines.append(result["answer_md"])
    if result["citations"]:
        lines += ["", "## Sources"]
        for i, c in enumerate(result["citations"], 1):
            lines.append(f"{i}. {c['title']} — {c['url']}")
    lines += ["", f"_Source: {result['url']}_"]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="AI web search over CDP.")
    parser.add_argument("query", nargs="+", help="The search query")
    parser.add_argument(
        "--provider",
        default=os.environ.get("AI_SEARCH_PROVIDER", "perplexity"),
        choices=["perplexity", "google"],
        help="Search provider (default: $AI_SEARCH_PROVIDER or perplexity).",
    )
    parser.add_argument("--cdp-url", default=os.environ.get("AI_SEARCH_CDP_URL", DEFAULT_CDP_URL))
    parser.add_argument("--timeout", type=float, default=60.0, help="Max seconds to wait")
    parser.add_argument(
        "--settle", type=float, default=0.8,
        help="Grace seconds after the completion signal, to let the last token render.",
    )
    args = parser.parse_args(argv)

    query = " ".join(args.query)
    try:
        result = run_search(
            query, args.provider, cdp_url=args.cdp_url,
            timeout_ms=int(args.timeout * 1000), settle_ms=int(args.settle * 1000),
        )
    except SearchError as e:
        # Print to stdout (not just stderr): opencode's command shell injection
        # captures stdout only and ignores exit codes, so a stderr-only error
        # would be swallowed and the /search command would silently inject
        # nothing. Emitting here keeps failures visible in the conversation.
        print(f"**Search failed ({args.provider}):** {e}")
        return 1

    print(_render(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
