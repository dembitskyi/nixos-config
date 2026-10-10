---
name: crew-pr
description: How to hand pull request work (branch, commit, push, open or update the pull request) to the pr subagent. Load before delegating a pull request.
---

# pr

Creates and manages GitHub pull requests: the branch, commits, push, and the pull request itself.

## Delegate when

The user asks to create or update a pull request. Never create branches, commit, or push yourself for it; the pr subagent handles all of it.

## Brief

- The repository path and the base branch.
- What the change is and why, for the title and description, and any linked issues or tickets.
- Which files belong to the pull request when the working tree has unrelated changes.
- Draft or ready, reviewers, and labels, when the user specified them.

## Results

Report the pull request URL to the user, and anything it could not do.
