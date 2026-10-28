# Private imported cloud chats — 2026-10-28

Work is confined to the supplied `feat/private-imported-chats` checkout, based on `main` `7212310`. No push, merge, deployment, installed companion update, provider call or real private-chat read is authorized or performed. All added fixtures are synthetic.

## Implementation and review coordination

The supported runtime accepted explicit `model: gpt-6.1-sol` requests for implementation workers `/root/reader` and `/root/integration`, and independent reviewer `/root/review`. The integrator owns documentation and checkpoints; workers own non-overlapping reader and integration files. Read the repository instructions, owner-turn format, 25 October cloud-intentions and 27 October companion-protocol verification, startup/master/gap/progress documents and source-import provenance. The supplied task defines the implementation design; no Site, server, prompt, stored-format or protocol change is needed.

## Folder and evidence contract

The default root is `%USERPROFILE%\.control-room\imported-chats` on Windows and `~/.control-room/imported-chats` elsewhere. It deliberately avoids AppData because MSIX can virtualize those writes. The local CLI option `--imported-chats-root` and function option `importedChatsRoot` support isolated overrides; no Site payload controls the path. Imports stay outside repositories and are never committed.

A GitHub `origin` maps each registered folder to `<owner>__<repo>` (for example `krybaby7__tameni-map-lab`), case-insensitively. A missing/non-GitHub origin reads no imported chats; another repository cannot select this directory. Exports follow the `YYYY-MM-DD-<session>.md` naming convention; only direct `.md` files use the existing owner-turn parser and privacy validator. Missing roots/subfolders are silent. Invalid, oversized, linked, out-of-root or unstable entries are skipped and counted locally. The scan retains repository limits or tighter: 256 inventory entries, 64 candidate files, 65,536 bytes per file, 524,288 total content bytes, 24 sessions and a 20-second deadline, with caller cancellation.

After repository branch-version selection, imported sessions join repository sessions per folder, matching provider plus session ID after stripping one leading `session_` or `cse_`. Matching sessions retain distinct `(timestamp, text)` turns in timestamp order. Existing global newest-first selection and character/byte limits still apply. Existing coverage fields count all retained cloud sessions/turns; there is no new imported subtotal or stored contract field. The private location is described only here and in local documentation/diagnostics. Raw bounded filename/size/content hashes enter the local keep-current fingerprint, including edits whose parsed safe evidence is unchanged.

Imported text has no new network route, logging, Site upload or inference call. It enters only the existing bounded model prompt, like local chat text. It remains untrusted evidence and cannot approve execution or change owner records.

## Changed files

- `companion/cloud-owner-turns.mjs`: `readImportedCloudOwnerTurns({repositoryRoot, importedRoot, signal, origin})` reuses the existing parser and hardened filesystem checks. `origin` can reuse the caller's actual parsed GitHub identity; otherwise a hardened local Git configuration read resolves it. The private reader groups matching copies while preserving original IDs; `mergeCloudOwnerSessions` normalizes matching keys once and preserves the winning source ID. Neither reader performs network access.
- `companion/briefing-evidence.mjs`: combines repository/private sessions before owner-turn selection, retains truthful omitted-source status when their combined session limit is exceeded, and incorporates the raw bounded import digest into both collection and change detection. Project collection inherits the same option for every folder.
- `companion/briefing-run.mjs`, `companion/personal-connector.mjs`, `companion/cli.mjs`: carry the local override through single/project collectors, manual/automatic briefing execution and keep-current fingerprint checks. The CLI excludes it from the HTTP companion's options; jobs from the Site cannot choose it. The existing protocol declaration remains unchanged.
- `tests/local-cloud-owner-turns.test.mjs`: synthetic filesystem matching, defaults, privacy, invalid/oversized/non-Markdown/link/escape exclusions, resource bounds, cancellation, raw fingerprints, merge unions and repeated-prefix regressions.
- `tests/local-briefing-evidence.test.mjs`: production reader-to-combination tests, coverage and raw-digest checks, plus Git-backed collector/fingerprint, no-origin and two-folder coverage/byte-bound fixtures. Existing byte-budget fixtures now use distinct turns, so deduplication does not invalidate their original workload or assertions.
- `tests/local-briefing-run.test.mjs`, `tests/local-companion-cli.test.mjs`, `tests/local-personal-connector-briefing.test.mjs`: local option propagation and exclusion from prompt/report/transport configuration, including manual and automatic execution paths.
- `docs/operations/cloud-owner-turns.md`, this note, `progress.json` and `09-gap-coverage.md`: document the private contract, checks and remaining acceptance.

