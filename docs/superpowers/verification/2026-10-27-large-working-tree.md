# Large working tree briefing fix — 2026-10-27

The first real two-folder briefing (TAMENNI app and map lab, version 27) did not complete. The owner's PC agent found two causes:

- An outdated companion from 21 October, which predates briefings, was still running beside the version 27 companion and claimed the request. With no receipt written, the request expired as `deadline_exceeded` after the 10-minute claim window. The agent stopped it; only the version 27 companion now runs and starts with Windows.
- Evidence collection alone, with no model call, failed for the TAMENNI folder with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`: a git listing of its working tree exceeded the 4 MiB output bound. The map lab folder collected in 13.4 seconds (24 branches, 77 commits, 1 chat, 1 owner-turn session).

The failing listing belongs to the bounded source reader (`snapshotRepository`). A briefing uses it only to fingerprint uncommitted content for change detection; its contents never enter the evidence bundle. Any failure of that reader therefore aborted the whole briefing.

## Change

When a folder has uncommitted changes and the source reader fails for any reason other than cancellation, the briefing keeps a coarser fingerprint: a digest of the folder's `git status` entries and `git diff --shortstat` counts. The briefing proceeds with the same evidence as before. Cancellation still stops collection. Keep-current change detection stays correct for added, removed or newly changed files and changed line counts. It can miss an edit to an already-modified file whose line counts stay identical, until the folder becomes small enough for the full reader again.

## Checks

- `tests/local-briefing-evidence.test.mjs` adds a case in which the source reader fails with the same `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` error. Folder and project evidence still collect with correct uncommitted counts, the evidence validates, the fingerprint changes when a tracked file changes, and cancellation still rejects. With only the fallback removed, the case fails with `RangeError: stdout maxBuffer length exceeded`.
- `npm run test:companion`: 159 tests, 157 passed, 0 failed, 2 skipped. Typecheck and lint passed.

A real TAMENNI briefing on the owner's PC after deployment remains the acceptance check. Paid inference and trading effects remain disabled.
