# Simple folders verification — 2026-10-27

This increment makes folder ownership visible on project pages and on Repositories → This PC. It is local source work on `feat/simple-folders`, starting at `23e9ed3`. No push, pull request, merge, deployment, installed-companion update, owner-data mutation or real assistant run was performed.

## Source and coordination

Read `AGENTS.md`, `README.md`, the completion bootstrap/master/gap/checkpoint/provenance documents, and the requested multi-folder and early-workspace-read verification notes. Node is **24.14.1**. The runtime accepted explicit `model: gpt-6.1-sol` requests and returned `/root/folders_integrator`, `/root/repositories_ui` and `/root/owner_flow_tests`. One integrator owned shared helpers and central UI wiring; leaf workers owned Repositories and browser specs. Workers also reviewed production code they did not author.

`npm run install:ci` was attempted but failed with `spawn EPERM` in the installer child process. Checks used the existing dependency tree. `package-lock.json`, server and shared briefing/personal-channel contracts, companion source and `.openai/hosting.json` remain unchanged.

Git staging and committing were attempted and failed because the backing worktree index is outside this checkout's writable boundary (`index.lock`: permission denied). No Git storage was moved or modified to bypass that boundary. There are **no new commits**; the implementation is left as reviewable working-tree changes for the integrator.

The session provides original owner text without original message timestamps. No timestamped verbatim owner-turn handoff was invented. This missing evidence is disclosed here rather than substituting a current clock reading or assistant summary.

## What changed

- Project pages show folder names, reversible removal, immediate attachment of an unowned PC folder, and native browsing through the existing request-recovery path. The bounded picker compares the before/after folder lists, attaches only one new folder after the original request finishes, and refuses ambiguous results. It rechecks current ownership, project identity, archive status and the four-folder limit before saving.
- Project briefings use the existing `briefingRequest` and `sendPersonalAction` clients. The browser supplies only the request identity, project, one folder and assistant; project framing and complete membership stay server projected. Assistant choice follows existing project policy, otherwise the latest project briefing request, otherwise its latest saved briefing. The optional bounded saved-briefing read does not block folder actions and cannot overwrite a fresh owner choice. Archived projects retain readable folder names and restore guidance.
- Repositories defaults to This PC and shows folder ownership as project links, an unassigned-folder chooser, or archived-project guidance. It no longer offers a briefing button. Technical analysis, saved reports and completed-analysis recovery remain in one closed fold. Saved-report loading starts when that fold opens; folder actions do not depend on that read.
- Shared pure helpers supply visible disabled reasons with `aria-describedby`. Today opens the project's Folders section and retains explicit briefing requests. Request and completed-save recovery preserve original identities and commands; an uncertain project-creation response closes the dialog so the existing original-save recovery remains reachable.
- Projects and Repositories remain deferred. The dashboard feed remains dynamically imported by project folders. Today loads the reason helper in a passive effect and passes it to its controls, with loading/failure guidance until it is available. An emitted-JavaScript AST regression verifies that the new folder helpers add no static import to the shell or Today. Build-manifest and controlled browser performance verification remain blocked locally; no performance threshold was changed.

## Checks

Final integrated source checks:

- `npm.cmd run typecheck`: **passed**, exit 0. Two errors caught in the first integrated run were fixed: a nullable controller reference and a test using an invalid connector-state literal.
- Affected Node tests with `--experimental-test-isolation=none`: **121 passed, 0 failed, 0 cancelled, 0 skipped**, 4,951.248 ms. The exact command is below. Earlier focused counts overlap this run and are not added to it.
- `npm.cmd run lint`: **passed**, exit 0, **0 errors and 15 existing warnings**. Earlier runs caught a new test declaration and the guarded Today link; those were corrected. The link uses a narrow lint suppression to preserve the shell's existing guarded navigation and avoid introducing a prefetching link import.
- `git diff --check`: **passed**. Explicit UTF-8 checks found no introduced BOM, replacement characters or mojibake in the changed UI/helpers/tests.
- `npx.cmd playwright test tests/e2e/project-framing.spec.ts tests/e2e/personal-repository-connection.spec.ts --list`: **passed**, discovers **12 tests** in two files.
- The same Playwright command without `--list`: **blocked**, exit 1, `Error: spawn EPERM`, before any browser assertion ran.
- `node --experimental-strip-types --test` on the five new/affected helper/render test files: **blocked**, five file-worker launch failures with `spawn EPERM`; no test assertion executed. The supplemental in-process run above passed the actual cases.
- `npm.cmd run build`: **blocked**, exit 1, six Vite configuration-resolution errors caused by `spawn EPERM`. Its prebuild successfully generated the unchanged 32-file companion package (258,335 bytes).
- `npm.cmd run install:ci`: **blocked**, exit 1, installer child-process `spawn EPERM`.

