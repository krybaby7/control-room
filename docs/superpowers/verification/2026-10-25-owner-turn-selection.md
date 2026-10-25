# Owner-turn selection verification — 2026-10-25

The first cloud-aware briefing of Trade Graph (version 24) read 17 of the owner's 23 cloud sessions and 89 of 129 messages, because the owner-turn budget of 28,000 characters filled before the oldest sessions. The owner pointed out that part of that budget was spent on messages they did not write: handoff briefs produced by one assistant and pasted into a new session, which are long, well structured, and restate intentions already given in the owner's own words elsewhere. The owner's own style is short lines or, at most, bullet points.

## What changed

- `isPastedBrief(text)` in `companion/briefing-evidence.mjs`: a turn is treated as a pasted brief when it carries the paste marker (`<pasted_content`), opens like an assistant-written brief ("You are", "You're", "Background (from the session", a Markdown title) and runs past 600 characters, or runs past 800 characters under three or more Markdown headings. Bullet points alone never match. Such turns are left out of the owner's turns; a session left with nothing else is skipped; `pastedBriefs` counts them per session so the model and the coverage line can say so.
- Budget: `ownerCharacters` 28,000 → 60,000 and `ownerTurnsPerSession` 40 → 60. The pack's byte bound (160,000) and the prompt bound are unchanged; the first run of a project is the heaviest, and later runs add only what is new since the previous ledger.
- Prompt: the OWNER TURNS section says pasted prompts were left out and that `pastedBriefs` counts them.
- README: states that `main` is now the source of the hosted version.

## Checks

`tests/local-briefing-evidence.test.mjs` gains a case covering the three pasted shapes, five owner-style messages that must not match, and a session reduced to a pasted brief being skipped while the owner's follow-ups stay. Companion suite, typecheck, lint and the briefing app tests: see the pull request. No real briefing was produced here; the effect on Trade Graph (all 23 sessions read) is the owner's next refresh to confirm.
