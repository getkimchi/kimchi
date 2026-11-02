# Inspect running Bash commands

While managed Bash commands run, the footer shows `1 shell` / `N shells` at the right end of the status line, after the agent count; it disappears when none run. Hide it in **/customize-status-line**. The active-agent count follows the same rule: it shows only while agents run.

Run **`/processes`** while Kimchi is executing a managed Bash command. It replaces the input with a full-width menu, with the conversation visible above. Select a command and press **Enter** to inspect it. Closing restores the input without replaying conversation history.

The list shows one row per process: its purpose (or command when no purpose was provided), status and elapsed time. It grows as processes start, up to half the terminal height. In fullscreen mode, click a row to inspect it, then click **Script** or **Output** to switch views. The text cursor stays hidden while inspecting.

Entering a command sizes its detail view from the script/output available then, up to half the terminal height (minimum nine rows when space permits). Detail height stays fixed during streaming and tab changes; entering it again recalculates.

| Key | Action |
| --- | --- |
| Up / Down | Select a command or scroll the detail view |
| Enter | Open the selected command |
| Tab | Switch between Script and Output |
| Page Up / Page Down | Scroll the script or output |
| End | Follow the latest output |
| Escape / q | Return to the list, then close |
| Ctrl+C | Close the inspector without cancelling the command |

**Script** shows the submitted command, including multiline scripts and heredocs. If the command invokes a file, such as `bash script.sh`, the view shows that invocation; it does not snapshot the file's contents.

**Output** shows a bounded tail that updates while the command runs. Scrolling turns following off; End resumes it. The panel identifies omitted output and distinguishes no output yet from the age of the last output. Silence does not necessarily mean the command is stuck.

The conversation shows one Bash header with its purpose, or the command when no purpose was provided. A status dot and branched result match the other native tools. The result shows status, elapsed time and recent output. **Ctrl+O** reveals the full submitted script, command handle, output age and a larger running-output preview. Completed results retain ordinary Bash output expansion, truncation notices and saved-output paths. After the one-time handoff, the original card continues updating until the process exits. Cohort control calls show their consolidated results separately.

Opening and closing the inspector does not stop the command, extend its deadline or ask the model another question. A selected command's final output remains readable if it exits while the inspector is open. Escape closes the inspector; it does not cancel the running command.

This view covers managed Bash commands in the current session. Direct `!` shell commands, daemons, commands in worker sessions and unrelated operating-system processes have separate lifecycles. Managed Bash commands stop when the session shuts down.

Compound command approval shows the original script, including quoting. **Allow all for this session** appears only when every required permission can be remembered. Scripts that cannot be safely represented by reusable rules explain that they need approval each time and offer **Run all (once)**.

## Handoff and output logs

A managed Bash command returns a normal result if it finishes within **15 seconds**. Trace data put this threshold where most tests and builds still return directly: about 90% of commands finish within 15s. A command still running at 15s hands off: the agent gets a handle, and the command continues in the background. In interactive sessions, a queued user message hands the command off early, once it has run for at least 2 seconds.

Inline output is bounded to the last **200 lines or 8 KB**. The complete output is written to a log file (`$TMPDIR/kimchi-bash-*.log`):

- **Quick commands** create a log only when their output exceeds the inline budget. The truncated result names the log.
- **Backgrounded commands** always have a log, started at handoff. The log holds every byte from the start, and output keeps appending to it while the command runs. The handoff result, `bash_control` inspections and the exit result name it.

Because long output is bounded and kept, the agent does not need to pipe through `head`/`tail`. It greps the log instead of re-running a command to see a different part of the output. To be woken when specific output appears, it runs a watcher as its own command:

```bash
until grep -qE "Ready|ERROR|Traceback" /tmp/kimchi-bash-….log; do sleep 1; done
```

The watcher's exit is delivered like any other exit result. Include failure patterns in the search, or a crash looks like waiting. Logs are deleted when the session shuts down.

E2E rigs shorten the handoff with `KIMCHI_E2E_BASH_HANDOFF_SECONDS` (honored only inside test harnesses). The TUI and ACP e2e fixtures set it to 2.

## Interactive sessions and user messages

Interactive sessions — the TUI and ACP/IDE integrations — treat the user as present:

- A user message queued while a `bash_control(wait: true)` call is waiting releases the wait immediately. The wait returns a distinct `user-input` result with the current cohort evidence — nothing is stopped and no checkpoint is counted — and the agent handles the message. Exit results still arrive on their own afterwards.
- A chat turn may end while managed commands keep running. The harness does not force the agent back into a wait or a stop for them: their exit results arrive as automatic notifications, and each one wakes an idle agent.
- The agent loop's own message semantics are untouched — the harness never dequeues, rewrites, or drops a queued user message, and steering and explicit follow-ups keep their existing ordering.

Headless runs (`--print`, JSON output) and agent workers keep the stricter completion guard: a task cannot finish while managed work lacks a disposition, so a run that tries to end with live commands or undelivered outcomes receives a continuation reminder directing it to wait or stop. Cancellation behavior, the absolute process safety limit, per-session isolation, and session-shutdown cleanup are identical on both surfaces.

## For tool authors

The Bash tool accepts an optional short `description` alongside `command`. The description states purpose; expand the card to see the command. No extra model call is used to generate labels.

`bash_control` remains the model-facing tool name. `wait` is optional and defaults to an immediate inspection: use `wait: true` to wait for an exit or a bounded checkpoint, and omit it (or pass `wait: false`) to inspect. In interactive sessions, a queued user message also releases an active wait — the result reports the release with current cohort evidence and the processes keep running. An optional `handles` list restricts an immediate inspection to the selected commands — only their new output and evidence is returned, unselected commands keep running with their output cursors untouched, and unknown handles are reported individually. `stop_handles` stops selected commands independently of the filter, and a stop-only call needs no `wait`. Commands continue by default, and while any command runs, conflicting write/execute calls receive one concurrency advisory per session. The harness owns the absolute safety limit (`--bash-process-limit`); legacy `timeout`, `checkin_interval`, and `extend_seconds` inputs are accepted and ignored.

Automatic exit results arrive as one compact notification per delivery boundary: exits landing within a short window of each other batch into a single message that carries every terminal result, error, and output. A notice reports only what ended — cohort status belongs to inspection — and an outcome reads as pending until its notification has been acknowledged in the conversation.

See the [design research](research/bash-visibility.md) for the prior behavior, alternatives and integration rationale.
