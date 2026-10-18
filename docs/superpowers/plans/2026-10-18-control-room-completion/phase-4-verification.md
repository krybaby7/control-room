# Phase 4 verification

## Implemented behavior

Source selection and proposal decisions use owner commands, revisions and durable receipts. New and changed selections start paused. GitHub adapters read bounded, pinned repository/branch/file/PR/check representations through an injected closed read transport; no live provider is activated by these fixtures. Documents and selected conversation messages have explicit bounded manual import paths. Provider prose cannot issue commands, complete work or make weekly commitments.

Refresh intents extend the existing foundation queue. Private owner-scoped grants, renewable principals, execution epochs, leases and separate operational revisions guard page and terminal commits. Observations, pending proposals, cursor advancement, history and operational stream watermarks commit atomically without advancing the editor revision. Only a completed successful refresh updates the last successful timestamp and source revision. Partial runs retain continuation on the same intent.

Manual retries bind the selected input digest to the original owner mutation and intent. Completed unchanged retries return the original receipt and run summary. Optional retained snapshots reference already finalized private attachments; exact owner, SHA-256, length, private verification and cleanup fences are checked before admission and atomically at page commit. Conversation retention contains the canonical submitted selection, not an asserted copy of the original export file. Excerpt-only observations remain explicitly limited.

Evidence creation can explicitly cite an immutable observation ID and payload digest. Proposal acceptance requires selected allowed fields, a reason and matching current owner values; imported or generated data does not accept itself. Source history and selection export through registered modules. Credentials, grants, leases, cursors, service identities and executable intents do not. Reviewed restore rotates execution authority, clears grants and pauses sources while preserving historical IDs.

## Verification evidence

- Integrated Node checkpoint: 978 tests passed, zero failures or skips. Typecheck, lint and production build pass; built HTTP attachment isolation/replay passes; cloud browser execution remains pending at this document checkpoint.
- Actual isolated Miniflare D1 applies all 19 exact SQL migrations. Unattended claim, renewal, a 100-observation page, terminal completion and explicit resume assertions pass under D1 expression-depth limits.
- `npm run test:sources-d1` passes actual D1/R2 source selection, private attachment finalization, 73-byte retained manual source import, original-receipt replay, full native archive and reviewed restore. Byte SHA-256: `e779a24a8292c1117e021e1fff3f25eeaae883ebc3e655ae7a1da10d1a1ba80b`.
- `npm run test:workspace-d1` passes actual D1/R2 baseline, legacy correction, decision criteria, upload/finalization and native archive restore with the 19-migration schema.
- `npm run test:attachment-recovery-r2` passes isolated actual R2 orphan recovery, physical quota and committed-stage protection.
- Targeted races cover revocation between prepare and batch, stale epochs, cancellation, old lease tokens, failed writes, exact input reuse, retained-file fences and concurrent export watermarks.
- The new Chromium source journey covers manual selection/import, literal hostile content, exact history/digests, explicit contextual evidence and owner isolation. It is written but has not yet run in cloud CI at this checkpoint.

## Remaining activation and release gates

The supported Sites eligibility discovery tool is unavailable in this runtime. Authoring GitHub access does not establish hosted connector eligibility or visitor consent. GitHub/document automatic reads remain unsupported until exact eligible read actions and selected-resource consent are verified. Automatic conversation refresh has no verified supported server API.

No renewable production principal, private ingress request, installed scheduler or browser-closed provider run has been proved. The separate application service-token route does not alter private Sites ingress and defaults to unsupported without a server-owned adapter. No schedule or paid inference is activated.

The existing private Site identity and access remain unchanged. This verification uses isolated synthetic data and actual local cloud emulation; it does not claim a new hosted release, production R2 acceptance or physical-device execution. Final publication requires the complete source/type/lint/build/HTTP/browser gates and terminal deployment evidence.

## Cloud follow-up

CI39151986196 at `7ca20391a067b38312f1b97985ca1fba5512c162` passed the clean locked install,978 Node tests,typecheck/lint/build and all actual D1/R2 gates.42 of43 default Chromium and all3 R2 Chromium passed. The new source test stalled on an exact nested-label select lookup despite a visible enabled accessible combobox; exact combobox locators replace that lookup. A separate final HTTP fixture timed out after its baseline smoke. The timeout was not conclusively reproduced locally. The follow-up consumes client response bodies, settles unused bounded POST bodies before rejection responses, and emits sanitized request-stage diagnostics.979 Node tests and the rebuilt36-request HTTP fixture pass without retries; cloud rerun remains required. Confirmed evidence saves clear their draft state, and confirmed manual imports refresh the root workspace revision before further owner commands.
