# Remove the personal PC request-count limit

**Goal:** Honor the owner's explicit instruction to remove the 20-request limit entirely.

**Design:** Remove the count checks in personal-state validation and owner/automatic briefing admission, plus the obsolete limit constant and declaration. Retain all request identities and results; do not replace the cap with another number or automatically prune history. Preserve existing byte bounds, authorization, deadlines, single-job execution, acknowledgment and backup semantics. No database migration or owner-data rewrite is needed. Existing companions do not validate total request count, so this change requires no installed companion update.

**Plan and evidence:**

- [x] Trace the reported HTTP 409 through owner admission and all downstream readers.
- [x] Add regressions for requests after 20 and 100 entries, manual browse/analysis/brief, automatic brief, retries, unsaved results, full validation and backup restore.
- [x] Observe failures before implementation: 20 entries reproduce the reported 409; larger histories fail the old state validator.
- [x] Remove the three checks and constant; update the obsolete queue-full rejection test.
- [x] Run focused regressions: 39 tests pass.
- [x] Independent review by explicitly selected `gpt-6.1-sol` worker `/root/limit_compatibility_review`: no actionable findings.
- [x] Typecheck passes; lint reports zero errors and 15 existing warnings outside changed code.
- [x] Run broader tests: 2,320 total, 2,265 passed, 52 failed, three skipped. See limitations below.
- [x] Supported production build passes. Packaging/publication follow the existing Sites workflow.
- [ ] Publish to the same owner-private Site and confirm the deployment receipt.

**Scope boundary:** There is no request-count ceiling after this change. The existing 500,000-byte state limit and companion transport byte limits still apply. No new provider inference is needed for verification, and no claim of unbounded physical storage is made.

**Broader verification limitations:** The full Windows run had 43 native Miniflare fetch failures carrying `EADDRINUSE`, two executor ACL failures, two collector PowerShell/Get-Acl failures, four bridge packaging failures and one backup reauthorization `uncertain` versus `completed` assertion. A detached unchanged baseline at `d2c94be06a5483fbd30daf968cbd54e9220c547e` ran five representative files (20 tests, 12 passed, eight failed), reproducing all eight ACL/PowerShell/packaging failures. The reauthorization and native read-group cases passed there; the transport failures were not reproduced in that bounded run. The full suite is not claimed green. Logs remain in ignored `outputs/request-count-removal/`; no private runtime data was committed. This narrow request-count change has no UI, provider, schema, backup authority or platform integration changes.
