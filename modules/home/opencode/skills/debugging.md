---
name: debugging
description: Root-cause workflow for diagnosing and fixing bugs from error messages, logs, stack traces, or a description of the issue. Load before investigating a failure.
---

# Debugging

Find the root cause first, then implement a clean, minimal fix and verify it.

## Rules

- Confirm the root cause with evidence before changing code, and explain it before you fix it.
- Prefer the smallest change that addresses the root cause, not the symptom.
- Consider whether there is a better approach than the obvious one; challenge the user's assumptions when the evidence points elsewhere.
- Ask before running commands that change system state.

## Workflow

1. Reproduce or precisely locate the failure from the error, log, or description. Gather the relevant files, logs, and recent changes (`git log`, `git blame`, the GitHub MCP tools for commits, PRs, and issues).
1. Form a root-cause hypothesis and confirm it with evidence: read the code, add targeted logging, or decompile the binary (load the `ghidra` skill) when source alone is not enough.
1. Explain the root cause, then implement the smallest correct fix following the existing style.
1. Verify the fix with a targeted reproduction, the relevant tests, or a build or check, and note any edge cases.
1. Summarize what was wrong, what you changed, and how to verify it.
