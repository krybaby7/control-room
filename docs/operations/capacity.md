# Capacity and performance

These are current source-format and admission bounds, not platform billing limits or a hosted SLA. Exact UTF-8 serializers, expanded SQL projections, owner row sets and operational vectors are measured before mutation and rechecked atomically. No history, receipt, staged original or unknown effect is silently pruned to fit.

## Storage bounds

| Boundary | Current limit |
| --- | --- |
| Ordinary complete portable JSON | 8,000,000 bytes and bounded 10,000-row collections; the tighter prospective D1 recovery bundle/SQL argument bounds also apply |
| Prospective D1 backup bundle and individual measured SQL arguments | 1,800,000 bytes each, including wrappers/escaping/typed projections |
| D1 metadata snapshots and file backups | 10 snapshots; shared 20,000,000-byte owner backup quota; retained unpurged chunks stay charged |
| Ordinary ready attachment policy | 20 MiB per file; 200 MiB/500 files per owner; separate reservations/physical retained generations remain accounted |
| JSON import staging | 8 stages, 20,000,000 raw bytes per owner, 8,000,000 bytes per stage, one-hour server TTL |
| Protected server drafts | 100 active, 64 KiB each, server-derived retention up to 30 days |
| Mutation receipts | Soft warning 75,000; hard ceiling 100,000; finite revocation/cancellation reservations can block ordinary growth earlier |
| Private recovery profile | 64 MiB; 200,000 rows globally; 100,000 per private table, including the closed 46-table profile and separately charged native removal fences |
| Inactive target inventory | 128 MiB and 300,000 application rows; distinct from the private-profile limit |
| Agent prompt, execution and ordinary result | Input plus artifacts ≤32 KiB; timeout ≤600 seconds; output ≤2 MiB, with tighter local policy allowed |
| Attempt artifact package | ≤100 files/10 MiB total; transcript ≤2 MiB, with per-attempt physical binding |

Native file ZIP staging and segmented operator recovery use separate bounded formats; they do not raise ordinary JSON or D1 argument limits. See [backup/restore](backup-restore.md) and [recovery maintenance](recovery-maintenance.md). Unsupported schema/defaults or a larger owner are explicitly refused; use an engineering/operator handoff, not truncation.

## Capacity refusal

The owner can inspect `GET /api/workspace/usage` for logical payload/metadata counts and current declared limits. This report excludes SQLite indexes/page overhead and is not a provider invoice or a complete physical-storage proof. Inspect attachment/backup manifests and retained generations separately. A failed read means unknown usage.

At refusal, retain the original command/draft and reconcile an uncertain mutation before a new submission. Export through the bounded supported path. Guarded removal may be available only after a newer verified complete recovery point and reference checks. Do not delete receipts, retire epochs automatically, clear unknown attempts, purge pending PUT tokens or claim quota credit for an unconfirmed delete. Legacy receipts and retired epoch tombstones remain rejecting.

Private admission reserves active agent event/terminal headroom and finite pending-PUT settlement space before growth. Other covered writers must leave those reservations intact. This finite reservation does not imply an installed runtime or funded paid-analysis terminal result; paid providers remain disabled by default.

## Performance and operational checks

Controlled warm-fixture targets remain p95 workspace read ≤1.5 seconds, normal save ≤2 seconds, mobile first usable screen ≤3 seconds and no normal interactive main-thread task >200 ms. Run the actual isolated benchmark with `npm run test:benchmark`; use the exact workflow's documented options for diagnostic profiles. Preserve source SHA, environment, raw timings and concurrent-session outcomes. Do not raise budgets or compare a diagnostic profile/developer laptop to hosted acceptance.

The last measured normal D1 save results before the current batching candidate exceeded the unchanged two-second target. Current-source optimizations and all final gates still require their own terminal measurements. Historical passing tests do not establish current performance.

Use owner-authenticated reads of storage usage, verified backup age/completeness, source last-success age and job detail/run history for triage. Read-only checks do not create an alert. Synthetic alerts belong only in the isolated fixture; no real recipient, push subscription, paid request or provider is activated by this runbook. The operator must verify current platform quotas/billing and define an explicitly authorized aggregate-only alert/delivery path before enabling it.


## Owner-only operational health

`GET /api/health` is a private, read-only aggregate view with no query parameters. It reports logical storage, recorded READY backup catalog age/coverage, current-epoch due-job age using not_before, and selected-source recorded success age against each configured stale threshold. Inconsistent clocks or configuration remain unknown. File coverage requires matching catalog SHA and exact metadata content; fresh R2 byte readback is explicitly not performed.

Warning conditions are returned as data with external delivery disabled and no readiness guarantee. They never send notifications, accept work, change a schedule, complete a task or authorize execution. Native synthetic alert-condition tests are distinct from real private hosted monitoring and delivery acceptance.
