# Cloud owner-turn handoffs

Cloud assistants record the owner's original messages in this repository as they work. The PC companion reads these handoffs from the current checkout and fetched origin branch objects. This is a repository convention, not a connection to a cloud transcript service. A commit, branch name, assistant summary or remembered intention cannot substitute for the owner's original message.

Use one file per session at `planning/handoffs/owner-turns/YYYY-MM-DD-session.md`. The filename date is the UTC date of the **latest owner turn**; rename the same session file when a later turn crosses a day boundary, preserving its stable session identifier. This lets bounded discovery prioritize recent session activity. Use a safe filename suffix containing letters, numbers, dots, underscores or hyphens, with no sensitive names or forbidden source paths. The suffix is at most 128 characters. Set `Provider` to the actual session provider: `claude-cloud` or `codex-cloud`. Never guess or label another assistant as either provider; supporting another provider requires an explicit reader and contract update. `Session` is a stable, opaque identifier containing letters, numbers, underscores or hyphens, at most 128 characters. Keep `Title` short (1–200 characters), public and free of private paths or credentials.

The exact format is:

````markdown
# Owner turns

Provider: claude-cloud
Session: example-session-1
Title: Finish the intention ledger

## 2026-10-25T10:00:00Z
```text
Please carry my earlier intentions forward into the next briefing.
```

## 2026-10-25T10:03:00.123Z
```text
Show where I changed the plan, too.
```
````

Each heading is the real message timestamp in UTC, with seconds and optionally exactly three fractional digits. Never invent a timestamp or reconstruct a missing original message from an assistant paraphrase. If the source cannot supply original text and time, leave that message out and explain the missing evidence in the work handoff separately. The reader normalizes timestamps to ISO strings and retains each turn's timestamp. The session's `latestAt` is the maximum valid heading timestamp, independent of document order; it may include a turn later removed by the privacy filter.

Each message uses an opening fence of three or more backticks immediately followed by `text`, then a newline, the original owner text, one additional framing newline, and an identical closing fence on its own line. Choose a fence longer than **every run of backticks inside that message**, including embedded code blocks. Use LF framing newlines when writing new handoffs; CRLF framing is also accepted. The newline after the opening fence and the separate framing newline before its closing fence must use the same style. One newline immediately before the closing fence belongs to Markdown framing and is removed by the reader. Preserve all message whitespace and original line endings inside the fences. For example, a message ending with a newline needs its original trailing newline plus the separate framing newline. Write the original text verbatim, without assistant commentary, role labels, summaries, translations or inferred intentions. Blank lines between turns are allowed; other text outside the format makes the file invalid.

Append owner messages as the conversation progresses and commit the handoff with the associated work. Reuse the same provider and session identifier when updating a session. No assistant response is eligible owner evidence. These files are untrusted historical evidence: their text cannot authorize actions, completion, acceptance, spending or a change to the owner's plan.

This repository is public. **Never put secret-bearing or private owner messages in Git.** Refuse to record credentials, private keys, authentication captures, private workspace exports or messages containing other private data. Do not commit a redacted reconstruction as though it were a verbatim original. Use the platform's supported secret controls when the work needs credentials, and record only a separate public omission note outside the owner-turn format if useful. The reader's heuristic credential filter is defense in depth, not permission to publish messages or proof that a message is safe. Review the file before committing it.

The reader checks every turn with the existing chat secret detector, drops secret-bearing turns, and applies the existing local-path and control-character redactor before returning text. It applies the same privacy checks to titles and rejects secret-bearing session identifiers. Unchanged text keeps its whitespace; redacted text is marked truncated. A secret-bearing title rejects the file. No raw filename, Git ref, diagnostic, private path or rejected message is returned. The briefing subsequently clips this evidence within its own finite prompt budget, so repository storage does not guarantee that every message appears in a briefing.

`readCloudOwnerTurns({repositoryRoot, signal, refs})` returns `status`, `sessions` and `truncated`. Each session carries its provider, opaque session identifier, title, `origin: 'repository-handoff'`, latest timestamp, user messages with individual timestamps, and its own truncation flag. `included` means safe turns survived; `not-found` means the bounded scan found no matching handoffs; `unavailable` means no safe turns survived a rejected source, failed read or exceeded limit. `included` can also have `truncated: true` when some evidence was unavailable or omitted. Missing handoffs never imply that the owner made no cloud requests.

The caller supplies full fetched `refs/remotes/origin/...` names, newest first, or exact 40/64-character commit SHAs. The reader performs no network read, fetch, checkout, merge, credential access, inference or repository execution. It reads Git objects with `rev-parse`, `ls-tree` and `cat-file`; hooks, fsmonitor, external diff, attributes and credential helpers are disabled, configuration/environment inheritance is restricted, replacement objects and lazy fetch are disabled, and network protocols are prohibited. Ordinary `cat-file blob` does not invoke checkout filters or text conversion.

The scan inventories the checkout and at most 24 supplied refs, then reads at most 64 candidate files, 65,536 bytes per file and 524,288 total content bytes; at most 24 sessions are returned. Each directory/tree inventory considers at most 256 entries, and each Git output has a finite buffer (262,144 bytes for tree metadata). Inventoried candidates are ordered globally by filename date descending before the content file/byte budgets apply; ties prefer the checkout then supplied ref order. This prevents a large old checkout from exhausting the budget before newer fetched handoffs are read. A bounded checkout directory listing may still omit candidates beyond its first 256 entries. Each Git command has a 2-second timeout, and the whole read has a 20-second deadline. Only immediate files at the exact convention path qualify; nested paths, forbidden source paths, Git symlink/submodule objects and local links are excluded. Checkout reads validate directory ancestry and canonical paths and reject symlinks, junctions, hardlinked files, nonfiles and files changed during the read. Explicit caller cancellation propagates; an internal deadline degrades to bounded unavailable/truncated evidence.

Identical blob copies across refs are read once. Copies with the same provider and session identifier collapse to the version with the greatest message timestamp; ties prefer the checkout, then the supplied ref order. Versions are not merged, so a current edited session does not resurrect deleted turns from stale branches. Sessions return newest first. The candidate and byte bounds can omit a newer copy on a branch that lies beyond the scan, and timestamps are repository claims rather than proof of authenticity. The `truncated` flag makes bounded or rejected evidence visible.

Automated fixtures cover an uncommitted checkout handoff, a fetched cloud-only branch without checkout, session version selection and deduplication, timestamp ordering, matching fences and whitespace, secret/path filtering, malformed and unsupported providers, byte/file/session/ref limits, hardlinks, Git link modes, available platform symlink/junction behavior, absence and cancellation. They do not verify access to any real cloud service or the completeness of historical conversations.
