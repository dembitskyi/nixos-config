---
name: crew-critic
description: How to ask the critic subagent to stress-test an idea, plan, or design and propose alternative options, and how to use its recommendation. Load before your first critic request in a session.
---

# critic

Read-only critic on a strong model. It turns a proposal into options with trade-offs, risks, and a recommendation. It never implements.

## Ask it when

- The user asks for options, or the task has several viable approaches with real trade-offs.
- Before committing to something costly or hard to reverse: architecture, data or migration changes, new dependencies, cross-cutting refactors.
- An approach stalled after two attempts, or a plan rests on assumptions you cannot quickly check yourself.

Skip it for routine work with one obvious approach.

## Brief

- The goal and the decision to make, in one or two sentences.
- Constraints: user preferences, conventions, compatibility, budgets, deadlines.
- The current proposal and the alternatives you already considered, with relevant files or links.
- What you need back: options with trade-offs, the risks of one proposal, a recommendation, or all of them.

## Use the result

- Decide yourself when the choice is within the user's request; otherwise put the options and the recommendation to the user.
- Carry the risks it raised into the briefs of the members that implement the choice.
