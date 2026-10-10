---
name: crew-dev-senior
description: How to delegate complex code changes that need design judgment, debugging, or cross-cutting refactors to the dev-senior subagent and check its work. Load before you first brief dev-senior in a session.
---

# dev-senior

Developer subagent on a strong model, for work that needs judgment: designing within the codebase's patterns, debugging, and changes that span modules.

## Use it for

- Features that need design choices within a settled direction, refactors across modules, and bugs whose cause still has to be found.
- Work dev-junior failed or got wrong.

## Not for

- Fully specified or mechanical edits: dev-junior is faster and cheaper.
- Open choices between approaches (ask critic first), or problems that already resisted a serious attempt (dev-master).

## Brief

- The goal and why, the acceptance criteria, and the decisions already made, with the user's constraints.
- Pointers: relevant files, entry points, related code, and findings so far, including failed attempts.
- Boundaries: what not to change; no commits, pushes, or deploys.
- The checks to run and the report you want: changes, verification, assumptions, open issues.

## Results

- Review the diff and the reasoning behind it. For risky or large changes, ask reviewer before you report completion.
- Continue in the same session (`sessionID`) for follow-ups and review fixes.
