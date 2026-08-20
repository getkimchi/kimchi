/**
 * `daemon` tool — start a detached process that outlives the session.
 *
 * DESIGN GOAL: this tool must be UNATTRACTIVE for ordinary work. The
 * default for long-running commands is `bash` with a realistic timeout
 * (and checkin_interval + bash_control for managed background). `daemon`
 * is the deliberate last resort for one specific shape of problem: a
 * service that an external party connects to AFTER the agent's session
 * has ended — a web/DB server for the user, an emulator, a benchmark
 * grader's target process. The description below is load-bearing for that
 * steering; keep its restrictive tone when editing.
 *
 * Everything else is intentionally absent: no timeout/deadline param
 * (daemons never get one), no output streaming (that would be bash's
 * checkin loop), no automatic cleanup (that's the point).
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { spawnDaemon } from "./spawn.js"
import { daemonStateDir, validateDaemonName } from "./state.js"

const daemonSchema = Type.Object({
	command: Type.String({
		description:
			"Bash command line to run as the daemon (compound commands like 'a && b' are fine — the whole line runs in one shell). The returned pid is the process-group leader; a thin shell wrapper may remain if the command doesn't end in exec. Output is redirected to the daemon's log file automatically.",
	}),
	name: Type.Optional(
		Type.String({
			description:
				"Short identifier for the daemon (alphanumerics/dash/underscore only, max 40 chars). Used as a prefix for its id and log files. Pick something meaningful like 'pypi-server' or 'dev-web'.",
		}),
	),
})

export const DAEMON_TOOL_NAME = "daemon"

export const DAEMON_TOOL_DESCRIPTION = `Start a detached background process that KEEPS RUNNING after this session ends.

Use ONLY for long-lived services that someone connects to after you finish:
- web servers, APIs, databases, caches the user (or a grader) will query afterwards
- emulators / VMs that must stay up for external access
- anything whose whole purpose is to outlive you

Do NOT use for: builds, installs, tests, downloads, training runs, or ANY command with a natural end — use \`bash\` with a realistic timeout for those (and checkin_interval + bash_control for managed background). Managed background is the right default; it gets progress checkins, a deadline auto-kill, and cleanup at session end. Daemons get NONE of those: no timeout, no streamed output, no automatic cleanup. They just run.

After starting, verify the service actually works (e.g. curl it) and report the address to the user. Manage later via daemon_control (list / status / logs / stop).`

export interface DaemonToolOptions {
	/** Override the state dir (tests use a temp dir). */
	stateDir?: string
	/** Override the crash-grace window in ms (tests shrink this). */
	crashGraceMs?: number
}

export function createDaemonToolDefinition(
	options: DaemonToolOptions = {},
): ToolDefinition<typeof daemonSchema, Record<string, unknown>> {
	const stateDir = options.stateDir ?? daemonStateDir()

	return {
		name: DAEMON_TOOL_NAME,
		label: "daemon",
		description: DAEMON_TOOL_DESCRIPTION,
		promptSnippet: "start a detached service that must outlive this session (manage via daemon_control)",
		parameters: daemonSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Coerce empty-string name to undefined so it takes the default
			// `daemon-` prefix instead of producing a `-a1b2c3`-style id.
			const name = params.name === "" ? undefined : params.name
			if (name !== undefined) {
				const nameError = validateDaemonName(name)
				if (nameError) {
					return {
						content: [{ type: "text", text: `Error: ${nameError}` }],
						details: { error: "invalid-name" },
					}
				}
			}

			const outcome = await spawnDaemon({
				command: params.command,
				cwd: ctx.cwd,
				name,
				stateDir,
				crashGraceMs: options.crashGraceMs,
			})

			if (!outcome.ok) {
				return {
					content: [{ type: "text", text: `Error: ${outcome.error}` }],
					details: { error: "spawn-failed" },
				}
			}

			const { record } = outcome
			return {
				content: [
					{
						type: "text",
						text:
							`Daemon started.\n  id:       ${record.id}\n  pid:      ${record.pid}\n  command:  ${record.command}\n  log file: ${record.logFile}\n\n` +
							`It is detached and will keep running after this session ends. Verify it works (e.g. curl / connect) and tell the user how to reach it. Manage with daemon_control: action "status" | "logs" | "stop", id "${record.id}".`,
					},
				],
				details: { id: record.id, pid: record.pid, logFile: record.logFile },
			}
		},
	}
}
