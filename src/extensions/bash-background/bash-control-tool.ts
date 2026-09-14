/**
 * `bash_control` companion tool.
 *
 * After the background `bash` tool resolves at a checkin with a `handle`,
 * the agent drives the process to completion via this tool. Three actions:
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
 *  - `detach` (optionally with `extend_seconds`): release the process to keep
 *    running in the background WITHOUT gating the agent's other tools (the
 *    missing tier for session-scoped services such as `kubectl
 *    port-forward`). The registry entry and deadline stay live; the agent
 *    can still `stop`/`continue` the handle later. Session shutdown drains
 *    the registry, so a detached process dies with the session.
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
	action: Type.Union([Type.Literal("continue"), Type.Literal("stop"), Type.Literal("detach")], {
		description:
			"'continue' re-arms the next checkin (optionally extend the deadline first); 'stop' kills the process and returns final output; 'detach' keeps the process running in the background without blocking your other tools.",
	}),
	extend_seconds: Type.Optional(
		Type.Number({
			description:
				"Only valid with action 'continue' or 'detach'. Pushes the process deadline out by this many seconds. Omit or use 0 to keep the existing deadline.",
		}),
	),
	checkin_interval: Type.Optional(
		Type.Number({
			description:
				"Only valid with action 'continue'. Changes the checkin cadence (seconds) for this and subsequent waits. Raise it (e.g. 60–300) for long-running processes to avoid polling every checkin; this is NOT the deadline — use extend_seconds to move the auto-kill time. Omit to keep the current cadence.",
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
	/** The action taken: "continue" | "stop" | "detach". */
	action: "continue" | "stop" | "detach"
	/** True when this result is a mid-run checkin (process still alive). */
	checkin?: boolean
	/** True when the process was detached (gate released, keeps running). */
	detached?: boolean
	/** Reason the process stopped, if any ("stop" | "deadline" | "aborted" | …). */
	reason?: string | null
}

export const BASH_CONTROL_TOOL_NAME = "bash_control"

export const BASH_CONTROL_TOOL_DESCRIPTION = `Control a background bash process started by the \`bash\` tool.

After the \`bash\` tool spawns a long-running command in the background and returns a \`handle\` at a checkin, call this tool to decide what happens next:

- action "continue": keep the process running and receive the next tail-window of output at the next checkin. Optionally pass \`extend_seconds\` to push the deadline out first (preventing an imminent auto-kill), and/or \`checkin_interval\` to change how often you are woken with status updates — for long builds, prefer a longer interval (e.g. 60–300s) over polling every 15s.
- action "stop": kill the process immediately and return its final tail-window of output plus exit code.
- action "detach": keep the process running in the background WITHOUT blocking your other tools — use this for session-scoped services you need alive while you keep working (e.g. \`kubectl port-forward\`, a local server you will probe with other tools). The process is killed automatically when the session ends; its deadline still applies (pass \`extend_seconds\` to push it out). Call bash_control with the handle later to "stop" it early, or "continue" to resume checkins.

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
		const { handle, action, extend_seconds, checkin_interval } = params
		if (action !== "continue" && checkin_interval !== undefined) {
			return {
				content: [
					{
						type: "text",
						text: "Error: checkin_interval is only valid with action 'continue'.",
					},
				],
				details: { handle, exited: false, exitCode: null, action, reason: "invalid-params" },
			}
		}
		if (checkin_interval !== undefined && (!Number.isFinite(checkin_interval) || checkin_interval <= 0)) {
			return {
				content: [
					{
						type: "text",
						text: `Error: checkin_interval must be a positive number of seconds (got ${checkin_interval}).`,
					},
				],
				details: { handle, exited: false, exitCode: null, action, reason: "invalid-params" },
			}
		}
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

		// ── detach ──────────────────────────────────────────────────────
		if (action === "detach") {
			// Already exited between the previous checkin and this call: resolve
			// with the final output, mirroring the continue terminal path.
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
						action: "detach",
						reason: snapshot.reason,
					},
				}
			}

			// Optionally push the deadline out before walking away (detaching
			// does not disable the auto-kill deadline).
			if (extend_seconds !== undefined && extend_seconds > 0) {
				registry.extend(handle, extend_seconds)
			}

			// Resolve immediately — no checkin is armed and the extension's
			// gate releases the handle based on `detached: true` in details.
			const snapshot = registry.snapshotTail(handle)
			const statusLine = `\n\n[Process detached — it keeps running in the background for the rest of this session and your other tools are no longer blocked. It is killed automatically at session end; its deadline still applies. Call bash_control with action "stop" and handle ${handle} to kill it earlier, or "continue" to resume checkins.]`
			return {
				content: [{ type: "text", text: `${snapshot.text}${statusLine}` }],
				details: {
					handle,
					exited: false,
					exitCode: null,
					action: "detach",
					detached: true,
					reason: null,
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

		// Optionally change the checkin cadence for this and subsequent waits.
		// entry.intervalSeconds is read fresh at each re-arm (see below), so the
		// new cadence applies immediately.
		if (checkin_interval !== undefined) {
			registry.setIntervalSeconds(handle, checkin_interval)
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
