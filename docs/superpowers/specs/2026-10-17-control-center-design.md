# Project Control Center — approved first release

The owner approved this scope on 17 October 2026: project clarity, next actions, priorities, milestones, deadlines and task management first; agent coordination later. TAMENNI and Trade Graph have equal priority. The private application must remain usable from a phone or tablet while the PC is off.

## Product model

Projects contain outcomes represented by milestones, then actionable tasks. TAMENNI covers Android reliability, accepted map coverage, lab-to-app integration, scaling readiness and business economics. Trade Graph first establishes coherent end-to-end operation, then evaluates profitability after trading and operating costs. Recorded implementation progress never constitutes a profitability claim or a release acceptance claim.

Today shows equally visible project cards, explained next-action suggestions, weekly commitments and pending reviews. Projects provides milestone editing, acceptance criteria, task planning, Now/Next/Later, target dates and simple dependency links. Capture accepts an idea, task suggestion or decision plus optional source URL. Captures can be filed, archived or converted to a task without losing their text and source. Project goals and all milestones/tasks are editable. Archive is reversible.

No artificial completion percentages, deadlines, runtime activity or GitHub connection indicators. Initial evidence is explicitly an inspected 17 October 2026 snapshot. Suggestions derived from the owner's goals start as proposed; weekly commitments are owner-selected. Equal priority is reflected by fair visibility and interleaved recommendations, not a rigid allocation of hours.

## Architecture and data

A private Sites-hosted Vinext/React application uses dispatch-owned ChatGPT sign-in and Cloudflare D1. A workspace document belongs to the stable authenticated user ID. All writes require identity, same-origin JSON requests and validated domain commands. D1 stores a monotonically increasing revision; compare-and-swap prevents a phone from silently overwriting a newer PC edit. Conflicts refresh the authoritative data while keeping the draft open for retry. Failed writes leave the draft intact and show an error. Reads never fabricate saved state.

Domain logic, seed content, persistence, API and UI are separate modules. This personal workspace uses one bounded JSON document to make dependency validation and capture conversion atomic. A JSON export provides a portable user backup. No runtime secrets or local absolute paths are exposed as remote evidence links.

## Sources and release boundary

First release is the complete remote planning workflow populated with editable goals and dated source references. Sources use GitHub URLs or pasted excerpts so they can be read remotely. Automated GitHub/document imports and the PC collector are the next integration milestone and are visibly disconnected. They do not gate use of planning. Agent execution, trading controls, automatic whole-chat ingestion and two-way external tracker writes are outside this release.

## Acceptance

- Signed-in data persists across reloads and independent sessions; missing identity cannot read or mutate it.
- Tasks and milestones can be created and edited; dates and priorities saved; task status and weekly commitments changed; archived tasks restored.
- Invalid, foreign, cyclic or self dependencies are rejected. Blocked work is explained and excluded from ready recommendations.
- Completion is owner-recorded; achieved milestones require acceptance evidence.
- Captures can become tasks atomically and only once, preserving the source.
- Concurrent edits return a visible conflict rather than overwriting.
- Today and Projects work at desktop, tablet and narrow phone widths, including forms and keyboard navigation.
- Tests exercise dependency logic, fair ranking, validation, capture conversion and persistence/authentication flows. Production build passes, browser flows are checked, and private deployment is confirmed before handoff.

## Delivery sequence

1. Build and verify the planning foundation in this dedicated project directory.
2. Package exact source and publish privately with durable online storage.
3. Next release: explicit read-only source connections and PC freshness, after validating this workflow with real use.
