# Inspect running Bash commands

Run **`/commands`** while Kimchi is executing a managed Bash command. It opens a menu in the input area beneath the conversation, like the other terminal menus. Select a command and press **Enter** to inspect it. Closing the menu restores the input. The menu sizes itself from the command count, script/output length and terminal size when opened, up to half the terminal height (minimum nine rows when space permits). It keeps that height as you switch views or output grows. Reopening recalculates the size; resizing the terminal adjusts it to fit.

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

The conversation also shows the command, its optional purpose, elapsed time and recent output. **Ctrl+O** expands the submitted script and a larger running-output preview. Completed results retain ordinary Bash output expansion, truncation notices and saved-output paths. A completed check-in remains labeled as a snapshot; it is not proof that the process finished. Later control calls refer to the same command identity.

Opening and closing the inspector does not stop the command, extend its deadline or ask the model another question. A selected command's final output remains readable if it exits while the inspector is open. Escape closes the inspector; it does not cancel the running command.

This view covers managed Bash commands in the current session. Direct `!` shell commands, daemons, commands in worker sessions and unrelated operating-system processes have separate lifecycles. Managed Bash commands stop when the session shuts down.

Compound command approval shows the original script, including quoting. **Allow all for this session** appears only when every required permission can be remembered. Scripts that cannot be safely represented by reusable rules explain that they need approval each time and offer **Run all (once)**.

## For tool authors

The Bash tool accepts an optional short `description` alongside `command`, `timeout` and `checkin_interval`. The description states purpose; the command remains visible as the source of truth. No extra model call is used to generate labels.

`bash_control` remains the model-facing tool name. Its `continue` action waits on an existing process; it does not resume a paused process or start a new script. Use `extend_seconds` to move the deadline separately from `checkin_interval`.

See the [design research](research/bash-visibility.md) for the prior behavior, alternatives and integration rationale.
