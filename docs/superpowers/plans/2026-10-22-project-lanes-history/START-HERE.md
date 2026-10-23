# Implement Project Lanes with GPT-6.1 Sol

This package implements the selected Project lanes direction and all five history/progress requirements. It is an implementation plan, not a completed integration. No collector, background synchronization or paid inference was enabled while writing it.

Open the `project-control-center` repository in a **GPT-6.1 Sol** agent and paste the prompt below. A cloud worker can build and test the app, but local-history and Windows collector verification must run on an enrolled machine with the actual retained history. Do not upload private chat exports into the public source repository.

If using another checkout, copy this entire plan directory into the same repository-relative location first. It also needs the existing repository instructions, source provenance and October 18 plan documents referenced by the master plan. The prompt's model name does not select the agent; choose GPT-6.1 Sol in the app/runtime settings as well.

## Copy-ready launch prompt

```text
Implement the approved Control Room Project lanes and conversation history plan in this repository.

Read AGENTS.md and docs/source-import.json, then read:
docs/superpowers/plans/2026-10-22-project-lanes-history/00-master-plan.md
docs/superpowers/plans/2026-10-22-project-lanes-history/progress.json
and all five numbered implementation chapters in that directory.
Read the older October 18 documents required by AGENTS.md for constraints and reusable contracts. This new package is the current scope: do not require all eight older phases before implementing it, and do not assume planned modules already exist.

The approved interface is Project lanes as the default home: all projects, stable areas, visual checkpoint progress, pending owner actions, and expandable Finished / Still open / Next. Every task needs area and work type as well as its existing project/status/priority. Claude cloud means Claude Code web/cloud sessions, not ordinary Claude.ai or Cowork.

Implement all five requirements: import available history; automatically collect changes with catch-up; reconcile a continuing story across chats; distinguish observed progress from owner acceptance; show measurable coverage, freshness and gaps for all four local/cloud source classes.

Use exactly gpt-6.1-sol for implementation and review workers through the supported runtime model parameter; record the accepted request and worker ID. Keep one integrator and disjoint worker files. Complete S0/S1 and freeze all shared contracts before parallel feature work. If that exact model cannot be selected, report the limitation instead of silently substituting.

Start by inspecting actual git state and preserving existing edits/data. Work on an implementation branch. Follow the plan's checkbox tasks, meaningful tests and reviewable commits. Use Node 24 and npm run install:ci, then the repository checks. Update progress.json after each task with evidence, files, commit, blockers and next action so another Sol agent can resume safely.

Continue through implementation and verification instead of stopping after another plan. Continue independent work around unavailable providers. A cloud capability is verified only when a supported reader proves the correct account/scope, complete available pagination and a subsequent unattended update; fixtures, desktop-only tools, empty CLI task lists and manual imports are insufficient. Do not run Claude teleport/resume or send messages into source chats as a background collection mechanism.

Preserve the existing private Site and owner record IDs. Keep transcripts/credentials out of public git. Retain explicit owner control of task completion, checkpoint acceptance and commitments. Build runtime inference configuration and its budget checks, but do not activate a new paid provider/model without authorized scope and budget. Product inference choice is separate from the implementation-agent model.

Deliver the tested implementation, a draft PR when write access is available, and a concise coverage/release report with every outstanding live gate. Do not auto-merge. Use supported private Sites publication within authorized scope; if the runtime cannot publish, deliver the concrete publication handoff. Never label unavailable cloud coverage or untested device behavior complete.
```

## Execution order

| Stage | Read / execute | Deliverable |
|---|---|---|
| S0 | F1 | Verified baseline and four-source capability inventory |
| S1 | F2–F6, C1 contract freeze and Chapter 4 additive contracts | Stable areas, shared storage/export, roadmap and acceptance contracts |
| S2 | C2–C5 | Full retained-history readers and explicit cloud capability results |
| S3 | A1–A6 | Durable incremental sync, catch-up and unattended collector |
| S4 | U1–U6 | Continuing area stories, pending work and evidence-based progress |
| S5 | L1–L4 | Simple lanes, task context and compact coverage controls |
| S6 | R1–R3 | End-to-end checks, live gate ledger and private release handoff |

After S1, reader, synchronization, synthesis and UI workers can proceed against frozen fixtures in parallel. Integration and live verification remain dependent on actual services. `progress.json` starts with every implementation task unstarted; planning work must not be mistaken for completed code.

## Resume prompt

```text
Continue the Project lanes/history implementation from
docs/superpowers/plans/2026-10-22-project-lanes-history/progress.json.
Read AGENTS.md, the new master plan, the last completed evidence and actual git diff.
Use GPT-6.1 Sol. Verify the checkpoint against the current code and resume its next action.
Preserve unrelated work and do not repeat completed work or claim open live gates have passed.
```

The most important external uncertainties are unattended Codex cloud access, read-only Claude Code cloud access, supported private Site service ingress/scheduling, and the chosen runtime analysis provider. These are explicit verification tasks, not assumed capabilities. Local imports, the UI and deterministic reconciliation can be implemented while those gates remain open.
