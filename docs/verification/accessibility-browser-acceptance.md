# Isolated accessibility and browser acceptance

Status: prepared; no execution result is claimed by this source change.

Run on Node 24 after the locked install and production build:

```sh
npm run install:ci
npm run build
npx playwright install --with-deps chromium firefox webkit
npx playwright test --config playwright.acceptance.config.ts
```

The dedicated `Control Room accessibility and browser acceptance` workflow runs
each browser in a separate Ubuntu job with an isolated actual built Worker and
synthetic owner database. It does not connect a private hosted owner workspace,
provider, device, executor or model.

The scanner is the actual `axe-core` engine, version **4.11.4**, already retained
by `package-lock.json` through the lint dependency tree. The test injects that
installed engine directly; it does not claim to use `@axe-core/playwright`.
No dependency or lockfile upgrade is needed. Changing the retained engine version
requires updating the explicit test assertion after review.

Coverage includes native 390, 768 and 1280 pixel browser viewports; skip navigation
and the main landmark; keyboard opening, focus containment, Escape and restored
focus for clean dialogs; Today, capture, Agents, budget and enrollment screens;
explicit budget-consent refusal; and no owner execution/enrollment POST during
the read-only audit. The full page is scanned with WCAG 2 A/AA, WCAG 2.1 A/AA and
best-practice tags. No color-contrast, dialog or landmark rule is disabled.
Serious or critical axe violations fail the gate. Lower-impact violations and
incomplete findings are retained for manual review rather than treated as passes.

Chromium and WebKit additionally exercise native touch context navigation and the
account menu at 390 pixels. Playwright Firefox mobile/touch context emulation is
unsupported, so that one test is explicitly skipped there; Firefox still runs all
three keyboard viewport journeys. This is emulator coverage, not a physical
phone or tablet acceptance result.

Each matrix job uploads `synthetic-acceptance-<browser>`: the JSON reporter,
per-stage engine/version/source/viewport findings, incomplete checks, and failure
screenshots/traces. The workflow records the exact source commit in
`CONTROL_ROOM_SOURCE_COMMIT`. A terminal successful workflow and its artifact
identities are needed before recording acceptance in the release ledger.

Remaining manual checks include screen-reader reading order and announcements,
zoom/reflow beyond these sampled widths, non-text contrast interpretation,
physical touch targets and owner-private hosted gateway behavior. Automated
results do not certify complete accessibility or live integration.
