# Planning workflows — implementation checkpoint

18 October 2026. Phase 2 is in progress, not accepted or deployed.

The foundation source is published on the existing draft PR. Its final browser rerun at c9ba3744f8628b5b84b0841733979168fdb15f48 passed: CI39131486192,334 Node tests and all8 Chromium journeys. The preceding run verified source repair/merge and all draft/device journeys but used an incorrect final receipt-epoch assertion; operational execution epochs and mutation receipt namespaces are distinct.

Prepared schema v4 adds nullable project/milestone archive timestamps, unique per-project milestone ordering, and advisory integer task estimates. Migration clones the document and preserves IDs, status, dates, evidence, commitments and any accepted explicit ordering metadata. Only absent/generated defaults are filled. Null estimate/archive defaults and position-derived ordering can be omitted and hydrated; numeric estimates and nondefault ordering remain in content accounting. New-workspace seed changes do not reseed existing owners.

Authoring regression: 337 Node tests pass, zero failures/skips; typecheck and lint pass. Production build passed before the final explicit-order preservation correction; the final correction has targeted regression coverage; schema-specific cloud confirmation remains required. The real legacy 1,800-task fixture still migrates, exports, restores and accepts reducing edits. Historical raw fixtures remain old wire documents, rather than current documents merely relabelled with old versions.

Independent selector, graph and polling contracts are committed but not yet integrated into product workflows. Portfolio/move/bulk, weekly history, recurrence and accessible planning views are being prepared in bounded leaf files. No passing UI, weekly/recurrence storage or Phase 2 completion is claimed.

Resume with `git status --short`, inspect progress.json and active workers, then observe terminal foundation CI. Review and commit the schema slice before enabling dependent handlers, register actual normalized schemas with export/reference adapters, integrate UI, and run the chapter's domain, storage and browser acceptance checks. No private owner data, credentials or hosting identifiers belong in this checkpoint.
