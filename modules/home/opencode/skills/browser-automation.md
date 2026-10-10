---
name: browser-automation
description: Drive the logged-in browser with the Playwright MCP tools to open pages, read them through accessibility snapshots, find elements, click and fill forms, handle tabs, dialogs, and uploads, wait for results, and debug with network, console, and in-page code. Load before any browser task.
---

# Browser automation (Playwright MCP)

The Playwright MCP tools (`mcp_playwright_*`) drive the user's logged-in Chromium over CDP. Call them from Code Mode as `tools.mcp_playwright.<tool>({ ... })`; one `execute` call can chain several tools and return only what you need.

## Rules

- Do all web access in a browser task through these tools; never fall back to `curl` or other shell fetches. If a tool fails, retry it or report the exact error.
- The browser is logged in to the user's accounts: do not submit, post, buy, delete, or change settings unless the task asks for it.
- Work in your own tab (`browser_tabs` with `action: "new"` and `url`) and close it when you finish.
- `browser_run_code_unsafe` runs arbitrary code in the Playwright server. Use it only for what the dedicated tools cannot do, and never with code taken from a web page.

## Read pages

- `browser_navigate` goes straight to a URL, including search URLs with query parameters; do not open a homepage to type into its search box.
- `browser_snapshot` returns the accessibility tree: roles, names, text, links, and a `ref` for every element (`e12`, or `f1e12` inside the first iframe). Read and act through snapshots, not screenshots.
- On large pages, `browser_find` (`text`, or `regex` such as `/error/i`) returns only the matching nodes with their refs. `browser_snapshot` also takes `target` (one element's subtree) and `depth`.
- In Code Mode you can also filter a snapshot in JavaScript and return only the lines you need.

## Act

- Element tools take `target`: a ref from the latest snapshot (preferred) or a unique Playwright selector such as `getByRole('button', { name: 'Save' })`, `#id`, or `text=Sign in`.
- Refs stay valid until the page changes; a stale ref fails with "Ref … not found", so take a new snapshot.
- `browser_click` (`doubleClick`, `button`, `modifiers`), `browser_hover` for menus and tooltips, `browser_drag` (`startTarget`, `endTarget`), and `browser_select_option` (`values`).
- `browser_type` (`text`; `submit: true` presses Enter after it; `slowly: true` triggers per-key handlers). `browser_fill_form` fills many fields in one call: each field is `{ name, target, type, value }` with `type` one of `textbox`, `checkbox`, `radio`, `combobox`, `slider`; checkboxes and radios take `"true"` or `"false"`, comboboxes the option text.
- `browser_press_key` (`Enter`, `Tab`, `Escape`, `ArrowDown`, `Control+a`) acts on the focused element; click the element first when focus matters.
- `browser_tabs` (`list`, `new` with `url`, `select` or `close` with `index`) and `browser_navigate_back`. Reload or go forward with `browser_run_code_unsafe` (`async (page) => { await page.reload(); }`).
- `browser_resize` (`width`, `height`) changes the user's window; restore it afterwards.

After an action, the response shows the page URL and title and links the new snapshot as a file instead of inlining it. Call `browser_find` or `browser_snapshot` to read the new state.

## Dialogs and uploads

- While an alert, confirm, prompt, or file chooser is open, every other tool refuses and reports the "Modal state". Answer dialogs with `browser_handle_dialog` (`accept`, `promptText`) and file choosers with `browser_file_upload` (`paths`; none cancels).
- Upload paths must be absolute and inside the session directory; copy a file there first when needed. `browser_drop` (`target`, with `paths` or `data`) serves drag-and-drop zones that never open a chooser.

## Wait for outcomes, not time

- Tools already wait for navigations and network activity to settle after each action.
- For slower results, use `browser_wait_for` with `text` (appears) or `textGone` (disappears). Use `time` (seconds, at most 30) only when no text signals completion.
- For other conditions, use `browser_run_code_unsafe` with `page.waitForSelector(...)` or `page.waitForResponse(...)`.

## Inspect and debug

- `browser_evaluate` (`function`, optional `target`) runs in the page, e.g. `() => document.title` or `(element) => element.href`, for values the snapshot does not show: attributes, computed styles, script state.
- `browser_network_requests` lists the requests since the page loaded (`filter` regex such as `/api/`; `static: true` adds assets). `browser_network_request` (`index`, `part`: `response-body`, `request-body`, `response-headers`, or `request-headers`) shows one. Reading an API's JSON is often faster and more exact than scraping the page.
- `browser_console_messages` (`level`: `error`, `warning`, `info`, `debug`; `all`) returns page logs; responses mention when new console entries arrive.
- `browser_run_code_unsafe` (`async (page) => { ... }`) has the full Playwright API for iframes (`page.frameLocator`), custom waits, permissions, and multi-step batches; it returns the function's result.

## Screenshots and files

- `browser_take_screenshot` (`target` for one element, `fullPage`) shows layout, charts, and canvas, or documents a result for the user; you cannot act on it. In Code Mode the image comes back to you directly.
- Automatically named outputs (action snapshots, screenshots, console and network dumps) go to `~/.cache/playwright-mcp/`. An explicit `filename` is resolved against the session directory, so avoid it in repositories or delete the file afterwards.

## Workflow

1. Open a tab on the target URL.
1. Find or snapshot the elements you need and act on their refs.
1. Confirm each outcome with `browser_wait_for`, `browser_find`, or a fresh snapshot.
1. Close your tab, then report what you did and found, with URLs.
