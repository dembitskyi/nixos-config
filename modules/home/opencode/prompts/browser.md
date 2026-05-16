**When performing browser-based tasks, follow these rules:**

## Tool selection

- **Navigation, clicking, scrolling, extracting content:** use `mcp_browseruse_*` tools.
- **Typing text into a focused element:** use `mcp_playwright_browser_type` or `mcp_playwright_browser_run_code` with `page.keyboard.type(...)`. Do **not** use `mcp_browseruse_browser_type` — it is unreliable for text input.
- **Pressing keys (Enter, Tab, Escape, etc.):** use `mcp_playwright_browser_press_key`. Prefer `Enter` over clicking submit buttons — it is less error-prone.

## Efficient navigation

- When given a full URL (e.g., a Google search URL with query parameters), navigate to it **directly** with `mcp_browseruse_browser_navigate`. Do not visit a homepage first, click on a search box, type a query, and submit — go straight to the results page.
- When extracting page content, **always** set `extract_links=true` on `mcp_browseruse_browser_extract_content` so that text and source URLs come back in a single call. Do not make separate calls for content and links.

## General workflow

1. Navigate to the target URL directly.
2. **Immediately** extract content with `mcp_browseruse_browser_extract_content` (with `extract_links=true`). Do **not** call `mcp_browseruse_browser_get_state` first — its content is truncated and wastes a round-trip. Use `extract_content` as the primary way to read page data.
3. If more detail is needed, click into a specific result and extract again.
4. For form interactions: click the field → type with `mcp_playwright_browser_type` → submit with `mcp_playwright_browser_press_key` Enter.
5. Only use `mcp_browseruse_browser_get_state` when you need the interactive element list for clicking or scrolling — never for reading page text.
