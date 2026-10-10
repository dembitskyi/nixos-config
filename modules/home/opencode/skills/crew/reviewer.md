---
name: crew-reviewer
description: How to request an independent code review from the reviewer subagent and act on its verdict and findings. Load before your first review request in a session.
---

# reviewer

Read-only reviewer on a strong model. It reads the change and the code around it, runs cheap checks, and returns a verdict with findings by severity. It never edits.

## Ask for a review

- After non-trivial changes: several files, tricky logic, concurrency, security or data handling, public interfaces, or anything you or a dev member was unsure about.
- Before you report a large delegated change as done, and before a pull request.
- Skip it for trivial or mechanical edits that the checks already cover.

## Brief

- The intent: the user's requirements and the acceptance criteria.
- The scope: repository path and how to get the change (`git diff`, `git diff --staged`, `git diff <base>...HEAD`, a commit range, or a pull request), and the files that matter most.
- The checks already run with their results, and trade-offs you accepted on purpose.
- Focus areas or open questions, if any.

## Act on the result

- Fix blockers and majors yourself or through the dev member that wrote the change, or show with evidence why a finding is wrong. Minors and nits are optional.
- Re-review only the changed parts, in the same reviewer session (`sessionID`).
- Tell the user the verdict and any risks you accepted.
