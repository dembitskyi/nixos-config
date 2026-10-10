---
name: browser-automation
description: Rules for browser tasks with the Playwright MCP tools (navigation, reading pages, forms, waits, tabs). Load before any browser automation.
---

# Browser automation

The Playwright (`mcp_playwright_*`) MCP tools drive a logged-in browser over CDP. Call them from Code Mode as `tools.mcp_playwright.<tool>(...)`.

## Use the browser tools — nothing else

- Do **all** web access in a browser task through the browser tools; do not use `curl` or any shell/network command to fetch pages.
- If a browser tool fails, retry it or report the exact error — do not fall back to an out-of-browser fetch.

## Navigating and reading

- When given a full URL (e.g., a search URL with query parameters), navigate to it **directly** with `browser_navigate`. Do not visit a homepage first and fill in a search box.
- Read a page with `browser_snapshot`: it returns the page's text, links, and the `ref` of every element in one call. Prefer it over `browser_take_screenshot`, which you cannot act on.
- Click, type, and select by the `ref` values from the latest snapshot. Refs go stale when the page changes, so take a new snapshot after navigating or submitting.

## Forms and keys

- Type into a field with `browser_type`; fill several fields at once with `browser_fill_form`; pick dropdown values with `browser_select_option`.
- Press keys (Enter, Tab, Escape) with `browser_press_key`. Prefer `Enter` over clicking submit buttons — it is less error-prone.

## Tabs

- `browser_tabs` lists, opens, selects, and closes tabs. When several tabs are open, select the one you need before acting on it.

## Waiting

- **Always** use `browser_wait_for` for waits.
- After initial page navigation, use a short fixed wait (`time: 1`) — do NOT wait for specific text on initial load.
- For subsequent interactions (form submissions, clicking buttons), prefer `text` or `textGone` parameters for reliable condition-based waits.
- Only use longer `time` values as a last resort when no meaningful text indicator exists.

## General workflow

1. Navigate to the target URL directly.
1. Take a snapshot to read the page and find the elements you need.
1. If more detail is needed, click into a specific result and take a new snapshot.
1. For form interactions: type into the field with its `ref` → press `Enter` → wait for the result text.
