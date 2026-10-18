# Draft and recovery privacy

Reconciled against the foundation implementation on 18 October 2026. These records are private owner data. Public application source does not make a hosted workspace, draft, backup or import public.

## Server drafts

Drafts are separate owner-scoped records. Saving one does not complete a task, accept evidence, commit a week, advance the workspace revision or authorize execution. Server saves set a 30-day expiry from the current server save time. Each draft is bounded to 64 KiB and each owner to 100 active drafts. Expired drafts are excluded from recovery; explicit expiry cleanup removes expired rows. Revision checks protect newer edits from an older save or deletion. A draft is acknowledged only after a confirmed committed command receipt, or an explicit discard, using its exact draft revision.

Draft JSON rejects named credential and executable authority fields. This validation does not guarantee that arbitrary user prose contains no private information. Do not place passwords, authentication tokens, device keys or execution grants in draft text or imported records.

## Trusted-device copies

Device storage is off and locked by default. Editor memory disappears when the page closes unless the owner saves a server draft or explicitly enables trusted-device copies. Unlock checks the current authenticated session and uses an opaque server-derived namespace. That namespace is not a sign-in token and is not included in portable draft exports. Reloading requires an explicit unlock and another session check; the app does not silently reopen IndexedDB.

Trusted-device copies are separate from server drafts. Recovery chooses a version for review; versions are not silently merged. Device storage is bounded to 100 records and 8 MB, excludes expired drafts on opening, and rejects replay of an expired draft. A storage error preserves the available in-memory draft but cannot be described as a successful durable save.

Session expiry hides private content immediately, fences pending callbacks and triggers forget/lock handling. Explicit Forget locks first, waits for pending local work, broadcasts invalidation and clears stored items for the opened owner namespace. Clearing failure is reported; retry before leaving a shared device. Cross-tab version checks and empty version tombstones prevent a stale tab from restoring cleared copies. Another tab receiving invalidation locks and requires fresh verification. These controls do not erase copies already downloaded or held outside the app.

Anyone with access to this browser profile, or code executing on the application's origin, may read IndexedDB data. A JavaScript-held encryption key would not provide protection from that access. Browser eviction, device loss or profile deletion can remove local drafts. Operating-system encryption is useful but is not an application recovery guarantee.

## Replay, exports and imports

Queueing and replay require explicit actions; reconnecting never submits edits. Replay checks the original stable mutation ID before sending its exact retained command. Unknown or unreadable outcomes remain uncertain. A retired epoch is not permission to retry. Reopened interrupted sends remain uncertain for review.

Portable exports contain user draft/workspace data, not authentication tokens, credential stores, executable approvals or receipt authority. Audit actor metadata uses the semantic pseudonym `owner`; historical actor claims do not establish current authority. User-authored strings remain private user data even after metadata filtering. Keep downloaded files in an appropriate private location.

Quarantined imports and repair reports may contain invalid or excluded private records. They remain separate from active planning. Durable staging retains at most eight stages and 20,000,000 raw-content bytes per owner, with an 8,000,000-byte input limit and one-hour expiry per stage. Repairs create a child stage and preserve the source until its own expiry or explicit discard. Download the source or report before that deadline if needed. Diagnostics contain bounded path/code data rather than raw invalid text; attached repair reports deliberately retain selected record content.

## Verification boundary

Synthetic SQLite, injected storage, browser-fixture and cross-tab tests establish the implemented checks only. They do not verify real hosted gateway identity-header handling, origin-bypass protection, provider consent, unattended service identity, native-device privacy or physical-device recovery. Preserve private hosted access while performing those acceptance checks. See [recovery.md](recovery.md) for backup limits, recovery steps and activation requirements.
