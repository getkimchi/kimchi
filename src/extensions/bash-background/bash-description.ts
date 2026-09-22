/**
 * The bash tool description, applied at registration time.
 *
 * Upstream's description snippet ("Execute bash commands (ls, grep, find,
 * etc.)") tells the model bash can do exactly the operations that have
 * cheaper dedicated tools with LSP context. This override keeps the
 * truncation behaviour from upstream but explicitly excludes the
 * file-operation substitutions and lists what bash IS for.
 */

/**
 * The bash description. The daemon cross-reference was removed with the
 * daemon tool suite: benchmark analysis (p2869167900) found no positive
 * pass-rate signal for daemon use while the steering text added per-request
 * cost — nothing should advertise a tool that no longer exists.
 */
export function bashToolDescription(): string {
	return `
Execute a bash command for operations without a dedicated tool: build commands, test runners, git, package managers, system administration, shell scripting.

DO NOT use bash for: reading files (use \`read\`), editing files (use \`edit\`), writing files (use \`write\`), searching file contents (use \`grep\`), finding files by pattern (use \`find\`), or listing directories (use \`ls\`) — dedicated tools are faster and unlock LSP context.

DO NOT pipe output through \`tail\` or \`head\` to hide it — this buffers all output until the process ends, preventing real-time progress monitoring. Instead, let the bash tool stream output directly and set a realistic timeout. For long-running commands (builds, tests, training), set a long timeout (e.g. timeout=1800) and checkin_interval (e.g. 60), then drive the process via bash_control.

DO NOT background processes with \`&\`, \`nohup\`, or \`disown\` — they escape the bash tool's process lifecycle and become orphaned, consuming memory until the container OOMs. Instead, set a long timeout on the bash command so it runs in the bash tool's background mode with proper process management. Managed background (timeout/checkin_interval + bash_control) is killed when the session ends.

Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.

Each command runs in a fresh shell rooted at the session working directory; \`cd\` does NOT persist between bash tool calls. Use absolute paths, or chain \`cd <dir> && <command>\` within a single call.
`.trim()
}
