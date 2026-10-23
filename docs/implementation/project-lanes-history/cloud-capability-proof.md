# F1 / C4 source capability investigation

Observed 2026-10-22 in the managed cloud checkout. Worker `/root/lanes_capability_audit`; integrator supplied accepted explicit runtime selection `gpt-6.1-sol`. This is bounded preparation evidence, not completion of C4 or a live provider gate. No dependent implementation was performed before S1 freeze.

## Actual installation and tool evidence

Read repository AGENTS, new CLOUD-HANDOFF and chapters 01–03. `command -v` found neither `codex` nor `claude` on PATH; consequently no executable version could be obtained. This does not prove absence from every filesystem location. No broader installation or private state search was performed. Neither provider SDK appears in this repository's package.json/package-lock.json. Available tool metadata exposes no dedicated Codex/Claude Code source conversation inventory/content reader. Browser capability is not evidence of an authenticated provider session. The managed worker's own execution tools are not an owner-history API.

No source lists/messages, transcript roots, authentication material, teleport/resume, provider inference, account probing, or production data reads occurred. No account, organization, device, root, archive scope, authentication lifetime, count, or coverage denominator was verified.

## Four separate source capabilities

These are conservative current-environment states, not claims that a documented product feature is globally unavailable. All have `verifiedAt: null`, `unattendedRead: false`, and proof reference to this document. Documentation review date must not populate live `verifiedAt`.

| Kind | Configured scope | Inventory / contentRead | Official surface versus actual proof | Remaining proof |
| --- | --- | --- | --- | --- |
| `codex_local` | No enrolled owner device/root | unverified / unverified | App-server documents stored-thread inventory and read methods [O1]; no local executable or owner scope tested. | Enrolled device, installed version, explicitly selected roots/sources, active+archive pages, older full items, segments and attachments. |
| `codex_cloud` | No selected owner account/workspace/environment | unverified / unverified | CLI documents recent cloud inventory with JSON/cursor support [O2]; it does not establish complete historical transcript export. No executable/account test. | Supported account-bound read surface, complete inventory traversal, archive behavior, content pages and inherited segments, attachment access, limits and renewal. |
| `claude_code_local` | No enrolled owner device/root | unverified / unverified | Agent SDK documents on-disk enumeration/read helpers [A1]. This is local history, not a hosted cloud-history API. No installation test beyond PATH/package evidence. | Device/SDK version and read-only scope; retention, compaction originals, subagents, attachment coverage, and stable identity. |
| `claude_code_cloud` | No selected account/organization | unverified / unsupported via examined Compliance API | Specific Compliance session documentation excludes Claude Code cloud [A2]. Teleport is a continuation workflow [A3], not an unattended read-only collector. | Provider-supported read-only inventory/content API or separately authorized manual acquisition with provenance and explicit gaps. Do not substitute Claude.ai chat exports or Cowork remote transcripts. |

## Interface details and limitations

[O1] App-server documents cursor-paginated `thread/list`. Default source kinds select interactive CLI/VS Code only; omitted archive flag selects non-archived history. `thread/read` does not resume a session, but its default returns summary only. For paginated history, use `thread/turns/list` with full items; summary/default item views cannot prove content completeness. These methods describe stored history available to the selected server, not an account-wide cloud export guarantee. Local list defaults alone can explain missing classes of records; they do not prove the owner's specific desktop/CLI mismatch.

[O2] `codex cloud list` is documented as recent inventory, with `--json`, `--cursor`, environment filtering and limit 1–20. JSON includes tasks and an optional cursor. The reviewed CLI reference gives no all-history guarantee or complete transcript/attachment export contract. It identifies cloud/app-server commands as experimental. Noninteractive execution and task submission are separate write/inference workflows, not historical reads.

[A1] SDK `listSessions` and `getSessionMessages` enumerate/read sessions on disk. Session files are host-local. An application-owned session store can persist its own transcripts, but does not grant access to previously retained Anthropic cloud sessions. `query` with resume/continue adds to a session and must not be used to collect it read-only.

[A2] Compliance session content requires an Enterprise Compliance Access Key with the appropriate user-data read scope; Admin keys cannot read these transcripts. The product table maps local Claude Code to local endpoints, while remote endpoints cover Cowork. Explicit exclusions include Claude Code cloud, Console/API-key and third-party-platform Code sessions, and ZDR local sessions. Capture depends on enterprise sign-in and enablement; absent capture cannot be inferred from API availability. Generic Compliance overview wording must not override this specific scope table.

[A3] Teleport verifies the repository, fetches/checks out the cloud branch and loads conversation history into a local continuation. It can prompt about uncommitted changes and requires claude.ai authentication. Its branch/session effects exclude it from automatic read-only acquisition. Cloud follow-up commands post messages; they are also excluded.

## Desktop versus CLI discrepancy and next proof

The plan reports readable desktop cloud chats versus an empty bundled CLI list on Oct 22. That observation was not reproducible here: neither executable nor a supported source chat reader is present, and no account identity was assumed. Record the mismatch as unresolved, not zero inventory. Required owner/provider evidence: sanitized installation versions; matching account/workspace/environment labels; exact supported read-only method and filters; counts plus opaque redacted ID aliases; page completion including archives; representative older content and segment/attachment losses; access-expiry behavior. An interactive desktop read is evidence only for that read, not hosted unattended support. Never publish credentials, private paths or transcript bodies in this proof.

## Official primary sources

- [O1: Codex App Server](https://developers.openai.com/codex/app-server), redirects to `https://learn.chatgpt.com/docs/app-server`. Retrieved source refs: `turn9view0`, `turn10view1`, `turn10view2`.
- [O2: Codex CLI reference](https://developers.openai.com/codex/cli/reference), redirects to `https://learn.chatgpt.com/docs/developer-commands?surface=cli`. Refs: `turn9view1`, `turn10view3`, `turn11view1`.
- [A1: Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions). Ref: `turn11view0`.
- [A2: Compliance session transcripts](https://platform.claude.com/docs/en/manage-claude/compliance-sessions). Ref: `turn10view0` (specific scope/exclusions; generic overview alone is insufficient).
- [A3: Claude Code in the cloud](https://code.claude.com/docs/en/claude-code-on-the-web). Ref: `turn9view3`.

No product code, tests, GitHub writes, or live acquisition changed. C4 and all four live source gates remain open.
