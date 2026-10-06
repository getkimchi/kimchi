# Inspect running Bash commands

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

## For tool authors

The Bash tool accepts an optional short `description` alongside `command`. The description states purpose; expand the card to see the command. No extra model call is used to generate labels.

`bash_control` remains the model-facing tool name. Use `wait: false` to inspect the cohort immediately, `wait: true` to wait for an exit or a bounded checkpoint, and `stop_handles` to stop selected commands. Commands continue by default. The harness owns the absolute safety limit (`--bash-process-limit`); legacy `timeout`, `checkin_interval`, and `extend_seconds` inputs are accepted and ignored.

See the [design research](research/bash-visibility.md) for the prior behavior, alternatives and integration rationale.