## Automated evidence

Node `24.14.1`, npm `11.11.0`. `npm run install:ci` failed with `spawn EPERM` in `scripts/npm-install.mjs`; existing dependencies are used and the lockfile is preserved.

The key tests were observed failing before implementation: nine reader/merge missing-export failures and one platform skip; the CLI rejected the new option. Subsequent review regressions reproduced combined-cap truncation loss and double normalization of `session_session_shared` before their fixes. Final independent review has no remaining actionable findings. Its own focused run passed 17 tests with one Windows file-symlink skip; this is separate from the integrator results below.

Initial integrator checks (before the provider-coverage follow-up below):

| Check | Exact result |
| --- | --- |
| `npm run typecheck` | Exit 0 |
| `npm run lint` | Exit 0; 0 errors, 15 existing warnings |
| Reader/merge focused command below | 14 tests: 13 passed, 0 failed, 1 skipped; 572.2991 ms |
| Integration-path focused command below | 4 passed, 0 failed, 0 skipped; 128.7937 ms |
| Complete five affected files below | 81 tests: 35 passed, 45 failed at Git fixture setup with `spawnSync git EPERM`, 1 skipped; 769.996 ms |
| Package/prompt command below | 7 passed, 0 failed, 0 skipped; 106.7275 ms |
| `npm run test:companion` | Exit 1; 0 passed, 17 file-worker failures, all `spawn EPERM` before test bodies |
| `npm test` | Exit 1; 0 passed, 370 file-worker failures, all `spawn EPERM` before test bodies |
| `npm run build` | Exit 1; six Vite configuration/dependency-resolution errors caused by `spawn EPERM`; full build did not run |
| `node scripts/package-local-companion.mjs` | Exit 0 for final source: 34 files, 293,122 bytes; ignored local ZIP only |
| `git diff --check` and checkpoint JSON parsing | Passed |

```text
node --experimental-strip-types --test --test-isolation=none --test-timeout=30000 --test-name-pattern="private imports|private import|cloud session merge" tests/local-cloud-owner-turns.test.mjs

node --experimental-strip-types --test --test-isolation=none --test-timeout=30000 --test-name-pattern="combined cloud evidence|private reader pipeline|local imported chats option|private imported chats override" tests/local-briefing-evidence.test.mjs tests/local-briefing-run.test.mjs tests/local-companion-cli.test.mjs

node --experimental-strip-types --test --test-isolation=none --test-timeout=30000 --test-reporter=tap tests/local-cloud-owner-turns.test.mjs tests/local-briefing-evidence.test.mjs tests/local-briefing-run.test.mjs tests/local-companion-cli.test.mjs tests/local-personal-connector-briefing.test.mjs

node --experimental-strip-types --test --test-isolation=none --test-timeout=30000 tests/local-companion-package.test.mjs tests/local-briefing-prompt.test.mjs
```

Disabling Node process isolation permits in-process checks; no assertion or timeout was relaxed. The full affected run's 45 failures were individually classified as the same Git-spawn error, rather than treated as passing tests. Package tests check exact reviewed archive bytes/CRCs and import the extracted connector without checkout dependencies. The generated ZIP is ignored and contains only the fixed source allowlist, never imported messages. There is no change to `package-lock.json`, `.openai/hosting.json`, shared briefing/personal-repository contracts, briefing prompt, server or UI.

## Limitations and handoff

The bounded fingerprint hashes contents only within its inventory/file/byte limits. Oversized or aggregate-over-budget records contribute filenames/sizes without reading their contents; same-size edits to such unread content can be missed, and files beyond inventory/file limits can be omitted altogether. This follows the requested finite read bounds. In-bound malformed or credential-only files still contribute raw hashes; identical byte rewrites leave the digest stable. Missing directories and unrelated repositories/non-Markdown files do not alter a matching folder's material digest.

The Windows host denied creation of a file symlink (`EPERM`), so that one case is skipped. Hardlink and directory-junction refusal tests passed. Default non-Windows homedir behavior, actual Git-origin discovery, complete Git-backed two-folder evidence/byte validation and connector execution need the subprocess-enabled integrator environment. Their fixtures are retained. No installed PC acceptance, real export completeness, actual provider/model prompt, hosted Site, browser or deployment check was performed. The normal application/companion/build gates remain integrator checks; package success is not a full build or release claim.

