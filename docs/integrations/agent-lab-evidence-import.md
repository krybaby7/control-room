# Explicit Agent Lab evidence import

This is read-only historical evidence preparation. The actual private upstream wire interface was inspected through authorized read-only source access; no private source, repository identity, source pins, paths or run records are published in this repository. All committed examples are synthetic. No provider, model, evaluation queue or service is invoked by this procedure.

## Select and project locally

Use a privately held run-summary JSON export, or a manually assembled `{version,runs}` envelope of selected run-summary objects. Do not export raw Lab state: it contains token and provider/account fields that are not needed. The projection discards unknown extras, private executable/auth fields, output/transcripts, error prose, review notes and Markdown. Accepted metadata fields undergo a credential-pattern refusal check before printing. This is bounded defense in depth, not a guarantee that arbitrary metadata is secret-free.

From the unpacked bridge package:

```sh
node src/agent-lab-import.mjs --input ABSOLUTE_SELECTED_JSON --kind summary --instance OWNER_CHOSEN_ALIAS --run SELECTED_RUN_ID
```

Repeat `--run` for explicit selections (maximum 200). A single run object uses `--kind run --version SOURCE_VERSION` and its explicit `--run`. A typed aggregate report uses `--kind report` with no run selection. Inputs are regular local files only, at most 256 KiB, with bounded JSON depth/nodes; symlinked final files, relative/remote paths, malformed UTF-8 and oversize output are refused. The final printed projection and any upload body are each at most 64 KiB; a valid larger input is refused without truncation or partial export. No source file is edited or deleted. The command prints only the bounded projection; keep that output private and review it before any delivery.

The result's `upload` member, when present, is the exact normalized body for the existing private `/api/bridge/evaluations` boundary. The complete local review wrapper is not an upload body. There is no automatic upload/retry, credential lookup, state/token fetch, approval or acceptance. Delivery still requires separately enrolled `evaluations:write` device scope and verified supported private ingress; these remain unavailable by default. Do not bypass that boundary with browser cookies or fabricated owner headers.

## Interpret the claims

A source graded status of passed maps to the legacy completed status only while preserving its original `sourceStatus`. Optional `objective` records source-reported assessability, pass/fail, numeric score and passed/total checks. An execution failure without grading remains unassessed. Report-level assessable/pass denominators, all attempt statuses, human review and model-verification counts stay separate; aggregate counts cannot create per-run evidence or prove a matching cohort when identity is incomplete.

Human acceptance is a source review, not Control Room owner task acceptance. Claimed observed model identity is not a server observation of a provider. Usage and dollar costs stay unknown when their concrete wire semantics are not verified; no savings/readiness recommendation is inferred. `sourceInputSha256` is a local digest claim over original selected input, never a server-verified original or private authentication proof. Original private inputs remain owner-controlled.

Legacy imported observations omit the new optional fields without materialized defaults, retaining their existing canonical bodies/hashes. Corrections append a new immutable outcome; they never replace earlier evidence or grant execution. The UI labels source-reported objective facts separately from human/model claims.

The separate production runtime still reports not_installed. Runtime-package extraction/registration and Windows sandbox/owned-process integration remain missing work, followed by actual installation/provider acceptance. See [runtime handoff](agent-lab-runtime-handoff.md) and [agent execution](../operations/agent-execution.md).

Authored checks: `node --test bridge/test/agent-lab.test.mjs bridge/test/agent-lab-import.test.mjs` and `node --experimental-strip-types --test tests/evaluation-import.test.ts`. They use synthetic input/fake loopback only. Their current-source execution must be recorded from actual CI; source authorship is not a pass or actual-run claim.
