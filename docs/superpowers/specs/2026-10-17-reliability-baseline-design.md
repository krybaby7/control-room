# Control Room reliability and current baseline

The owner approved the audit recommendations on 17 October 2026 and requested reliability fixes first, followed by a current TAMENNI/Trade Graph baseline. GPT-6.1 Sol agents implement; the parent coordinates design, integration, review, and private Sites publication. The prior audit supplies the approved design; no additional approval gate is needed for these bounded repairs.

## Reliability release

Preserve the current interface and owner-private deployment. Keep the document-oriented D1 architecture. Add a versioned workspace migration and validation contract before modifying historical data. Existing content is never reseeded or discarded.

- Preserve completedAt and original status during task archive/restore. Archived completed prerequisites remain fulfilled. Reopening is explicit and still respects dependent completion guards.
- Use a stable mutationId per unchanged submission with a durable owner-scoped receipt. Repeating an acknowledged or uncertain submission returns its prior success without executing it again; reusing an ID for different content is rejected. Commit the receipt, workspace write, and any recovery snapshot atomically. A genuine revision conflict retains the draft and allows an explicit retry.
- Keep the existing weekly input but persist a Cairo calendar week identifier on tasks. Use Monday-start weeks, show the date range, count only this week's completions, and expose unfinished prior-week commitments for explicit carry-forward. Migration assigns legacy pins to the last saved week rather than silently renewing them.
- Handle 401 explicitly, remove protected rendered state, and present a sign-in path. On ordinary refresh failure retain the last saved workspace with a visible stale/error indication. Distinguish last save from last successful refresh. Do not store private drafts in persistent browser storage.
- Darken informational body text, task explanations, acceptance text, and hints to at least 4.5:1 contrast while preserving the current visual style.
- Add JSON restore with strict validation, a preview of project/task/milestone/capture counts, an explicit final restore action, revision protection, and an automatically retained pre-restore snapshot available to export. Test restoration on local isolated data only.
- Keep diagnostics sanitized but classify failures and include a request identifier. Existing size/count bounds remain; show usage and explain that archive does not remove stored records.

## Baseline release

Research the three repositories and relevant existing project decisions read-only. Preserve equal priority. Record observed source SHA, URL, date, status, verified accomplishments, blockers/unknowns, and proposed actionable work mapped to existing milestones. Do not convert implementation evidence into release acceptance or profitability. Do not operate trading services, use paid model calls, or edit the underlying project repositories.

Display the dated baseline in project pages and provide an idempotent additive application to an existing workspace. Preserve all existing edits, goals, task statuses, dates, and commitments. Add only evidence-backed proposed tasks and source context. Do not reset the workspace through seed changes. The exact baseline content is reviewed after research, before publication and application.

## Verification and delivery

Meaningful regression tests precede bug fixes. Verify legacy migration, archive history, duplicate retries, conflicting writes, week rollover, schema rejection, owner isolation, and restore recovery using real SQLite where appropriate. Run all tests, typecheck, and production build. Browser-check local flows including save failure, conflict, restore, session expiry handling, and responsive forms. Obtain independent review. Publish exact packaged source through Sites with new migrations appended and private audience unchanged. Apply the reviewed baseline through the app's normal authenticated workflow, then confirm saved state without inventing acceptance.
