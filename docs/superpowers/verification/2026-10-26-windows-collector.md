# Windows collector repair verification — 2026-10-26

Windows PowerShell could not autoload `Microsoft.PowerShell.Security` when invoked by Node under PowerShell 7. Node inherited PowerShell 7's module path, so Windows PowerShell 5.1 selected an incompatible Security module and reported duplicate ObjectSecurity type members. Direct native imports and Get-Acl succeeded in Windows PowerShell 5.1 and PowerShell 7; the Windows module manifest was present and the Security assembly signature was valid. Execution policy was not the cause. No Windows system-file or policy repair was performed.

The collector now starts a fixed native PowerShell helper with a child-only native module path. A run-local scope owns one process and sends bounded literal-path requests, preserving the existing ACL policy at every read without caching permission results. Exact reply identities, strict UTF-8/JSON, finite queues and deadlines, abnormal exits, late output and shutdown are checked. Separate collector runs own separate helpers, and final status completes before helper disposal.

Two additional Windows defects were exposed during verification: integration fixtures needed actual private DACLs because mode 0700 does not remove inherited Windows permissions, and the collector's native named-pipe path lacked its namespace dot. The synthetic fixtures now establish current-user-only permissions; the native pipe namespace is corrected. Tests cover contention, separate state directories, normal release and process-death release. The private-path policy itself is unchanged.

Repeated PowerShell startup caused the existing large integration test to exceed its unchanged 120-second deadline. Measurements attributed over 99% of small-fixture runtime to fresh PowerShell children. Reusing one restricted process preserves every check and allowed the 251-message repeated-import case to complete in 69.93 seconds.

Verification on Node 24.14.1 and the owner's Windows PC:

- Helper/protocol/native ACL suite: 22 passed, including permission changes between checks, malformed/late output, child failure, cancellation, deadline and cleanup cases.
- `tests/history-collector-integration.test.ts`: 4 passed with existing deadlines unchanged; large repeated import 69.93 seconds and credential-revocation behavior passed.
- Deterministic collector package fixture: passed with its temporary Git repository's EOL conversion disabled. The archive's committed-byte guard remains unchanged. Production release packaging uses a clean checkout of the committed LF bytes, without changing global Git settings.
- Typecheck passed; lint had zero errors and 17 existing warnings; diff checks passed.
- Independent review found no remaining blocking issue after lifecycle and test-cleanup corrections.

These are source and synthetic/native collector checks. Private Site publication, updated companion installation and a real refreshed briefing are subsequent release gates and are not claimed by this record. Paid API inference and trading effects remain disabled.
