# Local repository onboarding

The owner approved this design on 21 October 2026: add a local repository through a paired PC helper, automatically run read-only GPT-6.1 Sol analysis, retain a private cited project briefing, and offer suggestions for explicit review. Refresh is owner initiated. This release does not introduce a watcher or accepted planning changes from model output.

## Flow

The helper registers folders locally, binds only to loopback, and shows a short-lived pairing code on its local page. The private Site pairs with that helper and lists registered repository aliases. Absolute folder paths and provider authentication stay local. Selecting **Add and analyze** creates an owner project when needed and starts one finite analysis of a filtered snapshot of the current working folder. This includes eligible modified and untracked source, with exclusions and scope recorded.

The model receives bounded source excerpts, a file map and exact hashes. Model tools are disabled for this briefing-only workflow. It returns summary, architecture, cited findings, suggested tasks and limitations. The helper validates citations against its snapshot and retains the completed report. The browser saves it through the ordinary authenticated same-origin workspace command, preserving revisions, receipts and uncertain-save reconciliation. Saving again must not run the model again.

Reports are versioned contextual evidence linked to their project. Existing evidence export, recovery and history retain them. They are labelled local model reports; their existence does not establish authenticated agent execution, test results or correctness. No schema migration is necessary. The earlier strict agent executor remains a separate workflow.

## Boundaries

Use the installed Codex CLI and existing ChatGPT authentication. Exact model is `gpt-6.1-sol`; no API keys, fallback model, quota purchase or automatic provider retry. One active run, a finite timeout and bounded output. Repository scripts and tests are not executed. Exclude credential files, symlinks, dependency/generated trees and inherited agent instructions. Preserve original bytes and Git status. Do not upload source snapshots to Control Room; save only report metadata and cited claims.

The helper accepts operative requests only with a high-entropy expiring code, exact Host and exact allowed Origin. Browser CORS does not replace authentication. Registration of another filesystem root requires a local action. No arbitrary command, executable, provider URL or remote folder registration endpoint exists.

The owner browser and PC must be available for the normal flow. A browser closed during analysis can reconnect to its locally retained result. Test the actual private Sites-to-loopback connection and browser permission handling before claiming end-to-end operation. If platform/browser policy denies it, leave the feature visibly disconnected and retain local reports; do not disable protections.

The Codex in-app browser's direct Site-to-loopback request timed out before reaching the helper during live acceptance. A local document fallback therefore uses an exact loopback Origin and local CSRF token to start the same registered-repository, one-run execution path. Its status page can refresh without starting another run and download the completed report as JSON. The owner imports that bounded, validated JSON through the private Site's normal evidence save path. Import never invokes a provider, and a reused run identity with changed content must be rejected. Folder paths, credentials and source excerpts are absent from the report file. Direct pairing remains available for browsers that permit the connection; it was not verified in the in-app browser.

## Verification

Meaningful Node tests cover pairing/authentication/origin/host checks, bounded snapshot creation, exclusions, unchanged source files, duplicate request IDs, cancellation and report validation. SQLite tests cover owner/project isolation, immutable versions, stale saves and unchanged planning. Browser checks cover connection, actual private-origin loopback transport, adding a project, running a real finite analysis and reading the saved report after reload. A synthetic provider proves only the named software boundary. Live results must record the actual model request and returned outcome.
