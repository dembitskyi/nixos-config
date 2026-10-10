---
name: crew
description: Default strategy for working with the crew of subagents, covering which member takes which step, the build-review-escalate flow, briefing, background runs, and checking results. Load before your first delegation in a session.
---

# Working with the crew

The crew is the set of subagents listed in the `subagent` tool, each with the model it runs on. The user turns members on and off for the session with /crew: use only the listed members, and do a missing member's step yourself. Each member has a `crew-<member>` skill with its briefing guide; load it before you first brief that member (several in one turn when you plan to use several).

## Roles

| Step | Member |
| --- | --- |
| Find files, symbols, and how code fits together | explore |
| Research documentation, the web, or configuration | general |
| Options, trade-offs, and risks before committing to an approach | critic |
| Small, well-specified code changes | dev-junior |
| Changes that need design judgment or debugging | dev-senior |
| Very tough problems, or work dev-senior failed | dev-master |
| Independent review of a finished change | reviewer |
| Pull requests | pr |
| Images and screenshots | vision |

Hosts can add specialists to the crew; route their domain to them and load their `crew-<member>` skill when one is listed.

## Default flow

1. **Understand.** Read the key files yourself. Send broad or parallel code searches to explore and outside research to general.
1. **Decide.** When there are several viable approaches, or the change is costly to reverse, ask critic for options. Decide yourself when the choice is within the user's request; bring real trade-offs to the user.
1. **Build.** Make small edits yourself. Delegate self-contained work to the cheapest member that can do it well: dev-junior, then dev-senior. Split large work into tasks on disjoint files and run them in parallel, or use lanes for many tasks (load the `lanes` skill).
1. **Review.** After a non-trivial change (several files, tricky logic, security or data handling, public interfaces), ask reviewer before you report completion. Fix blockers and majors, then re-review only what changed.
1. **Escalate.** When an attempt by dev-senior or you fails twice, or the problem is an elusive bug or deep design, hand it to dev-master with all the evidence.
1. **Verify and report.** Run the checks yourself and compare the result against every requirement before reporting.

Skip steps that add nothing: a one-line fix needs neither critic nor reviewer.

## Running members

- Launch members in the background (`background: true`) and continue only with independent work; you are notified when one finishes. Do not poll or duplicate its work.
- Launch independent members together in one turn. Never let two members edit the same files at the same time.
- Continue a member's work (follow-ups, fixes after review) by passing its `sessionID` instead of starting a new session.
- Members cannot ask the user or launch subagents: they make reasonable assumptions and report them. Answer what you can in the brief.
- Use each member's configured model; pass `model` only when the user asks for one.

## Briefing

Members do not see this conversation, so every brief is self-contained:

- **Goal:** what and why, in one or two sentences.
- **Scope:** repository path, files, or the diff, and what is out of scope.
- **Known facts:** findings, decisions, and failed attempts, so the member does not redo them.
- **Constraints:** repository conventions and forbidden actions (commits, pushes, deploys).
- **Done:** the acceptance criteria and the checks to run.
- **Report:** the format you want back.

## Results

- Treat reports as claims: check the facts and diffs your next step depends on.
- You own the outcome: review delegated changes, run the verification, and tell the user what is done, verified, and still open.
