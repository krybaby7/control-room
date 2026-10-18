# Start Control Room Implementation in the Cloud

Use the owner-specified repository: **https://github.com/krybaby7/control-room**. Select or create a cloud environment for that repository, or clone it into a supported cloud task. Read root `AGENTS.md` and `docs/source-import.json` before implementation. The owner explicitly approved making this application source and plan public on 18 October 2026; the hosted application and its owner data must remain private.

The previously supplied `control-room-cloud-handoff.zip` is an optional fallback with `source/`, `SOURCE-MANIFEST.json` and a launch guide. It predates the GitHub handoff instructions; prefer the current repository for those instructions. If using the archive, validate extraction paths and hashes, compare with the current repository, and never overwrite newer work. No Windows runtime, installed dependencies, private workspace export or credentials are included.

The original GitHub repository contained only `README.md` at commit `b5a9b9daa6d2c6f265b383a837dc946e395f27d3`. The application import preserves that history. Audited source SHA `b50aa5c34783ffc0109c46d91c599923df9cc305` belongs to the earlier local/Sites history; it is a provenance identifier, not a ref to check out in this repository. Use supported Sites source access when publishing. Creating an unrelated repository or changing the Site audience is not part of bootstrap.

## Copy this prompt into the cloud task

```text
Implement the Control Room completion plan in https://github.com/krybaby7/control-room.
Clone or use that repository's current checkout and create an implementation branch.

Start by reading root AGENTS.md, docs/source-import.json, and:
docs/superpowers/plans/2026-10-18-control-room-completion/00-master-plan.md
docs/superpowers/plans/2026-10-18-control-room-completion/09-gap-coverage.md
docs/superpowers/plans/2026-10-18-control-room-completion/progress.json

The baseline is the private Control Room v2 application at source commit
b50aa5c34783ffc0109c46d91c599923df9cc305. That SHA identifies the earlier
local/Sites source and need not exist in the new GitHub history. The repository
import includes later planning documents, not implementations of those phases.

Verify import provenance and inspect the actual cloud environment. Follow
the installed cloud-environment and Sites skills where available. Preserve
the existing project_id in .openai/hosting.json and the owner's private access.
Do not create a replacement Site, reset existing data or invent a Git remote.

Use exactly gpt-6.1-sol for implementation and review workers. Select the model
through the supported runtime/agent parameter and record the accepted request and
worker ID. A successful explicit model selection is sufficient configuration
evidence; do not require unavailable resolved-model telemetry or self-identification.
A prompt mention alone is insufficient. If the model request is rejected or the
runtime cannot select it, stop before implementation and report that exact blocker.
Execute Phases 0–8 in dependency order. Delegate bounded parallel tasks and keep
one integrator responsible for shared types,
migrations and release packaging. Make reviewable commits, run meaningful
regressions and phase acceptance checks, and keep progress.json and the gap
ledger current. Push reviewable implementation branches and create draft PRs when
GitHub write access is available; do not merge them automatically. Continue
independent work when a provider or Windows-only
acceptance check is blocked; do not stop after each routine implementation step.

Preserve all owner records and original IDs. Imports and model outputs produce
reviewable proposals, not automatic acceptance, completion or weekly commitments.
Use isolated synthetic data for destructive/recovery and failure-injection tests.

Finish code, fixtures, adapters, docs and automated checks for every feasible
phase. Do not claim that mocks, a passing build or a saved schedule prove live
provider/device execution. Reconcile every gap with evidence and label external
connection/installation/consent requirements precisely.

Use the supported private Sites publishing workflow for coherent releases only
after their validation gates pass and deployment access is available. Confirm
the terminal deployment result and the actual source/version identity. If the
environment lacks deployment access, deliver the verified source/package and
exact handoff instead of claiming publication.

Keep paid inference disabled until an exact provider/model and spending budget
are configured. Keep operational/trading effects disabled unless separately
authorized. Do not expose an arbitrary remote shell or weaken private access to
make a connector work. Build the Windows bridge locally installable package;
record real Windows/device acceptance as a local follow-up when inaccessible.

At each interruption or context limit, save an accurate checkpoint including
current commit, tests, unfinished tasks, known failures and the next command.
Finish with a phase-by-phase result, exact verification evidence, a reconciled
gap ledger, the private deployed URL if actually deployed, and any remaining
owner/provider/local actions.
```

## What the cloud needs

| Need | Why | If absent |
|---|---|---|
| Node 24 and allowed package access | Existing SQLite tests and locked dependency install | Resolve environment setup; preserve the lockfile |
| GitHub repository checkout | Application source and plan | Use the verified archive fallback; never depend on local C: paths |
| Supported browser QA | Real UI and failure/recovery checks | Complete independent tests, record browser gap |
| Sites ownership/source/deployment access | Publish existing private application and provision D1/R2 | Build/package locally in cloud; leave deployment pending |
| Eligible source connection or scoped service identity | Real repository/document reads and unattended refresh | Finish fixtures/adapters; show disconnected, not simulated live data |
| Renewable background principal/scheduler | Closed-browser backups, sync and reviews | Leave schedules inactive until one real fresh-runner execution passes |
| Windows PC access during local acceptance | Collector/executor installation and real telemetry | Produce local installation handoff and tests; don't claim Windows acceptance |
| Exact model/provider plus budget | Optional AI briefs and agent jobs | Keep disabled and use deterministic briefs/fixture tests |
| Owner passkey and selected physical devices | Hosted sign-in and real device acceptance | Record a precise owner action at the final relevant gate |

Do not paste secrets into this prompt or the plan. Use the environment's supported secret/identity configuration. Connection availability must be checked inside the new cloud task; this local task's tools and browser session are not inherited automatically.

## Manual launch if automatic cloud creation is unavailable

In the desktop/web app, start a new task, choose **Work in > Cloud**, then select or create an environment for `krybaby7/control-room`. Ask setup to use Node 24 and `npm run install:ci`, preserve the lockfile, and run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`. Publish the tested environment, start a new task, select GPT-6.1 Sol where the model control is available, and paste the prompt above. Request exact-model subagents explicitly; do not confuse multiple independent attempts with collaborating agents.

Current official instructions: [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments) and [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents). Account controls and runtime availability must be verified in the new task. Personal local skills and signed-in desktop services do not automatically transfer to a cloud environment.

## Resume prompt

```text
Resume the Control Room completion program from its existing checkout and
docs/superpowers/plans/2026-10-18-control-room-completion/progress.json.
Read the latest verification record and git status before changing anything.
Continue the next incomplete phase without redoing verified unchanged work.
Preserve all current edits and apply the original cloud execution constraints.
```
