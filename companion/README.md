# Local repository companion

This optional Node 24 companion lets the private Control Room browser request a
finite read-only analysis of explicitly registered local Git repositories. It
does not install a background service, modify a repository, or activate the
general agent executor, telemetry bridge, provider sync, trading or alerts.

Start from this checkout using the existing Node 24 runtime:

```powershell
node companion/cli.mjs --repo C:\ABSOLUTE\REPOSITORY --state-dir C:\PRIVATE\ControlRoomCompanion\reports
```

Repeat `--repo` for another repository, or omit it and use **Add folder** on the
local companion page. That form takes a full existing Git repository root and
requires its own CSRF token plus the exact local Origin. The hosted site cannot
register paths. Roots persist privately in `repositories.json`; subfolders,
symbolic links and UNC paths are refused. Open `http://127.0.0.1:4319/` locally
and copy the 256-bit pairing code into the existing private Control Room site.
The code stays in process memory and that local page; it is not logged, stored,
or put in URLs. It expires after 30 minutes. Use **Renew pairing code** locally
and pair again to reconnect; renewal is refused while an analysis is active.
completed reports remain in the explicitly selected private state directory.
Keep that directory private: reports contain repository paths and source-derived
descriptions. The local page shows registered names, the pairing code and local
forms. It is not frameable and loads no external assets. Ctrl+C stops a
foreground companion, cancelling its owned active analysis.

If the browser blocks Site-to-loopback requests, use **Analyze read-only with
gpt-6.1-sol** on the local page. The same bounded execution runs once, with a
local Origin and CSRF guard. The status page refreshes status only. Download its
completed analysis JSON, choose a project under **AI project analysis** in
Control Room, and use **Import helper report**. Import validates the report and
saves through the existing signed-in owner command; it never starts AI. A
reused run ID with different report contents is rejected. This fallback was
added after the Codex in-app browser's direct connection failed before reaching
the local helper; direct pairing must be verified separately in other browsers.

Only `https://adami-project-control-center.roundmoth32.chatgpt.site` is admitted
as browser Origin. Every API request needs `Authorization: Bearer <code>`;
preflight is the browser's unauthenticated CORS negotiation, not API access.
Host must exactly match the bound `127.0.0.1` address and port. The companion
does not bind LAN interfaces. Pairing is a user-session capability, not a defense
against another malicious process already running as the same Windows user.

## What gets analyzed

The companion reads current tracked files including edits and nonignored safe
untracked files. It creates an independent in-memory text snapshot and content
hash manifest; it never creates Git worktree links or copies `.git`. Links,
hidden files, instruction files such as AGENTS/SKILL/CLAUDE, dependency/build
directories, credentials/auth files, binary files, detected credential text and
files larger than 128 KiB are excluded. Limits are 2,000 files, 8 MiB selected
text and a 190 KB manifest/excerpt bundle. Secret filtering is heuristic and
cannot recognize every private value. Review the repository selection before
requesting analysis; selected source excerpts are sent to Codex under the
existing ChatGPT subscription.

Codex receives only the supplied bounded excerpts in its prompt. Its working
directory is a new empty temporary directory. Shell, multi-agent, plugins,
skill search, images and web search are disabled, and user configuration and
host skill discovery are ignored. Native read-only sandboxing remains enabled.
The exact model is `gpt-6.1-sol`, medium effort; there is no substitution or API
key fallback. Missing independently observed model identity stays null.

The current desktop-bundled Codex is discovered before PATH copies and checked
using version/help and `login status`, requiring `Logged in using ChatGPT`.
No login or global configuration is changed. Windows requires an existing
PowerShell 7. The companion probes the existing Program Files installation,
Codex's existing bundled runtime and PATH; it never installs a runtime or changes
global PATH. Its fixed checked-in C# helper is compiled in memory
with Add-Type; no .NET SDK or installed helper binary is required. A suspended
Codex process is assigned to an owned Job Object before resume. Kill-on-close
owns cancellation and an active-process limit of one denies child creation.
This lifetime boundary does not replace the Codex native sandbox.

One analysis can run at a time, for at most 300 seconds with 2 MiB output.
Cancellation terminates the owned Job and requires confirmed process exit.
Missing confirmation fails closed. No automatic retries occur. A request UUID
is idempotent and remains associated with its original repository. Successful
reports are validated against the shared schema and exact selected file hashes
and citation line ranges, then saved locally. Restarted unfinished requests are
failed, never relaunched. A report is a proposed description, not independent
proof of runtime behavior, tests, task completion or deployment.

The companion never automatically starts a second CLI invocation. Codex may
internally retry network requests within that one invocation; the companion
does not claim provider billing idempotency.

## HTTP contract

- `GET /api/status`: version 1, registered repository key/name/head/dirty and
  optional active run. No absolute paths are returned.
- `POST /api/analyze`: exact `{repositoryKey, requestId}`; returns a run identity.
- `GET /api/runs/:id`: queued/running/completed/failed/cancelled and a completed
  report or bounded safe error.
- `POST /api/runs/:id/cancel`: cancels only the currently owned matching run.

Reports persist across reconnect so saving a completed report to Control Room
never requires another model call. They are not automatically sent to the Site;
the browser's explicit save flow handles that separate owner action.

Boundary tests (including synthetic Windows process ownership, no model calls):

```powershell
node --test tests/local-companion.test.mjs
```

## Recent local chat context

Before inference, the helper prioritizes concise user messages from each
reader's existing last-six-message window. Length and formatting are heuristics;
they cannot distinguish personally typed text from pasted text. Complete
ordinary user messages of at most 800 characters take priority. A nearby safe
preceding answer is included only for a context-dependent short instruction,
with at most 600 assistant characters per provider. Long prompts and code blocks
are deferred; if no concise user message qualifies, the latest safe user input
has a 1,000-character fallback preserving its beginning and end. Assistant-only
coverage is deferred. Unused budget stays unused.

This selection uses no model call. Selected text still consumes input tokens in
the existing single inference call. New coverage records identify the
`concise-user-first-v1` selection; older report metadata is never rewritten.

Analysis includes a small amount of recent project chat context by default: the
latest matching local Codex conversation and the latest matching local Claude
conversation, up to 4,000 characters combined. Only selected user and final
assistant text is eligible. Tool calls, tool outputs, reasoning, system/developer messages,
unrelated histories and detected credentials are excluded. Filtering is
heuristic; it cannot recognize every private value.

These excerpts join the selected source pack in the existing single Codex model
call. The helper does not resume a previous chat, make an extra summarizer call,
or connect to ChatGPT or Claude cloud history. Missing, unreadable or filtered
local history is reported as incomplete coverage, not successful access.

New reports show each provider's coverage, recorded activity time, included
message and character counts, and whether the excerpt was truncated. The report
records bounded provenance rather than raw transcripts or local session paths.
Earlier reports remain valid and display: "Chat context was not recorded for
this report." Chat-derived descriptions remain historical context requiring
review, not proof of current source behavior or completed work.
