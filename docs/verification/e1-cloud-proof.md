# E1 cloud verification workflow

Application source is `e1ffdf0ebbaf9355bc5377a7dc22fa7bb5b9b58e`, tree `3c050f1bfbf522c2dbe93830df598a7f60c88527`. This diagnostic branch adds verification tooling; its own workflow commit is not the application candidate. It performs no merge, deployment, provider execution or owner-device acceptance.

The pinned candidate, bridge and native Windows helper ZIPs come from successful workflows at that exact source. The inspector checks their outer digests, all source bytes against Git, build and bridge inventories, helper source/digest binding and eight rejecting negative controls. It neither executes archive code nor claims compiler reproducibility.

The strict ledger helper checks out the application commit and invokes its unchanged release recorder. Eleven cloud checks must have actual successful source/run/latest-attempt/job/step/artifact provenance. Hosted-private and owner-device checks remain owner-dependent. The original recorder result, including its initial implementation marker and four blockers, is preserved byte-for-byte.

Only after the actual inspector and strict ledger steps succeed may the integrator-authored cloud implementation audit apply. The annotation changes only `phases.implementation` under the unchanged schema, preserves all checks and artifact evidence, and invokes the same strict verifier again. Release acceptance must remain false with hosted-private acceptance, owner-device acceptance and hosted acceptance blocked. Before/after status digests and both verifier results are retained. Audit/report hashes derived in the job are labeled as runtime-derived, not independent pre-run pins.

Actual terminal workflow results and generated reports belong in the separate sanitized evidence checkpoint. A prepared input or this workflow description is not a passing result. The historical 772 and 764 failed canonical/performance evidence remains retained; diagnostic passes do not replace those failures.
