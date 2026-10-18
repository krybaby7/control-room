# Foundation contracts

The integrator owns shared types, schema migrations, production transaction compilation and release packaging. Leaf workers must not edit these contracts without coordination.

- Server-derived owner identity is a required function argument. No command, provider payload or import can supply current authority.
- Owner mutations use one transaction executor. Legacy HTTP requests adapt to protocol version 1; semantic command hashes exclude expectedRevision. Replays return current authoritative state plus the original applied revision.
- A receipt claim, all module row assertions, audit events, job intents and planning CAS commit atomically. Conditional zero-row writes are not errors: required row versions/hashes use SQL CHECK assertions, and every write is gated by the same transient claim. Remove the claim before commit. Failed assertions roll back receipts and all side effects.
- Closed module registries define identifiers, key and value columns, validation and export policy; handlers cannot supply SQL or owner predicates. Reads are bounded and owner-scoped.
- Planning schemas migrate v1 to v2 to v3, preserving IDs, saved timestamps and archive/weekly history. Canonical compact storage measures user content separately from generated metadata. The later planning phase introduces v4.
- Export bundles have independent planning/module versions and operational watermarks. Unknown modules fail closed. Credentials, executable approvals, receipt authority and device keys are never importable.
- Immutable history is distinct from the bounded activity projection. Operational telemetry/cursors/leases use separate CAS domains and cannot confer owner approval.
- Imports and analysis produce proposals; completion, acceptance, weekly commitment and execution authorization require explicit owner commands. Paid inference and operational effects remain disabled.

Independent architecture review: explicit model=gpt-6.1-sol accepted for worker /root/foundation_review. Review highlighted zero-row CAS, export snapshot races and avoiding a second production mutation path.
