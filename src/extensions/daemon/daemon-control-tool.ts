/**
 * `daemon_control` tool — inspect and stop detached daemons.
 *
 * Companion to the `daemon` tool (see `./daemon-tool.ts` for the design
 * goal). Actions:
 *
 *   list    — all live daemons (dead records are pruned from the state
 *             dir, so a reboot doesn't leave phantoms).
 *   status  — one daemon: alive?, uptime, command, log path.
 *   logs    — tail of the daemon's log file (bounded, default 8KB).
 *   stop    — SIGTERM the process group, grace, SIGKILL; removes the
 *             state record. Idempotent: an already-dead or unknown id is
 *             reported softly, NOT thrown as a tool error (hard errors
 *             cause error→retry churn — same lesson as mark_todo).
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { readLogTail, stopDaemon } from "./spawn.js"
import { daemonStateDir, isPidAlive, listDaemons, readDaemon } from "./state.js"

const daemonControlSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("logs"), Type.Literal("stop")], {
		description:
			"'list' shows all live daemons; 'status' checks one daemon's liveness; 'logs' tails its log file; 'stop' terminates it.",
	}),
	id: Type.Optional(
		Type.String({
			description: "Daemon id (returned by the daemon tool). Required for status/logs/stop.",
		}),
	),
	max_bytes: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Only valid with action 'logs'. Max bytes to return from the end of the log file (default 8192).",
		}),
	),
})

export const DAEMON_CONTROL_TOOL_NAME = "daemon_control"

export const DAEMON_CONTROL_TOOL_DESCRIPTION = `Inspect or stop detached daemons started by the \`daemon\` tool.

- action "list": show all live daemons (id, pid, uptime, command, log file). Dead records are cleaned up automatically.
- action "status": check one daemon — alive?, uptime, command, log path.
- action "logs": return the tail of the daemon's log file.
- action "stop": terminate the daemon's whole process group and remove its record.

Daemons are NOT managed by bash_control — those handles belong to the bash tool's session-scoped background mode, which is a different lifecycle (killed at session end).`

export interface DaemonControlToolOptions {
	stateDir?: string
}

function formatUptime(startedAt: string): string {
	const ms = Date.now() - new Date(startedAt).getTime()
	if (!Number.isFinite(ms) || ms < 0) return "unknown"
	const s = Math.floor(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m${s % 60}s`
	const h = Math.floor(m / 60)
	return `${h}h${m % 60}m`
}

export function createDaemonControlToolDefinition(
	options: DaemonControlToolOptions = {},
): ToolDefinition<typeof daemonControlSchema, Record<string, unknown>> {
	const stateDir = options.stateDir ?? daemonStateDir()

	return {
		name: DAEMON_CONTROL_TOOL_NAME,
		label: "daemon_control",
		description: DAEMON_CONTROL_TOOL_DESCRIPTION,
		promptSnippet: "check or stop detached daemons",
		parameters: daemonControlSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { action, id } = params

			// ── list ────────────────────────────────────────────────────
			if (action === "list") {
				const live = listDaemons(stateDir)
				if (live.length === 0) {
					return {
						content: [{ type: "text", text: "No live daemons." }],
						details: { action, daemons: [] },
					}
				}
				const lines = live.map(
					({ record }) =>
						`${record.id}  pid ${record.pid}  up ${formatUptime(record.startedAt)}\n  ${record.command}\n  log: ${record.logFile}`,
				)
				return {
					content: [{ type: "text", text: `${live.length} live daemon(s):\n\n${lines.join("\n\n")}` }],
					details: {
						action,
						daemons: live.map(({ record }) => ({ id: record.id, pid: record.pid, command: record.command })),
					},
				}
			}

			// status / logs / stop require an id
			if (!id) {
				return {
					content: [
						{
							type: "text",
							text: `Error: action "${action}" requires an 'id' (from the daemon tool or daemon_control list).`,
						},
					],
					details: { action, error: "missing-id" },
				}
			}
			const record = readDaemon(stateDir, id)
			if (!record) {
				return {
					content: [
						{
							type: "text",
							text: `Daemon '${id}' is not recorded (already stopped, or never started here). Run daemon_control action "list" to see live daemons.`,
						},
					],
					details: { action, id, error: "unknown-id" },
				}
			}

			// ── status ──────────────────────────────────────────────────
			if (action === "status") {
				// isPidAlive directly — listDaemons would prune dead records, a
				// surprising side effect from a read-only status query.
				const live = isPidAlive(record.pid)
				return {
					content: [
						{
							type: "text",
							text:
								`Daemon ${record.id}: ${live ? "RUNNING" : "not running"}\n` +
								`  pid:      ${record.pid}\n  command:  ${record.command}\n  cwd:      ${record.cwd}\n` +
								`  started:  ${record.startedAt} (up ${formatUptime(record.startedAt)})\n  log:      ${record.logFile}`,
						},
					],
					details: { action, id, alive: live, pid: record.pid },
				}
			}

			// ── logs ────────────────────────────────────────────────────
			if (action === "logs") {
				const tail = readLogTail(record.logFile, params.max_bytes ?? 8192)
				return {
					content: [
						{
							type: "text",
							text: tail !== undefined ? tail : `(no log output yet — ${record.logFile} is missing or empty)`,
						},
					],
					details: { action, id, logFile: record.logFile },
				}
			}

			// ── stop ────────────────────────────────────────────────────
			// Explicit branch, NOT a fallthrough — if a future action is added
			// above but not handled, we must not silently STOP the daemon.
			if (action === "stop") {
				const { note } = await stopDaemon(record, stateDir)
				return {
					content: [{ type: "text", text: note }],
					details: { action, id, pid: record.pid },
				}
			}

			// Unreachable for the current schema (closed union) — but if a
			// new action is ever added and its branch is missed, nag rather
			// than fall into a destructive default.
			return {
				content: [
					{
						type: "text",
						text: `Unknown daemon_control action "${action}". Valid actions: list, status, logs, stop.`,
					},
				],
				details: { action, error: "unknown-action" },
			}
		},
	}
}
