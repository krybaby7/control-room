# Implementation decisions — 18 October 2026

1. Use the corrected model selection rule: accepted explicit runtime model parameter and returned worker ID provide configuration evidence. No inferred model identities.
2. Keep the rejected inspection commit local and outside the implementation history. The public delivery branch starts at corrected main. Since direct GitHub transport is restricted, deliver sanitized trees through the supported GitHub connector with corrected main as parent. Do not push local inspection history.
3. Preserve the hosting manifest and audience. Read-only native Sites inspection confirmed owner access and the existing active version. Deployment waits for coherent release gates.
4. All owner writes use one transient-claim transaction compiler. Required row CAS and source hashes use SQL CHECK assertions so zero-row updates cannot partially commit. Legacy receipt hashes remain replayable.
5. Do not enable normalized feature mutation handlers before their export/restore schemas exist. Until complete normalized restore lands, legacy planning-only restore rejects any populated normalized module. This preserves data instead of dropping modules.
6. Use compact planning v3 storage with separate content/metadata limits. Unknown schema fields still fail strict validation.
7. The locked installer remains unchanged despite network restrictions. Exact integrity-checked image-cache recovery makes independent checks feasible but is not proof of a clean install. CI repeats the real installer.
8. Browser/physical-device, live-provider, background-runner and R2 acceptance remain separate from unit/build evidence. No fake live state or automatic paid/operational effects.
