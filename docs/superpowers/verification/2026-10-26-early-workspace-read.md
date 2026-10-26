# Faster first screen verification — 2026-10-26

The controlled browser performance gate failed on `main` head `f43db3a` itself: its five cold mobile loads measured 2,961–3,020 ms against the unchanged 3,000 ms first-usable budget (run 40302560846). The multi-folder pull request inherited the same red check, so the gate was not a flake of that change.

## Causes

A throttled waterfall of the built app (150 ms latency, 200 KB/s, 4x CPU) showed three costs on the critical path:

- **Late workspace read.** The control centre requested `/api/workspace` only after every code chunk had downloaded and hydration had finished, adding a further network round trip and render.
- **Startup queue.** The local fixture serves HTTP/1.1, so Chromium opens six connections and queues the rest. React preloads the app's bootstrap module with low fetch priority, so it waited behind all 45 other startup files and was requested near 2.0 s. Everything else had arrived by about 2.1 s; the page then waited for that one file until about 2.5 s. Every extra startup file moves it later.
- **Startup size.** Views that are not on the first screen (Projects, project and milestone detail, task bulk actions, Inbox, Search, Attention, Runtime) were statically bundled into the startup code: 285 KB compressed in all.

## Changes

- **Early read.** The page's server-rendered HTML starts the same read (`GET /api/workspace`, same-origin credentials, `no-store`) in a small inline script while the code downloads. The control centre's first bounded read takes that response once, only within 10 seconds of starting, through the unchanged `readWorkspaceResponse`, session generation and deadline. Every later read, and any page whose early read is missing, stale or failed, uses the network exactly as before; a failed early read surfaces through the existing "Try again" screen. Nothing is cached and no request is added.
- **Deferred views.** Those views now load when selected, through the existing deferred-panel wrapper (loading status, retry and "Return to Project lanes"), like Today, History, Evidence, Weekly, Sources, Agents and Repositories already do. The runtime enrollment errors moved to a small module so the control centre no longer imports the runtime panel; the panel re-exports them unchanged. Project lanes and the editors stay in the startup code. Startup code fell from 285 KB to 236 KB compressed.
- **No wrong first screen for links.** The faster start exposed an existing flash: a link such as `/?view=projects&entity=project&id=…` painted the project lanes for about two frames before switching to the linked project, because the link was applied in a passive effect after paint. CI's `project-framing.spec.ts:13` clicked "Edit project" during that flash. The link is now applied in a layout effect, with the update flushed synchronously in the same microtask, so the linked view is the first one painted. The test was not changed.

No budget, timeout or test assertion was loosened.

## Checks

- Controlled profile in the same container, interleaved rounds, the fixture restarted for each build. Multi-folder head with the early read: median 2,960 ms, max 3,240 ms, 2 of 15 loads over 3,000 ms. With the deferred views added: median 2,768 ms, max 2,848 ms, none over 3,000 ms. Earlier rounds: `main` median 3,041 ms (9 of 15 over 3,000 ms); early read alone median 2,898 ms.
- `tests/workspace-boot-read.test.ts`: the page script's request shape, single use, staleness/malformed rejection and failure propagation through `boundedRequest`.
- `tests/e2e/boot-read.spec.ts`:
  - With every code chunk held back, the workspace read still starts (so only the HTML can have started it), and the page renders from exactly one read.
  - A per-frame check finds no painted project lanes on a project link. It failed 3 of 3 before the layout-effect change and passes afterwards.
  - A lost early read shows the existing failure screen, and "Try again" loads the workspace.
  - With the inline script removed, the first test fails as expected.
- Full-suite results are recorded in the pull request.

This is a source and synthetic-fixture change. Hosted publication and real-device timing are not claimed.
