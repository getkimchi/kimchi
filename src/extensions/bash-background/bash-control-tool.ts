/**
 * `bash_control` companion tool.
 *
 * After the background `bash` tool resolves at a checkin with a `handle`,
 * the agent drives the process to completion via this tool. Two actions:
 *
 *  - `continue` (optionally with `extend_seconds`): if `extend_seconds > 0`,
 *    push the registry deadline out by that many seconds (preventing the
 *    deadline auto-kill), then re-arm the next checkin by awaiting
 *    `awaitCheckin` again. Resolves with the current tail-window + process
 *    state. If the process exited between the previous checkin and this
 *    call, resolves immediately with the final output (no checkin armed).
 *
 *  - `stop`: kill the process via `registry.kill(handle)` (which awaits abort
 *    settlement so final output is flushed), then resolve with the final
 *    tail-window + exit code. Removes the entry so the handle can't be reused.
 *
 * The tool reads the session registry via `getSessionRegistry()` so it
 * shares one process table with the background `bash` tool.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import { awaitCheckin } from "./checkin.js"
import { getSessionRegistry } from "./session-registry.js"
import { throwIfTerminal } from "./terminal-status.js"

const bashControlSchema = Type.Object({
	handle: Type.String({
		description: "Handle of the background bash process to control (returned by the bash tool).",
	}),
	action: Type.Union([Type.Literal("continue"), Type.Literal("stop")], {
		description:
			"'continue' re-arms the next checkin (optionally extend the deadline first); 'stop' kills the process and returns final output.",
	}),
	extend_seconds: Type.Optional(
		Type.Number({
			description:
				"Only valid with action 'continue'. Pushes the process deadline out by this many seconds before re-arming the checkin. Omit or use 0 to keep the existing deadline.",
		}),
	),
})

export type BashControlInput = Static<typeof bashControlSchema>

/** Details returned by bash_control. */
export interface BashControlDetails {
	/** The handle that was controlled. */
	handle: string
	/** Whether the process has exited. */
	exited: boolean
	/** Process exit code (null until exit / if killed without an exit code). */
	exitCode: number | null
	/** The action taken: "continue" | "stop". */
	action: "continue" | "stop"
	/** True when this result is a mid-run checkin (process still alive). */
	checkin?: boolean
	/** Reason the process stopped, if any ("stop" | "deadline" | "aborted" | …). */
	reason?: string | null
}

export const BASH_CONTROL_TOOL_NAME = "bash_control"

export const BASH_CONTROL_TOOL_DESCRIPTION = `Control a background bash process started by the \`bash\` tool.

After the \`bash\` tool spawns a long-running command in the background and returns a \`handle\` at a checkin, call this tool to decide what happens next:

- action "continue": keep the process running and receive the next tail-window of output at the next checkin. Optionally pass \`extend_seconds\` to push the deadline out first (preventing an imminent auto-kill).
- action "stop": kill the process immediately and return its final tail-window of output plus exit code.

Use this tool only when a \`bash\` result includes a \`handle\` in its details (i.e. the command is still running in the background). For commands that ran synchronously (timeout <= 5), there is no handle and no need to call this tool.`

/**
 * Build the `bash_control` ToolDefinition.
 *
 * @param getRegistry Override the registry accessor (tests inject a fake).
 *                    Defaults to the session-scoped `getSessionRegistry()`.
 */
