# Early workspace read verification — 2026-10-26

The controlled browser performance gate failed on `main` head `f43db3a` itself: its five cold mobile loads measured 2,961–3,020 ms against the unchanged 3,000 ms first-usable budget (run 40302560846). The multi-folder pull request inherited the same red check, so the gate was not a flake of that change.

A throttled waterfall of the built app showed why. Every code chunk is requested at once and shares the profile's 200 KB/s, so the last chunk arrives near 2.4 s; hydration follows; only then did the control centre's polling effect request `/api/workspace`, adding a further 150 ms network round trip and a second render before the page was usable. The workspace read sat on the critical path even though it needs nothing from the app's code.

The page's server-rendered HTML now starts that same read (`GET /api/workspace`, same-origin credentials, `no-store`) in a small inline script, while the code chunks download. The control centre's first bounded read takes that response once, only within 10 seconds of starting, and decodes it through the unchanged `readWorkspaceResponse`, session generation and deadline. Every later read, and any page whose early read is missing, stale or failed, uses the network exactly as before. A failed early read surfaces through the first read and the existing "Try again" path. No data is cached, no request is added and no budget changed.

## Checks

- Local controlled profile (Chromium, 150 ms latency, 200 KB/s, 4x CPU, 12 cold loads each, same container): `main` 2,917–3,193 ms, median 3,051 ms; with the early read 2,812–2,926 ms, median 2,865 ms. The workspace response now arrives before hydration finishes.
- `tests/workspace-boot-read.test.ts`: the page script's request shape, single use, staleness/malformed rejection and failure propagation through `boundedRequest`.
- `tests/e2e/boot-read.spec.ts`: with all code chunks held back, the workspace read still starts (so only the HTML can have started it), the page renders from it with exactly one read and the global is consumed; a lost early read shows the existing failure screen and "Try again" loads the workspace. With the inline script removed, the first test fails as expected.
- Results of the full suites are recorded in the pull request.

This is a source and synthetic-fixture change. Hosted publication and real-device timing are not claimed.
