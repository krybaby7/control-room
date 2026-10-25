# Recover briefing execution and dashboard status

**Goal:** A requested project briefing must execute on the installed companion and retain its progress or failure status across a dashboard reload.

**Root causes:** The installed October 21 personal companion accepted only browse and analysis jobs; it rejected briefing jobs before creating a local run receipt. Its polling loop suppressed that protocol error, while the server eventually marked the claimed request as expired. Independently, the dashboard still limited the owner job projection to 20 entries and discarded the whole connector feed after a 21st entry. The previous request-count change missed this frontend check.

**Changes:** Remove the remaining count check from the dashboard schema. Describe successful enqueue as waiting for the PC assistant to start, without promising completion within a few minutes. Update the existing installation to the reviewed briefing-capable companion package, verifying all 31 archive entries against reviewed source bytes. Preserve the existing encrypted connection, repository registry, reports, old release and a private recovery backup. No provider login, credentials, scope, paid API or automatic policy is added.

**Verification:**

- Four new feed regressions fail before the frontend fix and pass afterward, covering claimed and failed briefing status after a fresh dashboard read with 21 and 101 requests.
- The focused dashboard/model/render/request/briefing suite passes 40 tests.
- Companion briefing tests pass 25 cases; package tests pass two cases. These use synthetic provider implementations and do not claim a real model run.
- Typecheck and supported production build pass. Lint has zero errors and the same 15 existing warnings.
- Explicit `gpt-6.1-sol` worker `/root/review_briefing_fix` found no actionable findings and no remaining personal-PC request-count cap. `/root/limit_compatibility_review` independently diagnosed and staged the local companion update.
- The updated installed companion starts successfully, owns the expected local port, and preserves the encrypted connection and registered repositories byte-for-byte. No model run is started merely by installing it.
- The earlier broad Windows suite is not represented as green; its platform/fixture failure evidence remains in the prior request-count implementation record. This increment uses the focused checks above.

**Publication and live acceptance:** Publish the same owner-private Site, reload the existing browser tab, confirm that the real connector and persisted failure are visible, and verify a requested briefing only within the owner's intended project and repository scope. Runtime records, request IDs, private manifests, logs and deployment receipts remain in ignored local output or the private installed state.
