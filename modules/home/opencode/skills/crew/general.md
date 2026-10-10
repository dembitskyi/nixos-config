---
name: crew-general
description: How to brief the general subagent for software and configuration research (documentation, web search, local inspection) and how to use its findings. Load before your first general request in a session.
---

# general

Research subagent with your tools, minus questions and lanes: documentation and web search, local code and configuration inspection, and changes only when you authorize them.

## Use it for

- Questions that need several sources: library and tool behavior, version differences, configuration options, unfamiliar errors.
- Investigations that can run in the background while you continue.

## Not for

- Plain code search in a repository (explore), implementation (dev members), or choosing between approaches (critic).

## Brief

- The questions, numbered, and the decision they feed.
- Context it cannot see: exact versions, relevant local paths, what you already know or ruled out, and good search terms.
- Whether it may change anything; research is read-only unless you say otherwise.
- The answer format: findings with sources (paths with line numbers, URLs), verified facts separated from inference.

## Results

- Check the cited sources for the facts your decision hinges on.
- It keeps private code, logs, and internal URLs out of public searches; do not ask it to send them.
