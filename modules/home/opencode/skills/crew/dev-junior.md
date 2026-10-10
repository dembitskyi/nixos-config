---
name: crew-dev-junior
description: How to delegate small, well-specified code changes (fixes, tests, mechanical edits) to the dev-junior subagent and check its work. Load before you first brief dev-junior in a session.
---

# dev-junior

Developer subagent on a fast, cheaper model, for changes whose design is already decided.

## Use it for

- Fixes with a known root cause, small features with a clear specification, tests, renames, and mechanical edits across files.
- Parallel batches: several dev-junior tasks on disjoint files at once.

## Not for

- Unclear requirements, design decisions, or bugs with an unknown cause (dev-senior or dev-master).

## Brief

- What to change, where (files and symbols), and the expected result. Include the exact API, snippet, or example to follow when you know it.
- Conventions to follow and files not to touch.
- The checks to run (build, tests, formatter) and what counts as done.
- Report: files changed, checks run with results, assumptions.

## Results

- Review its diff (`git diff`) before you report completion; send fixes back to the same session (`sessionID`).
- When it fails or has to guess at design, move the task to dev-senior with what it learned.
