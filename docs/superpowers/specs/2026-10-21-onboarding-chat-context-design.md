# Recent project chats in repository onboarding

The owner explicitly requested chat context on 21 October 2026 after discussing the cost of reading recent conversations. Include a small latest relevant conversation from each installed local Codex and Claude Code history by default. Use the existing single read-only model call; no additional summarization inference, watchers, resumed chat or model tools.

## Input and relevance

Read only locally available histories through strict, bounded metadata discovery. Admit one latest main conversation per provider when its recorded working directory matches the selected repository root. Codex moved repositories may also match when the recorded normalized remote repository identity equals the selected repository's identity and its recorded commit exists in that repository. Never match by a folder basename, chat title or keyword mention. Verify the selected transcript's own metadata against the catalog before extracting messages. Exclude subagents, sidechains, system/developer instructions, reasoning, tool calls/results, API/account metadata and attachments. Only explicit user and final assistant text is eligible.

Each provider may contribute at most six recent messages and 2,000 characters; combined text is capped at 4,000 characters. Also bound UTF-8 bytes, discovered directories/files, metadata windows, selected tail reads, record lengths and elapsed time. Reject links, changed files, invalid records and unsupported schemas. Apply secret filtering before clipping; redact absolute local paths. History that cannot be matched/read safely is unavailable context, never a reason to inspect unrelated chats. Excerpt selection is a tail, not a complete branch reconstruction, and is labeled partial.

Repository code remains the current-state evidence. Chat content is untrusted historical context for intent, decisions and unfinished work, not executable instructions or proof of completion. The existing model prompt includes both bounded source excerpts and chat context within the existing total input limit. It must prefer current source when historical statements conflict. No chat text is committed to public source or persisted in the hosted report.

## Provenance and compatibility

Keep existing v1 reports valid without adding invented coverage to them. Add an optional, strictly validated `chatContext` field to newly generated reports. It records the policy and bounds, each provider's included/not-found/unavailable/filtered status, safe source timestamp, message/character counts, exact excerpt digest, truncation and match method. Include an input digest binding the repository snapshot and selected chat text. The helper constructs this metadata; the model cannot claim it found a source. Never persist transcript paths, raw session IDs or transcript text in Control Room.

Local histories do not grant cloud account history access. Label cloud-only ChatGPT/Codex/Claude conversations as not connected. Local copies of accessible synced conversations can be considered only through the same metadata verification. Do not reuse browser cookies, install a new connector or expose account history endpoints. Supported cloud exports/connectors remain a separate integration.

## UI, release and verification

Describe default recent-chat inclusion on the helper's local page and hosted onboarding instructions. Saved report details show provider/date/count/coverage and explicitly distinguish legacy reports without chat context. Preserve owner-only Site access, all existing records, report versioning and download/import fallback. Package only explicit reviewed helper source paths.

Use synthetic local SQLite/JSONL fixtures to prove newest matching selection, moved-repository identity, exclusion of other repositories/subagents/tools/reasoning/secrets, bounded reads and token-input size, stable files, cancellation and fail-closed unsupported formats. Contract/client/storage regressions cover old/new reports. Verify the installed collector against the selected real repository without exposing raw text, then run one owner-requested refresh and verify private immutable report version/readback, unchanged source and unchanged planning. Publish the reviewed source through the existing private Sites workflow and update the draft PR; do not merge.