export function createBashControlToolDefinition(
	getRegistry = getSessionRegistry,
): ToolDefinition<typeof bashControlSchema, BashControlDetails> {
	async function execute(
		_toolCallId: string,
		params: BashControlInput,
		signal: AbortSignal | undefined,
		_onUpdate: Parameters<ToolDefinition["execute"]>[3] | undefined,
	): Promise<{
		content: { type: "text"; text: string }[]
		details: BashControlDetails
	}> {
		const { handle, action, extend_seconds } = params
		const registry = getRegistry()
		if (!registry) {
			return {
				content: [
					{
						type: "text",
						text: "Error: no active bash session registry. Start a background bash command first.",
					},
				],
				details: { handle, exited: true, exitCode: null, action, reason: "no-registry" },
			}
		}

		const entry = registry.getEntry(handle)
		if (!entry) {
			return {
				content: [
					{
						type: "text",
						text: `Error: unknown handle '${handle}'. The process may have already exited and been removed.`,
					},
				],
				details: { handle, exited: true, exitCode: null, action, reason: "unknown-handle" },
			}
		}

		// ── stop ────────────────────────────────────────────────────────
		if (action === "stop") {
			await registry.kill(handle)
			const final = registry.finalSnapshot(handle)
			const snapshot = registry.snapshotTail(handle)
			const finalExitCode = snapshot.exitCode
			await registry.remove(handle).catch(() => {})
			const stoppedOutput = final?.content ?? snapshot.text
			const truncated = final?.truncation?.truncated === true
			return {
				content: [
					{
						type: "text",
						text:
							truncated && final?.fullOutputPath
								? `${stoppedOutput}\n\n[Process stopped${finalExitCode !== null ? `; exit code ${finalExitCode}` : ""}. Output truncated. Full output: ${final.fullOutputPath}]`
								: `${stoppedOutput}\n\n[Process stopped${finalExitCode !== null ? `; exit code ${finalExitCode}` : ""}]`,
					},
				],
				details: {
					handle,
					exited: true,
					exitCode: finalExitCode,
					action: "stop",
					reason: snapshot.reason ?? "stop",
					...(truncated ? { truncation: final?.truncation, fullOutputPath: final?.fullOutputPath } : {}),
				},
			}
		}

		// ── continue ────────────────────────────────────────────────────
		// If the process already exited (e.g. between the previous checkin and
		// this call), return the final output immediately.
		if (entry.state !== "running") {
			const final = registry.finalSnapshot(handle)
			const snapshot = registry.snapshotTail(handle)
			await registry.remove(handle).catch(() => {})
			const fullOutput = final?.content ?? snapshot.text
			throwIfTerminal(snapshot, fullOutput, entry.deadlineSeconds)
			return {
				content: [{ type: "text", text: fullOutput }],
				details: {
					handle,
					exited: true,
					exitCode: snapshot.exitCode,
					action: "continue",
					reason: snapshot.reason,
				},
			}
		}

		// Optionally extend the deadline BEFORE re-arming, so an imminent
		// deadline auto-kill doesn't fire before the next checkin resolves.
		if (extend_seconds !== undefined && extend_seconds > 0) {
			registry.extend(handle, extend_seconds)
		}

		// Turn abort (ESC) must kill the process, same as bash-background-tool.
		const onAbort = () => void registry.kill(handle, "aborted")
		if (signal?.aborted) onAbort()
		else signal?.addEventListener("abort", onAbort, { once: true })

		// Re-arm the next checkin (timer vs process exit race). This blocks
		// until the next checkin OR process exit — naturally pacing the loop
		// without relying on the event loop staying alive. Works in -p mode.
		const intervalSeconds = entry.intervalSeconds
		let snapshot: ReturnType<typeof registry.snapshotTail>
		try {
			snapshot = await awaitCheckin(registry, handle, intervalSeconds)
		} finally {
			signal?.removeEventListener("abort", onAbort)
		}
		const exited = snapshot.state !== "running"
		if (exited) {
			const final = registry.finalSnapshot(handle)
			await registry.remove(handle).catch(() => {})
			const fullOutput = final?.content ?? snapshot.text
			throwIfTerminal(snapshot, fullOutput, entry.deadlineSeconds)
			return {
				content: [{ type: "text", text: fullOutput }],
				details: {
					handle,
					exited: true,
					exitCode: snapshot.exitCode,
					action: "continue",
					reason: snapshot.reason,
				},
			}
		}

		// Process still running — return tail window + handle.
		const statusLine = `\n\n[Background process still running — call bash_control again with handle ${handle} to continue or stop]`

		return {
			content: [{ type: "text", text: `${snapshot.text}${statusLine}` }],
			details: {
				handle,
				exited: false,
				exitCode: null,
				action: "continue",
				checkin: true,
				reason: null,
			},
		}
	}

	return {
		name: BASH_CONTROL_TOOL_NAME,
		label: "bash_control",
		description: BASH_CONTROL_TOOL_DESCRIPTION,
		parameters: bashControlSchema,
		execute: execute as ToolDefinition<typeof bashControlSchema, BashControlDetails>["execute"],
	}
}