`git add -- docs/operations/cloud-owner-turns.md` failed with `Unable to create .../.git/index.lock: Permission denied`. There are no commits or staged changes. The integrator must commit the reviewed reader, integration/tests and documentation/checkpoint changes. No push, merge or deployment occurred. There is no required server change or protocol bump.

Original owner-message UTC timestamps are not supplied by this session. No timestamped owner-turn handoff, reconstructed timestamp or substitute assistant summary is invented; this is the missing evidence required by the owner-turn convention. The clock's current UTC time is not a message timestamp.

## Provider coverage follow-up

The integrator reported an owner-PC dry run accepting all eight map-lab and 23 Trade Graph files with zero rejects. Partial Claude sessions nevertheless made absent Codex coverage `unavailable`. That reported dry run was not repeated in this worker or used as permission to access real imports.

The cause was the final cloud-turn projection consulting the folder-wide `cloud.truncated` flag for both providers. The fix keeps session and source truncation markers unchanged and calculates coverage from each provider's retained turns, known valid sessions and attributable parse failures. Retained turns mean `included`; no own known session or attributable failure means `not-found`; rejected own content or known evidence omitted from the final pack means `unavailable`. A malformed file affects a provider only after the existing parser recognizes its exact provider header. Unreadable files or invalid headers with no known provider remain unassigned local diagnostics and cannot make an unrelated provider unavailable.

Both reader results now carry reader-only `availableProviders` and `providerFailures`. Availability is captured before source-session caps, then preserved across source combination and evidence trimming. These fields affect only the opaque local fingerprint and coverage calculation; they are absent from sessions, model-prompt evidence and stored briefing fields. No parser is duplicated, and no server, prompt, shared contract, protocol or session-truncation behavior changes.

Files changed in this follow-up: `companion/cloud-owner-turns.mjs`, `companion/briefing-evidence.mjs`, their two `tests/local-*.test.mjs` files, `docs/operations/cloud-owner-turns.md`, this verification note, `progress.json` and `09-gap-coverage.md`. The same explicitly selected `gpt-6.1-sol` implementation and review workers were resumed: `/root/reader`, `/root/integration`, `/root/review`. Independent review found no remaining actionable findings; its fresh focused run passed 22 tests with one Windows file-symlink skip.

The requested production-path filesystem regression first failed with actual `unavailable` versus expected `not-found`. The source-cap regression also first failed when a known omitted provider was reported absent. Seven new cases now cover partial Claude-only imports, provider-specific malformed/secret-only rejection, unknown failures, coverage-only sessions, source/combined caps and final trimming. Session-level truncation is asserted unchanged. Switching rejection attribution with otherwise identical retained evidence changes the opaque fingerprint.

Fresh worker checks after the fix:

| Check | Exact result |
| --- | --- |
| `npm run typecheck` | Exit 0 |
| `npm run lint` | Exit 0; 0 errors, 15 existing warnings |
| Requested coverage/cap regressions, command below | 2 passed, 0 failed, 0 skipped; 103.9206 ms |
| Reader focused command listed above | 19 tests: 18 passed, 0 failed, 1 Windows file-symlink permission skip; 867.1616 ms |
| Complete five affected files, same TAP command above | 88 tests: 42 passed, 45 failed at fixture setup with `spawnSync git EPERM`, 1 skipped; 1158.6777 ms |
| Package/prompt command above | 7 passed, 0 failed, 0 skipped; 150.0881 ms |
| `git diff --check` and progress JSON parsing | Passed |

```text
node --experimental-strip-types --test --test-isolation=none --test-timeout=30000 --test-name-pattern="production private reader coverage|production coverage remembers" tests/local-briefing-evidence.test.mjs
```

The full affected run's 45 failures were again individually classified as Git-spawn fixture setup failures. No timeout or assertion was relaxed. The ordinary process-isolated suites, installation, full build and actual PC/provider acceptance were not rerun in this follow-up; the earlier sandbox blockers remain. The earlier archive byte count belongs to the initial source, not this follow-up. Package tests did verify the current source archive bytes and extracted connector import closure. At the integrator's explicit instruction, nothing was staged or committed; no push, merge or deployment occurred.
