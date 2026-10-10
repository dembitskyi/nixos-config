---
name: browser-automation
description: Rules for browser tasks with the browser-use and Playwright MCP tools (navigation, extraction, forms, waits, tab sync). Load before any browser automation.
---

# Browser automation

The browser-use (`mcp_browseruse_*`) and Playwright (`mcp_playwright_*`) MCP tools drive the same logged-in browser over CDP. Call them from Code Mode as `tools.mcp_browseruse.<tool>(...)` and `tools.mcp_playwright.<tool>(...)`.

## Use the browser tools — nothing else

- Do **all** web access in a browser task through the browser tools; do not use `curl` or any shell/network command to fetch pages.
- If a browser tool fails, retry it or report the exact error — do not fall back to an out-of-browser fetch.

## Tool selection

- **Navigation, clicking, scrolling, extracting content:** use `mcp_browseruse_*` tools.
- **Typing text into a focused element:** use `mcp_playwright_browser_type` or `mcp_playwright_browser_run_code_unsafe` with `page.keyboard.type(...)`.
- **Pressing keys (Enter, Tab, Escape, etc.):** use `mcp_playwright_browser_press_key`. Prefer `Enter` over clicking submit buttons — it is less error-prone.

## Tab synchronization

Both tool sets connect to the same browser, but they track tabs independently. **After navigating or opening a new tab with browser-use**, always sync Playwright to the same tab:

1. Call `mcp_playwright_browser_tabs` (action: `list`) to see all tabs.
1. Call `mcp_playwright_browser_tabs` (action: `select`, index: N) to select the tab matching the URL you navigated to.

Do this **before** any Playwright typing or key-press calls. Otherwise Playwright may type into a stale or wrong tab.

## Waiting

- **Always** use `mcp_playwright_browser_wait_for` for waits — never use browser-use for waiting.
- After initial page navigation, use a short fixed wait (`time: 1`) — do NOT wait for specific text on initial load.
- For subsequent interactions (form submissions, clicking buttons), prefer `text` or `textGone` parameters for reliable condition-based waits.
- Only use longer `time` values as a last resort when no meaningful text indicator exists.

## Efficient navigation

- When given a full URL (e.g., a search URL with query parameters), navigate to it **directly** with `mcp_browseruse_browser_navigate`. Do not visit a homepage first and fill in a search box.
- When extracting page content, **always** set `extract_links=true` on `mcp_browseruse_browser_extract_content` so text and source URLs come back in a single call.

## General workflow

1. Navigate to the target URL directly.
1. **Immediately** extract content with `mcp_browseruse_browser_extract_content` (with `extract_links=true`). Do **not** call `mcp_browseruse_browser_get_state` first — its content is truncated and wastes a round-trip.
1. If more detail is needed, click into a specific result and extract again.
1. For form interactions: click the field → sync the Playwright tab → type with `mcp_playwright_browser_type` → submit with `mcp_playwright_browser_press_key` Enter.
1. Only use `mcp_browseruse_browser_get_state` when you need the interactive element list for clicking or scrolling — never for reading page text.
