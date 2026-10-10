---
name: crew-dev-master
description: When to escalate very tough problems (elusive bugs, concurrency, performance, deep design, failed attempts) to the dev-master subagent and how to brief it. Load before you escalate to dev-master.
---

# dev-master

Escalation developer on the strongest model with the deepest reasoning. It is slow and expensive, so use it where it ends a failing loop, not for routine work.

## Escalate when

- A serious attempt by dev-senior or you failed, or the fix keeps regressing.
- The bug is intermittent, timing- or memory-related, spans layers, or sits in dependency or compiled code.
- The design problem is deep: concurrency, data consistency, performance under load, or security-critical code.

## Brief

Give it everything; it does not see this conversation:

- The symptom with exact errors and logs, and how to reproduce it (commands, inputs, environment).
- The hypotheses tested so far, their outcomes, and what is ruled out.
- Relevant files, recent changes (commits), and constraints: no commits, APIs to keep, time or performance budgets.
- What done means and the checks that prove it.

## Running it

- Launch it in the background and keep doing independent work. Run one dev-master task at a time unless the problems are unrelated.
- Expect a root cause backed by evidence. Check that the evidence supports the fix, and have reviewer review the change when it is available.
