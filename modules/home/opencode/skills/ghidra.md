---
name: ghidra
description: Decompile and analyze compiled binaries, shared libraries, executables, or firmware blobs with the headless Ghidra MCP tools. Load when source alone cannot explain a behavior.
---

# Decompiling with Ghidra

When an issue involves a compiled binary or shared library (a stripped `.so`, an executable, a firmware blob) and source alone is not enough, use the headless Ghidra MCP server (`mcp_ghidra_*`, called as `tools.mcp_ghidra.<tool>(...)` from Code Mode). It is fully automated — no Ghidra GUI, no manual setup. Drive the whole analysis yourself:

1. **Import** the target with `mcp_ghidra_import_binary` (absolute path to a file, or a directory to import recursively). Analysis runs in the background; the first call may take 10–60s while the JVM warms up.
1. **Inspect** with `mcp_ghidra_list_project_binaries` and `mcp_ghidra_list_project_binary_metadata` (architecture, format, hashes).
1. **Locate code** with `mcp_ghidra_search_symbols_by_name` (regex), `mcp_ghidra_search_strings`, `mcp_ghidra_search_code` (semantic pseudo-C search), and `mcp_ghidra_list_imports` / `mcp_ghidra_list_exports`.
1. **Decompile** with `mcp_ghidra_decompile_function` by name or address (pass a list for batch; set `include_callees` / `include_strings` / `include_xrefs` for surrounding context).
1. **Trace relationships** with `mcp_ghidra_list_xrefs`, `mcp_ghidra_gen_callgraph`, and `mcp_ghidra_read_bytes`.
1. Optionally **annotate** to aid the investigation with `mcp_ghidra_rename_function`, `mcp_ghidra_rename_variable`, `mcp_ghidra_set_variable_type`, `mcp_ghidra_set_function_prototype`, and `mcp_ghidra_set_comment`. These mutate only the scratch Ghidra project, never your files or the system.

Imported binaries persist across calls, so import once and reuse.