```text
node --experimental-strip-types --test --experimental-test-isolation=none tests/project-action-reasons.test.ts tests/project-assistant-preference.test.ts tests/project-folder-picker.test.ts tests/project-folder-briefing-client.test.ts tests/project-folders-render.test.ts tests/personal-repository-render.test.ts tests/mission-control-render.test.ts tests/project-framing-workspace.test.ts tests/personal-repository-destination.test.ts tests/personal-repository-request-recovery.test.ts tests/personal-completed-save-recovery.test.ts tests/personal-repository-rejection.test.ts tests/personal-repository-multi-folder.test.ts tests/project-briefing-contract.test.ts tests/project-briefing.test.ts tests/personal-repository-presence.test.ts tests/workspace-boot-read.test.ts tests/dashboard-feed.test.ts
```

Browser coverage retains framing/reload, no inference without an owner click, uncertain-save recovery without duplicate creation, archived binding guidance and reopened names. New journeys add a PC folder on its project page, remove it, see it unassigned on Repositories and reattach it; inspect visible accessible offline reasons; and hold the saved-report response open while folder assignment remains usable. They are authored and discovered, **not browser-verified locally**.

## Files changed

- UI: `components/briefing-card.tsx`, `components/control-center.tsx`, `components/mission-control-panels.tsx`, `components/mission-control.tsx`, `components/personal-repository-onboarding.tsx`, `components/project-folders.tsx`, `components/projects-view.tsx`, `components/repository-onboarding.tsx`.
- Helpers: `lib/project-action-reasons.ts`, `lib/project-assistant-preference.ts`, `lib/project-folder-picker.ts`.
- Tests: `tests/e2e/personal-repository-connection.spec.ts`, `tests/e2e/project-framing.spec.ts`, `tests/helpers/render-client.ts`, `tests/mission-control-render.test.ts`, `tests/personal-repository-render.test.ts`, `tests/project-action-reasons.test.ts`, `tests/project-assistant-preference.test.ts`, `tests/project-folder-briefing-client.test.ts`, `tests/project-folder-picker.test.ts`, `tests/project-folders-render.test.ts`.
- Documentation/checkpoints: this note, `docs/superpowers/plans/2026-10-27-simple-folders.md`, `docs/superpowers/plans/2026-10-18-control-room-completion/09-gap-coverage.md`, and `docs/superpowers/plans/2026-10-18-control-room-completion/progress.json`.

The actual This PC/Codex Cloud tab wrapper is `repository-onboarding.tsx`; it was updated there. The legacy `local-repository-onboarding.tsx` remains unchanged. Today’s Add folder is navigation and stays available at four folders so the owner can inspect and remove folders; mutation limits are enforced on the project page. These are implementation-location/interaction choices within the requested behavior. The unavoidable workflow deviations are blocked commits, dependency installation and subprocess-based checks, plus the omitted handoff turns without original timestamps.

## Local limits and handoff

The default Node test runner cannot spawn file workers (`spawn EPERM`). Supplemental affected tests use `--experimental-test-isolation=none`, retaining their assertions, budgets and timeouts. Touched render checks compile the actual client modules in process with TypeScript, avoiding an esbuild child process.

`npm run build` was attempted: deterministic companion packaging succeeded, then Vite configuration resolution failed with `spawn EPERM`. Playwright test discovery succeeds; executing the affected specs fails with `spawn EPERM` before a browser test runs. These are blocked checks, not passes. The full `npm test`, Linux native checks, complete browser suite and controlled HTTP/1.1 performance gate were not run here and remain the merge gate. No physical folder dialog, live provider, private hosted session or device integration is claimed.

The integrator must commit the working-tree changes, run the full Linux gates, review the browser journeys and open the pull request. Publication remains outside this task.
