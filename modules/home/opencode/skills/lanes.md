---
name: lanes
description: How to run a goal as parallel lanes with the lanes_* tools (start, watch, steer, wait, stop) and get good results from the planner and its workers. Load before starting a lanes run.
---

# Lanes

A lanes run executes a goal as tasks in parallel worker sessions. A planner session splits the goal into tasks, picks a worker for each, refills lanes as tasks finish, re-plans on results and failures, and ends the run with a summary. You orchestrate: write the goal, answer the planner, steer, and verify the result.

## When lanes pay off

- The user asks for lanes, or the work splits into three or more independent tasks on disjoint files: features spanning modules, the same change across many files, independent fixes.
- Not for one or two tasks (launch subagents directly), tightly coupled edits to one file, or open-ended investigation where the plan depends on what you find (investigate first).

## Prepare

1. Investigate enough to write a precise goal: the relevant files, the conventions, the checks that prove the work (build, tests, formatter), and the constraints. The planner reads the repository but not this conversation.
1. Settle open design decisions first (with critic or the user); workers should implement, not choose architectures.
1. If /crew turned members off, say in `notes` which workers the planner must not use: lanes can start any subagent.

## Start

`lanes_start` returns at once:

- `goal`: the outcome, scope, constraints, and how to verify, self-contained.
- `lanes`: the user's number, otherwise about as many as tasks that can run at the same time. When omitted, the run takes the configured maximum.
- `notes`: shared decisions every task receives, e.g. "Follow AGENTS.md", "Never commit", "Use the new `fooBar` API".
- `tasks` (optional): tasks you already know, queued before the planner adds the rest. Each has a `title`, a self-contained `prompt` (what, where, conventions, checks, report), the `files` it edits, `deps` on task IDs that must finish first, and an `agent`: dev-junior (default; small and specified), dev-senior (judgment), dev-master (very hard), or reviewer (a review task after the tasks it `deps` on, with no `files`).

Lanes never run two tasks with overlapping `files` at the same time; tasks without `files` never wait for each other. A failed task is retried once automatically before the planner sees the failure.

## While it runs

- A status line in your context shows progress, and notes arrive on their own: `done` (with the planner's summary), `failed`, `blocked`, `question`, `stalled`, and `paused`. Do not poll.
- In a normal conversation, tell the user what is running and end your turn.
- Working without the user (a /goal, or Away in /crew): call `lanes_wait` instead of ending your turn. It returns when the run finishes or needs you (a question, a blocked lane, a stalled or paused planner), or after `minutes`.
- `lanes_status`: the board, or one task's report with `task`.
- `lanes_tell`: answer the planner's question or change priorities and scope. With `task`, message one worker: a queued task gets its prompt amended, a running one sees it at its next step, a finished one takes it as a follow-up.
- `lanes_update`: add tasks or notes (notes reach tasks that start afterwards) or change the number of lanes.
- `lanes_stop`: stop the run, or cancel one task with `task`.
- Blocked: a worker waits for a permission approval in its own session. Tell the user which session to open, unless Away approves it automatically.
- Stalled or paused: the planner stopped without finishing. Steer it with `lanes_tell` or stop the run.
- Provider limits or outages: once the user switches the member's model with /crew, ping the planner or the task with `lanes_tell`. The messaged session moves to the new model first, and retries, wake-ups, and new tasks use it too.

## Finish

- The `done` note carries the planner's summary of what was done, verified, and left open.
- Verify it yourself: read the combined diff, run the project's checks, and compare the result with every requirement. Ask reviewer to review a large run when it is available.
- Report to the user what was done, how it was verified, and what is still open.
