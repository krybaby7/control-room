# Personal repository analysis

Open **Repositories → This PC**. The background PC app uses the existing Codex and Claude Code subscription sign-ins.

1. Choose **Choose folder** and select a local Git repository in the Windows dialog.
2. Select **Codex** or **Claude Code**, and the project where its report belongs.
3. Select **Analyze**. The completed report saves to that project automatically.
4. Use **Analyze latest changes** to refresh a saved repository. It includes current tracked changes and safe untracked files within the bounded snapshot.

The app starts when the Windows user signs in. The PC must remain on and signed in during folder selection and analysis. Keep the owner dashboard open to save completed reports immediately; if it is closed, the report waits securely and saves when the dashboard is reopened. **Open Control Room on this PC** starts the app if it is offline. Routine use requires no port, pairing code, connection test or report import.

Each explicit analysis starts one finite provider CLI run. Codex requests `gpt-6.1-sol`; Claude preserves only the validated personal model selection or its subscription default. There is no automatic provider fallback, API-key fallback or whole-run AI retry. Both use a bounded source pack, tools disabled, and a small selection of recent matching local chat context. Cloud conversation histories are not connected. Reading chat text inside the model input consumes tokens; the local selection step does not call another model.

Architecture paths must exist in the supplied file inventory. Line findings additionally require the exact inspected excerpt, line range and file digest. Reports state their partial coverage; they do not establish that tests were run. Suggested tasks require review before entering the plan.

Reports and delivery receipts survive restart. A network failure retries delivery, never inference. If saving is uncertain, retry the retained report save; it keeps the original command identity and does not analyze again. Private reports remain on the PC as well as in saved project evidence.

Connection credentials are protected with Windows CurrentUser DPAPI and a user/SYSTEM directory ACL. Only the narrow device route accepts the device key; it cannot create owner analysis requests or write evidence. Exported connection state contains no credentials and restores disconnected with unfinished requests marked interrupted. Heartbeats are operational metadata and do not change portable workspace revisions.

The existing **Codex Cloud** GitHub handoff remains available alongside this PC workflow. Other operational pages remain under **More details**.
