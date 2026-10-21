# GitHub cloud onboarding verification — 2026-10-21

This increment adds the owner-selected subscription-only Codex Cloud handoff alongside the existing local companion. The Site source baseline is `2e49a1b5f67d8279fc0758afb5c9601fad57dba7` (tree `12c3fd4a104d066ac1e40f35c8e3088b82877ba1`), identical to public branch `feat/local-repository-onboarding` at `2325a52ebec852267d28f4ca20669f6ffbba87b6`. The feature does not alter the database schema, dependencies, hosted audience, paid-provider activation or broader performance acceptance gates.

## Implementation and independent review

The runtime accepted explicit `gpt-6.1-sol` selection for `/root/cloud_contract`, `/root/cloud_persistence`, `/root/cloud_ui` and independent reviewer `/root/cloud_review`. Review corrections cover legacy repository URL identity matching, mandatory explicit refresh of an existing active report, and recovery after a trusted conclusive save rejection. The final independent review reported no remaining material findings.

Cloud reports use a separate strict envelope with pinned source commit, bounded manifest/citations, request UUID and explicitly imported, unsigned provenance. Saving creates or links the project and appends immutable report evidence in one owner-scoped transaction. Existing goals/tasks and local analysis behavior remain intact. Suggested tasks require owner review.

## Automated checks

- `npm run test:github`: 20/20 passed, covering contract, malformed/oversized imports, private bounded client reads, atomic create/refresh, rollback, replay, owner isolation, historical identity and export/replacement.
- `npm run test:companion`: 64/64 passed. Combined local/cloud SQLite coverage passed 13/13.
- `npm run typecheck`: passed. `npm run lint`: passed with zero errors and eight existing warnings.
- `npm run build`: passed; the publication helper rebuilds the final source with the canonical Sites builder.
- `npm run test:fixture`: passed against the actual built Worker and isolated D1, including GET/POST, receipt replay and CSRF rejection. The new report GET separately returned 401 without authentication, an empty owner-isolated result for another synthetic owner, 400 for unknown parameters, and private/no-store headers.
- `git diff --check`: passed. Hosting identity and `package-lock.json` remain unchanged.

The default `npm test` attempt stalled in native Workerd under high file concurrency and was stopped after process inspection. A serial diagnostic attempt was also stopped; neither is claimed as a pass. A complete bounded Node run used `--test-concurrency=4` and excluded only `workspace-admission.test.ts`: **1,860 cases, 1,847 passed, 10 failed, three skipped**. The excluded admission file then passed independently **5/5**, including actual Miniflare request tickets.

Three failing cases were environmental and passed on isolated rerun: the archive Python check used a task-local real Python alias (archive **7/7**), and two fixture-port conflicts disappeared after stopping the owned preview servers. The fixture rerun passed **9/10**. Seven failures remain in unchanged Windows-incompatible baseline tests: one Unix absolute-path assertion in `fixture-harness.test.ts`, two executor fixtures omitting the required Windows private-state ACL verifier, and four Unix-oriented bridge packaging/npm-spawn cases. The affected tests and production files have no feature diff. These combined results do not constitute a green full-suite run; Linux CI and the existing wider release acceptance remain separate.

## Browser and HTTP acceptance

All write journeys used isolated synthetic owners and D1, never production owner records:

1. Cloud/This PC mode switching retains the existing local component.
2. Repository URL and new project destination produce a bounded prompt without creating a project.
3. Pasted JSON import, report review and explicit save create exactly one project and one report head.
4. Reload reads the saved report; reimport recognizes the same run without a duplicate project.
5. A saved repository selection resolves the matching project.
6. A genuine concurrent server refresh produces a 409. The draft remains available, a trusted rejection unlocks review/discard, and a later explicit save appends version three.

Final synthetic state contained one added project, unchanged task count and one active report at version three. Browser screenshots and raw runner logs remain ignored local evidence, outside public source. Preview servers were stopped before release packaging.

## Live boundary and publication receipt

Control Room prepares prompts and imports returned reports. GitHub authorization, live repository selection and execution take place in the ordinary Codex Cloud UI. A real cloud model task was not launched in this verification, and imported model/source claims are not independently authenticated. Subscription eligibility and allowances apply; no API key or separately billed inference was enabled.

The release operation packages this verified source, pushes it to the existing Site repository and uses the native private deployment operation. The terminal source/version/deployment receipt is recorded after this frozen source checkpoint, outside the public application tree. Publication does not waive the wider historical performance/provider/device gaps.
