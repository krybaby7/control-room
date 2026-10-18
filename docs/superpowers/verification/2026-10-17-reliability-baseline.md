# Reliability and current baseline verification — 17 October 2026

The owner approved reliability fixes first, then the dated TAMENNI/Trade Graph baseline. All implementation agents used **GPT-6.1 Sol**. Root coordinated research review, integration and local browser verification. This record describes local evidence; publication and hosted application remain pending.

## Audit findings and implemented fixes

| Audit finding | Implemented behavior | Evidence |
|---|---|---|
| Archive erased completion history and broke completed prerequisites | Archive records the previous status and preserves completion; restore recovers it; explicit reopening still checks dependents | Lifecycle regressions; browser completion/archive/restore |
| An uncertain save could create duplicate work | Owner-scoped durable mutation receipts, stable unchanged-submission IDs and atomic writes; changed content cannot reuse an ID | Real SQLite storage tests; browser lost-success retry |
| Weekly pins and completion counts drifted across weeks | Monday-start Cairo week IDs, dated completion counts and explicit carry-forward | Calendar/migration/weekly regressions; browser count retained through archive |
| Refresh and session failure left misleading state | Failed refresh retains saved data with stale/error labels and separate refresh/save times; 401 removes protected view and offers same-origin sign-in | Client regressions; injected 503 and 401 browser flows |
| Backup lacked a usable restore flow | Strict versioned validation, count preview, explicit revision-protected restore and atomic prior snapshot | Validation/storage tests; actual restore conflict and backup download |
| Informational text and capacity feedback were weak | Darkened readable text roles, visible record/byte usage and an explanation that archive retains capacity | Integrated CSS review and desktop inspection; mobile CSS breakpoint review only |
| Starter proposals lacked current project evidence | Repository-matched dated baselines; observed/documented/owner-decision labels; five additive proposals plus one portable context per project | Ten baseline regressions; source review; actual local UI application and lost-response replay |

## Automated checks

The integrated source passed **71 tests**, zero failures or skips, using the Node test runner. Coverage includes real SQLite mutation receipts and owner isolation, conflict/restore atomicity, schema migration and rejection, archive history, Cairo week rollover, retained drafts and response classification. Ten baseline tests cover preservation, repeat application after edits/archive, exact repository and milestone matching, missing-marker states, collisions, capacity/no-partial-change, long IDs and export/restore context.

`npm run typecheck`, `npm run lint` and the direct production `npm run build` passed. Root reported the production build result after integration. The Sites `build-site` helper first failed on Windows npm-command resolution before reaching the build; the direct build success does not establish successful Sites packaging or publication. The built worker excludes development mock authentication.

## Integrated local browser evidence

Root observed the following against isolated local data with development-preview authentication. Revision numbers below belong only to that QA workspace.

- **Lost success:** a POST completed upstream with HTTP 200 but its response was deliberately dropped. The editor retained its draft. Explicit unchanged retry produced exactly one task and revision 2.
- **Real conflict:** while an editor held revision 2, another mutation created revision 3. Save received actual HTTP 409 and retained the draft. Explicit retry preserved the original title edit and the other writer’s notes.
- **Archive history:** complete → archive → restore retained the same completion timestamp, `2026-10-17T16:33:40.500Z`; this run’s creation and completion times coincided. This-week completion count remained one.
- **Restore conflict/recovery:** a restore preview based on revision 6 conflicted with actual revision 7 and retained the preview. Explicit retry restored at revision 8. Downloaded pre-restore backup preserved revision 7 with 11 tasks; restored workspace contained 10.
- **Failed refresh:** injected GET 503 displayed “Refresh failed,” a stale indication and last-success information while retaining the saved workspace.
- **Session expiry:** a Quick capture held dirty title/details when its POST received an injected 401 without forwarding. The native dialog and private workspace disappeared; “Signed out,” “Session expired” and same-origin sign-in appeared with an explicit in-memory draft-loss warning. No capture was saved.
- **Baseline application:** TAMENNI’s first application committed but its response was dropped. Refresh showed “Baseline saved” and the retained retry action; explicit “Retry changes” left revision 9 unchanged and created no duplicates. Trade Graph applied normally at revision 10. Both project views showed the saved badge.
- **Preservation check:** API/export inspection after both applications found 20 tasks and 3 captures. All original project and milestone records, 10 tasks and one capture were value-equivalent to the pre-application records. The ten additions were proposed, without due dates or weekly pins; no unintended commitments were added. Desktop layout was inspected.

These are browser observations of the Control Room’s planning and recovery behavior. They do not verify either underlying product, exchange execution or physical device reliability.

Independent Sol review completed with no outstanding findings after the runtime wording correction. Mobile layout received CSS breakpoint review, not an executed mobile-browser or physical-device check in this reliability campaign.

## Baseline and historical limits

Baseline sources were checked at **2026-10-17 16:20:30 UTC**. TAMENNI’s 419 local changed/untracked entries were a dated observation, not a stable source pin. Its September software/hardware reports remain scoped to their named candidates. Map-lab remote evidence is pinned to `d980806`. Trade Graph’s independently observed CI success targets `0595d98`; the active integration report at `9fa7efb` follows it with documentation updates. That dated report says the new engine was not installed; current runtime was not inspected. No profitability, release-readiness or installation approval is inferred.

Baseline context contains saved summaries, source dates and verified links. Local document paths are repository-relative; published context contains no personal absolute filesystem paths or secrets. Existing starter proposals, edits, goals, milestone states, dates and commitments remain intact. Installation follow-up is preparation only.

Strict migration preserves available history. A completion timestamp erased by an earlier archive implementation is unrecoverable without independent backup evidence; migration does not invent it. Legacy weekly pins are anchored to their saved week and are not silently renewed.

## Remaining delivery checks

- Package the exact reviewed source, privately publish through Sites and confirm the terminal deployment result.
- Verify the hosted production artifact and apply both reviewed baselines through the authenticated app, checking preserved records and saved context.
- Mobile-browser and physical-device behavior remain unverified; desktop inspection and CSS breakpoint review do not replace those checks.

No underlying project repository, trading service, paid provider or cloud project data was changed by this baseline research or implementation.

