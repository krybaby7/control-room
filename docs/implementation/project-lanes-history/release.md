# Project lanes/history release handoff

Draft source review: https://github.com/krybaby7/control-room/pull/5. Preserve its existing PR stack. Do not merge or deploy this candidate until final checks and the separate private cutover prerequisites are satisfied.

The source implements default Project lanes, explicit task area/work-type context, retained history records and private objects, durable bounded collection/sync, guarded analysis proposals, continuing area stories, roadmap/checkpoint owner decisions, and truthful incomplete coverage. Current exact-candidate checks and live gates are recorded in [acceptance.md](acceptance.md) and the new plan's `progress.json`; historical passes must not be substituted for final candidate results.

Before publication, obtain a complete verified private backup of metadata and all referenced private byte objects, with a tested compatible restore manifest. Standard metadata export and the bounded offline selected-history package are not a complete backup claim. Retain the existing private Site identity, owner IDs and access policy. Never reset production or replace the Site. No destructive production recovery test is authorized.

Use the installed supported Sites workflow only after actual deployment access and prerequisites are available. Package the exact validated source and retain its commit/tree and archive digest. Apply only reviewed forward migrations to the existing private Site; confirm terminal deployment result, source/version identity and owner record preservation. Test owner access and an unrelated identity's denied access. Keep provider/scheduler/collector service endpoints closed until independent private ingress and exact scoped principals are registered. A visitor cookie is not service ingress authority.

If publication remains unavailable, hand off the exact source archive/digests and validation matrix to the authorized Site operator. Do not claim a private deployed URL from an existing address or build output. Capture a sanitized deployment/version record only after actual successful publication.

For rollback, retain the previous validated source/package and backup manifest. Assess schema compatibility before a code rollback; added retained history/native authority records must not be deleted to make old code run. Pause collector/scheduled analysis while boundaries are unresolved. A production restore requires a separate reviewed cutover procedure that preserves owner state and active epoch/receipt authority.

On Windows, follow `collector/README.md` and `docs/implementation/project-lanes-history/collector-operations.md` for the packaged collector's supported commands, enrollment and scheduled operation. Run real-device acceptance locally; Linux tests cannot verify DPAPI, Windows ACLs, named pipes, Task Scheduler or continued operation after desktop closure. Local roots and credentials remain private.

Owner walkthrough: open Project lanes, expand an area to inspect finished/open/next and roadmap criteria, open the cited retained text, then explicitly accept/reopen/correct only supported owner commands. Use connection coverage to distinguish discovered content, missing bytes, pending catch-up, unverified capability and unavailable inference. Imported or model-produced text never accepts itself or creates a weekly commitment.
