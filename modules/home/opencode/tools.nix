# Named action sets for agent allow-lists (`mine.home.opencode.agents.<name>.tools`).
# Entries are OpenCode V2 permission actions: built-in tool names, plugin tool
# names, or `<server>_<tool>` for MCP tools. Wildcards are allowed and a `!`
# prefix denies, so a set may narrow its own wildcard.
{
  read = [
    "read"
    "glob"
    "grep"
  ];

  # Edit also covers the write and patch tools.
  write = [
    "edit"
    "shell"
  ];

  # Web search (ai-search provider) and the opencode-mem memory tool.
  research = [
    "websearch"
    "memory"
  ];

  # Code Mode session utilities (rename/move sessions, list models, MCP resources).
  opencode = [ "opencode_*" ];

  github = [ "mcp_github_*" ];
  # GitHub without writes: fetching, listing, and searching only.
  githubRead = [
    "mcp_github_get_*"
    "mcp_github_list_*"
    "mcp_github_search_*"
  ];
  context7 = [ "mcp_context7_*" ];
  jira = [ "mcp_jira_jira_*" ];
  confluence = [ "mcp_jira_confluence_*" ];
  ghidra = [ "mcp_ghidra_*" ];
  playwright = [ "mcp_playwright_*" ];

  # Lanes runs: control for orchestrators, planning for the lanes planner.
  lanes = [ "lanes_*" ];
  plan = [
    "plan_*"
    "lanes_status"
  ];

  # Typing, screenshots, tab handling and the autonomous agent are unreliable
  # in browser-use; playwright covers them.
  browseruse = [
    "mcp_browseruse_*"
    "!mcp_browseruse_browser_type"
    "!mcp_browseruse_browser_screenshot"
    "!mcp_browseruse_browser_list_tabs"
    "!mcp_browseruse_browser_switch_tab"
    "!mcp_browseruse_browser_close_tab"
    "!mcp_browseruse_browser_retry_with_browser_use_agent"
  ];
}
