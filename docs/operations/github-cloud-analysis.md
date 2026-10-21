# Analyze a GitHub project through Codex Cloud

Open **AI project analysis** in Control Room and choose **Codex Cloud**. This uses your eligible Codex subscription through a manual handoff. Your PC can be off while the cloud task runs.

1. Enter a bare HTTPS GitHub repository URL, or choose a repository already linked to a workspace project.
2. Choose its existing project or enter a new project name. Preparing a prompt does not create the project.
3. Select **Prepare Codex Cloud prompt**, then copy or download the prompt.
4. Select **Open Codex Cloud**. Connect GitHub there if prompted, select the matching repository/cloud environment and `gpt-6.1-sol`, then paste the prompt into a cloud task.
5. Download the completed `control-room-github-analysis.json` artifact, or copy the complete plain JSON fallback without Markdown fences.
6. Return to Control Room and import the file or use **Paste Codex Cloud report JSON**. Review the report and select **Save reviewed report**.

The first save creates a new project, links its repository and stores its report in one transaction. A refresh appends a report version to the existing project understanding. Suggested tasks remain separate proposals until individually reviewed. The saved report is available after reloading Control Room and is included in evidence exports and recovery.

GitHub account connection, live repository browsing and task execution happen in Codex Cloud. Control Room accepts a URL and saved workspace links; it does not claim its own live GitHub connection or launch a cloud task automatically. The handoff does not enable an API provider or separate API billing. Codex subscription allowances still apply.

## Return later or recover a save

You can close Control Room while Codex Cloud works. To return in a fresh browser, choose the same destination project and import the completed report. The report includes its repository, pinned source commit and original request identity. A panel that still has a prepared request rejects a report for a different request or repository; discard that unsaved draft before intentionally importing another one.

If saving is interrupted, keep the panel and report. Refresh saved reports to check the original outcome, then use **Retry original save** if needed. This retains the original command and submission identity. It does not rerun analysis or create a second project. A report already saved with the same run identity and contents is recognized. The same run identity with different contents is rejected.

Imported reports are unsigned claims supplied by the cloud task. Validation checks format, size, repository identity and internal source citations. It does not independently verify the model, source file bytes, factual correctness or whether tests were run. The report records the full source commit and exact cited paths, lines and SHA-256 values for owner review.

## Use the PC instead

Choose **This PC** to use the existing paired local companion and installed Codex subscription. Register a local checkout through the helper, then analyze it and save or import its report. That mode requires the PC/helper and can include eligible uncommitted working files. Cloud reports describe committed GitHub source and have separate provenance.

Official setup: [Codex Cloud](https://learn.chatgpt.com/docs/cloud).
