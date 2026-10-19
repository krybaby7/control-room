# Verification — 17 October 2026

The first release is a private planning application. Local browser data is separate from the hosted D1 database; QA records are not seed content.

## Automated behavior checks

`node --experimental-strip-types --test tests/*.test.ts` passed 41 tests. Coverage includes strict input validation, same-project acyclic dependencies, blocked completion, reopening predecessors, milestone evidence, capture conversion and project assignment as one atomic operation, fair recommendations, workspace bounds, owner isolation, seed-once persistence, compare-and-swap writes and changed-field patches for conflict retries. Storage tests use a real in-memory SQLite database.

`node node_modules/typescript/bin/tsc --noEmit` and the Sites production build helper both passed. The five-stage build generated the dynamic application route and workspace API.

## Integrated local browser checks

The Vinext development server used its portable loopback-only mock identity and the generated migration applied to local D1.

- Authenticated workspace read: 200; anonymous read and write: 401.
- Cross-origin mutation: 403; invalid command: 400; stale revision: 409.
- API responses include `Cache-Control: no-store, private`.
- Captured a thought with project, body and source; converted it to a linked proposed task. Body and source persisted.
- Edited status, priority, due date, dependency and weekly commitment; inspected saved values through the API.
- Blocked completion showed an error and retained the form values. Blocked work was excluded from ready suggestions.
- Created a milestone; the achieved state required evidence before saving.
- Created a standalone task, simulated a 503 save failure, verified retained draft, then successfully retried.
- Archived and restored a task through the interface.
- Edited project descriptions and milestones; archived and restored a capture.
- A separate authenticated browser context loaded the same saved revision and task.
- JSON export produced a download named for the current date and saved revision.
- Opened a task at revision 14, changed the same notes and an unrelated priority in another authenticated session to revision 15, then triggered a focus refresh. The stale editor still submitted revision 14 and received 409. The server retained the newer notes; the dialog retained the draft. Explicit retry sent only the edited notes, succeeded, and preserved the other session's priority.
- Converted an unassigned capture with a selected project: exactly one `capture.convert` request and one revision increase, with the project, task and filed link saved together.
- Inspected desktop (1440px), tablet (768px), phone (390px) and narrow phone (320px) layouts. Today, project details, Sources, Inbox and the task dialog had no horizontal overflow. The phone task form saved successfully; account sign-out remained accessible. Keyboard focus entered the modal and Escape closed a clean draft.

## Review and remaining release checks

Independent backend review found no actionable defects. Integrated review identified a draft-revision race and non-atomic project assignment during capture conversion. Both were fixed and covered by browser checks and regression tests. A separate final review of the repairs found no actionable issues.

The local mock-user QA workspace was reset after verification. Hosted initialization will use the approved seed, with no QA records, assumed deadlines or weekly commitments. Publication is tracked by the Sites saved version and deployment record.

Browser checks use Chromium emulation, not physical phone or tablet hardware. Save-error checks deliberately produced HTTP 400, 409 and 503 responses. Automated source synchronization and PC activity remain explicitly disconnected.


## Later completion work

This dated record remains historical. Current completion-source evidence, remaining gates and deployment identity are tracked in [the completion checkpoint](superpowers/plans/2026-10-18-control-room-completion/cloud-interruption-checkpoint.md) and [the gap ledger](superpowers/plans/2026-10-18-control-room-completion/09-gap-coverage.md). Historical mock/viewport checks do not establish a later private deployment or physical-device acceptance.
