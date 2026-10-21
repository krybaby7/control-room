# GitHub repository onboarding with subscription cloud handoff

The owner approved the subscription-only Codex Cloud handoff on 21 October 2026, alongside the existing PC analysis option. No separately billed API provider is enabled.

## Owner workflow

AI project analysis offers **Codex Cloud** and **This PC**. Cloud mode accepts a GitHub repository URL or a repository already linked to an owner project. It prepares a bounded read-only analysis prompt, with a unique request ID, and offers copy/download plus a normal link to Codex Cloud. The owner connects GitHub there if prompted, selects the repository/environment and exact model, and starts the task. The PC may be off. The owner returns the downloadable JSON report to Control Room, previews it and explicitly saves it to an existing project or a new named project. Suggested tasks require separate review.

GitHub account authorization and live repository selection happen in Codex Cloud. The Site does not claim its own connected GitHub account, live repository browser, automatic cloud task launch or automatic result collection. Sites connector eligibility discovery is unavailable in this environment. A typed repository URL is a selection, not evidence of provider access. The existing paired local helper remains intact.

## Report and handoff contract

A separate `control-room-github-analysis` version 1 format carries canonical HTTPS `github.com/owner/repo` identity, full commit SHA, cloud request UUID, requested/observed model metadata, times, a bounded file manifest, summary, architecture, exact path/line/hash findings, suggestions and limitations. Source is `codex-cloud-handoff`, mode is `read-only`, provider is `codex`, and requested model is `gpt-6.1-sol`. Unknown observed model stays null. The report is an uploaded claim; schema validation does not prove execution, authorship, file bytes or factual correctness.

Reuse the existing report-content contract while preserving all local report bytes and provenance. Reject unknown fields, invalid/ambiguous repository URLs, unsafe paths, duplicate manifest entries, invalid times, citations outside the manifest, incorrect hash/line references, reports over 9,600 serialized characters or 55 KB UTF-8. At most 40 manifest entries are allowed. No account credentials, source excerpts, transcripts, local paths or working-folder change claims belong in the cloud envelope.

The prompt treats repository content as data. It requests bounded committed source reads at a pinned HEAD, omits secrets/dependencies/generated files/agent instruction files/symlinks, prohibits installs/tests/source changes or extra inference, and asks for a downloadable JSON artifact outside the repository plus plain JSON fallback. It cannot enforce the cloud executor's permissions; the owner must select the stated runtime/model and review the result.

## Persistence and recovery

`github-analysis.save` uses the ordinary authenticated owner-scoped transaction, receipts, revision checks and audit path. An existing project ID or a new project name selects the destination. New project creation, canonical repository linking, immutable evidence version and project context link commit together. No migration is needed. Existing project goals, tasks and IDs are preserved.

Canonical repository identity prevents case/`.git` URL variants from silently creating duplicate active projects. Refresh requires the current evidence ID/version, same repository and same owner project. Historical run UUIDs cannot be reused with new content, including after archive. Receipt replay of the original command remains safe. Evidence export/recovery already carries report statements and links. Saved reports can be read after reload without model calls.

An unsuccessful or uncertain save retains the report and original command/submission for reconciliation. Preparing a handoff does not create a project or launch inference. Changing execution mode must not discard an imported unsaved report. Session expiry, loading failure and timeout have distinct visible states.

## Acceptance

Meaningful contract tests exercise malformed inputs and bound citations. SQLite tests cover atomic new-project/evidence rollback, receipt replay, owner isolation, active project/repository identity, immutable refresh and export. Client tests cover bounded authenticated reads and failure classification. Browser QA checks both mode choices, prompt preparation, report review/save/reload using isolated synthetic data, and unchanged local analysis UI. Hosted acceptance checks the visible handoff without manufacturing a real cloud task or owner report. Paid inference remains disabled. A real subscription cloud task/result is reported separately if not observed.
