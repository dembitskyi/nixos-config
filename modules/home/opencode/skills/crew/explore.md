---
name: crew-explore
description: How to brief the explore subagent for fast, read-only codebase searches and how to use its findings. Load before your first explore request in a session.
---

# explore

Fast, read-only code search. It finds files, symbols, and how code fits together, and answers with locations.

## Use it for

- Locating definitions, call sites, configuration, and conventions across a repository.
- "How does X work here?" questions that span several files.
- Several independent questions: launch one explore per question, in parallel.

## Not for

- One or two files you already know: read them yourself.
- Documentation or web research (general), edits (dev members), or judging designs (critic).

## Brief

- The question, and what you will do with the answer.
- Where to look (repository path, directories, also git-ignored ones it must name explicitly) and what to search for: symbols, strings, configuration keys, error messages.
- Thoroughness: `quick`, `medium`, or `very thorough`.
- The answer format: file paths with line numbers and one line of explanation per finding, no file dumps.

## Results

Its answer is a map, not proof: read the lines you rely on before editing or making claims.
