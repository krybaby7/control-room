# Task context audit

L3 audit, 22 October 2026. Scope: task title renderers in existing components, including dynamic title helpers and proposals. The shared `TaskContext` renders `Project / Area / Work type`, resolves area IDs only within the task's project, and uses `Unclassified / Other` for legacy defaults. Titles never supply classification. Equal project priority and task priority defaults are unchanged.

| Surface | Finding and change |
| --- | --- |
| `ui.tsx` TaskRow | Already shared context; existing accessible edit label includes full context. Narrowed TaskContext's input type to its three required classification fields for safe proposal reuse. |
| `task-editor.tsx` | Archived detail already covered. Added current draft summary and prerequisite choice context. |
| `capture-editors.tsx` ConvertEditor | Classification choices already explicit. Added shared summary of the current conversion draft; capture prose does not classify work. |
| `task-bulk-actions.tsx` | Added context to selection titles, accessible selection labels, open buttons, and before/after preview. Move preview uses the actual resulting workspace classification. |
| `weekly-planning-view.tsx` | Added context to selection titles/inspect labels and linked task buttons. Frozen commitment/completion rows lack stored area/work type, so display Unclassified/Other with an explicit historical-classification-not-recorded note; never borrow current task classification. |
| `mission-control-panels.tsx` | Added context to project tile next action and weekly shortlist. ProjectTile now receives the existing workspace. |
| `milestone-workspace.tsx` | Added context to linked task rows and direct prerequisite buttons. |
| `next-up-panel.tsx` | Recommendations already use TaskRow. Added context to the task-by-task absence diagnostics. |
| `task-graph-view.tsx` | Added context to root/visible/remaining-table node title helper and direct task links. Looks up actual task IDs; graph labels do not infer area. |
| `recurrence-removal.tsx` | Added archived task context to the review and accessible section label. Workspace is required; weekly call sites pass it. |
| `project-baseline.tsx` | Added context to proposals. Existing saved tasks use their actual current project/area/work type; new proposals retain explicit null/Other defaults. |
| `github-repository-onboarding.tsx` | Added context to report suggestions using the explicit selected/saved project. Suggestions stay Unclassified/Other regardless of prose. Unsaved new project identity remains Unknown project until saved. |
| `history-roadmap-editor.tsx` | Added context to linked task choices; workspace is supplied by Home's editor wiring. |
| Mission log / historical activity prose | Saved activity text has no stable task reference. Preserved as dated prose with its recorded project label; do not guess task identity or classification from that text. |
| `project-lanes.tsx` | Already uses TaskContext next to expanded task titles. No edit required. |
| `project-lanes-home.tsx` and `control-center.tsx` | Integrator-owned. Required ProjectTile/roadmap workspace prop wiring coordinated with root. |
| `search-view.tsx` | Integrator added TaskContext using the actual task ID in the same workspace, plus saved project/area/work type in the planning search haystack. Actual rendering and distinct all-token Android testing/Planning vs Map/Review tests cover this integration; matching prose leaves legacy classification Unclassified/Other. |

Verification: actual React server rendering of shared context, bulk/weekly/milestone lists, task detail and prerequisites, roadmap choices, capture conversion, next-up diagnostics, archived occurrence review, baseline/GitHub proposals, dependency graph, and existing mission control panels. Synthetic labels cover TAMENNI / Android testing / Testing, TAMENNI / Planning / Planning, TAMENNI / Map / Review, and legacy Unclassified / Other. Foreign-project area IDs do not resolve. No browser interaction or live owner-data verification is claimed.

## Explicit owner completion proof (read-only recommendation)

`overview.ts` currently denies all task completion trust. The existing command is `task.update` with an explicit `patch.status = done` (there is no `task.status` command). Its owner audit records whole task before/after values at `['tasks', taskId]`; `audit_events.workspace_revision` can be joined to the native owner's `workspace_mutations.revision`. Imported audit rows instead become `imported-history` / `historical-claim` envelopes, so their nested origin/actor claims must never be treated as native proof.

A conservative native verifier should require the authenticated owner, current task status done, an actual native owner task update completion transition, matching task ID and completion timestamp, a matching native command receipt/revision, and valid audit payload/physical columns. Reject connector/system/imported events and restore-only transitions. Fence proof after the latest recovery/import replacement or execution epoch change; otherwise a restored legacy done row could accidentally match an older native completion timestamp. Later reopening invalidates completion until another explicit owner completion. If receipt retention removed the required proof, return unaccepted/unknown rather than guessing. A durable private completion grant minted only by the shared owner command compiler would avoid receipt-pruning ambiguity, but must remain nonportable and be cleared/fenced on recovery. No trust implementation or authority grant was added by this UI task.
