/**
 * Background-execution `bash` tool definition.
 *
 * Wraps upstream `createBashToolDefinition(cwd)` so the tool name stays
 * `bash` (preserving every extension that keys off `toolName === "bash"`),
 * but replaces `execute` with background semantics:
 *
 *  - `timeout <= 5` (seconds): short-task path. Delegate to the wrapped
 *    definition's `execute` and return the full output once — no checkins,
 *    no handle. Preserves today's fast-command behaviour.
 *  - `timeout > 5` or omitted: background checkin mode. Spawn the command
 *    via the process registry (no upstream timeout — the registry manages
 *    its own deadline), arm a checkin timer at `checkin_interval ?? 15s`,
 *    and resolve `execute` at the first checkin OR process exit (whichever
 *    comes first) with a tail-window of output plus a `handle` in details.
 *    The agent then drives the process via the `bash_control` tool.
 *
 * `renderCall`/`renderResult` are delegated to the wrapped upstream
 * definition so the TUI rendering is unchanged.
 */
import type { BashOperations, BashToolDetails, BashToolOptions, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import { awaitCheckin } from "./checkin.js"
import { createProcessRegistry, type ProcessRegistry, type TailSnapshot } from "./process-registry.js"
import { throwIfTerminal } from "./terminal-status.js"

/** Short-task threshold: timeouts at or below this run synchronously. */
export const SHORT_TASK_TIMEOUT_SECONDS = 5

/** Default checkin cadence when `checkin_interval` is omitted. */
export const DEFAULT_CHECKIN_INTERVAL_SECONDS = 15

/** Deadline used when `timeout` is omitted. Matches bash-default-timeout's default. */
export const DEFAULT_TIMEOUT_SECONDS = 120

/** Details returned in background-mode results (adds the handle). */
export interface BackgroundBashToolDetails extends BashToolDetails {
	/** Handle for the background process; pass to `bash_control`. Omitted on the short-task path. */
	handle?: string
	/** Whether the process has exited. */
	exited?: boolean
	/** Process exit code (null until exit / if killed). */
	exitCode?: number | null
	/** True when this result is a mid-run checkin (process still alive). */
	checkin?: boolean
	/** Reason the process stopped, if any ("stop" | "deadline" | "aborted" | …). */
	reason?: string | null
}

/** Extended schema: upstream {command, timeout?} + checkin_interval? */
const backgroundBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in seconds. Set this to the realistic maximum the command could need.",
		}),
	),
	checkin_interval: Type.Optional(
		Type.Number({
			description: "Seconds between background checkins for long-running commands. Omit to use the default 15s.",
		}),
	),
})

export type BackgroundBashInput = Static<typeof backgroundBashSchema>

export interface CreateBackgroundBashToolOptions extends BashToolOptions {
	/** Override the process registry (tests inject a fake). Defaults to a fresh registry. */
	registry?: ProcessRegistry
}

/**
 * Build the background-execution `bash` ToolDefinition.
 *
 * @param cwd Working directory for command execution.
 * @param options Forwarded to upstream `createBashToolDefinition` (operations, shellPath, spawnHook, commandPrefix). `registry` overrides the process registry.
 */
export function createBackgroundBashToolDefinition(
	cwd: string,
	options?: CreateBackgroundBashToolOptions,
): ToolDefinition<typeof backgroundBashSchema, BackgroundBashToolDetails | undefined> {
	// Wrap the upstream definition once — we reuse its description, parameters
	// (as a base), and renderCall/renderResult. Only `execute` is replaced.
	const wrapped = createBashToolDefinition(cwd, options)
	const registry = options?.registry ?? createProcessRegistry()

	const description =
		wrapped.description +
		" Long-running commands run in the background: you receive a tail-window of output plus a process handle at each checkin (default every 15s, or every checkin_interval seconds when provided), then drive it to completion with the bash_control tool. For commands expected to run several minutes (builds, installs, training), set a longer checkin_interval (e.g. 60–120s) to avoid waking up every 15s; the cadence can also be changed later via bash_control's checkin_interval. Always set a timeout appropriate to the command — do not shorten it artificially."

	async function execute(
		toolCallId: string,
		params: BackgroundBashInput,
		signal: AbortSignal | undefined,
		onUpdate: Parameters<ToolDefinition["execute"]>[3] | undefined,
		ctx: Parameters<ToolDefinition["execute"]>[4],
	): Promise<{
		content: { type: "text"; text: string }[]
		details: BackgroundBashToolDetails | undefined
	}> {
		const { command, timeout, checkin_interval } = params
		const resolvedTimeout = timeout ?? DEFAULT_TIMEOUT_SECONDS

		// ── Short-task path: timeout <= 5 → synchronous run-to-completion. ──
		if (resolvedTimeout <= SHORT_TASK_TIMEOUT_SECONDS) {
			const upstreamParams = { command, timeout: resolvedTimeout }
			const result = await wrapped.execute(
				toolCallId,
				upstreamParams as Static<typeof wrapped.parameters>,
				signal,
				onUpdate as Parameters<typeof wrapped.execute>[3] | undefined,
				ctx as Parameters<typeof wrapped.execute>[4],
			)
			return {
				content: result.content as { type: "text"; text: string }[],
				details: { ...(result.details as BashToolDetails | undefined) },
			}
		}

		// ── Background checkin path. ──
		const intervalSeconds =
			checkin_interval !== undefined && checkin_interval > 0 ? checkin_interval : DEFAULT_CHECKIN_INTERVAL_SECONDS
		// Deadline: use the provided timeout if explicit, else a generous default
		// (the agent can extend via bash_control). Background mode never passes
		// an upstream timeout to ops.exec — the registry owns the deadline.
		const deadlineSeconds = timeout !== undefined && timeout > 0 ? timeout : DEFAULT_TIMEOUT_SECONDS
		const deadlineMs = Date.now() + deadlineSeconds * 1000

		const handle = registry.spawn(
			// Use the upstream-injected operations if provided, else the registry
			// will use its default local backend.
			options?.operations ?? defaultLocalOps(options),
			command,
			cwd,
			undefined,
			{ intervalSeconds, deadlineMs },
		)

		// Turn abort (ESC) must kill the process tree, same as the sync path.
		const onAbort = () => void registry.kill(handle, "aborted")
		if (signal?.aborted) onAbort()
		else signal?.addEventListener("abort", onAbort, { once: true })

		// Emit an initial partial (empty) so the TUI shows the call as running.
		onUpdate?.({
			content: [{ type: "text", text: "" }],
			details: { handle, exited: false, exitCode: null, checkin: true },
		})

		// Resolve at the first checkin OR process exit, whichever is first.
		let snapshot: TailSnapshot
		try {
			snapshot = await awaitCheckin(registry, handle, intervalSeconds)
		} finally {
			signal?.removeEventListener("abort", onAbort)
		}
		const exited = snapshot.state !== "running"

		// If the process exited between spawn and the checkin, clean up the entry.
		if (exited) {
			const final = registry.finalSnapshot(handle)
			await registry.remove(handle).catch(() => {})

			// Mirror upstream's error behavior: throw on non-zero exit or deadline.
			// The wording matters — bash-timeout-guidance.ts matches on
			// /Command timed out after (\d+) seconds/.
			const fullOutput = final?.content ?? snapshot.text
			throwIfTerminal(snapshot, fullOutput, deadlineSeconds)

			// Success exit — return plain output with truncation details if present.
			const truncated = final?.truncation?.truncated === true
			return {
				content: [
					{
						type: "text",
						text:
							truncated && final?.fullOutputPath
								? `${fullOutput}\n\n[Output truncated. Full output: ${final.fullOutputPath}]`
								: fullOutput,
					},
				],
				details: truncated ? { truncation: final?.truncation, fullOutputPath: final?.fullOutputPath } : undefined,
			}
		}

		// Process still running — return tail window + handle for bash_control.
		const statusLine = `\n\n[Background process running — call bash_control with handle ${handle} to continue or stop]`

		return {
			content: [{ type: "text", text: `${snapshot.text}${statusLine}` }],
			details: {
				handle,
				exited: false,
				exitCode: null,
				checkin: true,
				reason: null,
			},
		}
	}

	return {
		name: "bash",
		label: wrapped.label,
		description,
		promptSnippet: wrapped.promptSnippet,
		parameters: backgroundBashSchema,
		renderShell: wrapped.renderShell,
		prepareArguments: wrapped.prepareArguments as
			| ToolDefinition<typeof backgroundBashSchema>["prepareArguments"]
			| undefined,
		executionMode: wrapped.executionMode,
		execute: execute as ToolDefinition<typeof backgroundBashSchema, BackgroundBashToolDetails | undefined>["execute"],
		renderCall: wrapped.renderCall as
			| ToolDefinition<typeof backgroundBashSchema, BackgroundBashToolDetails | undefined>["renderCall"]
			| undefined,
		renderResult: wrapped.renderResult as
			| ToolDefinition<typeof backgroundBashSchema, BackgroundBashToolDetails | undefined>["renderResult"]
			| undefined,
	}
}

// Lazily import the local backend so this module stays testable without a
// real shell when `operations` is injected. The registry calls ops.exec.
function defaultLocalOps(options?: CreateBackgroundBashToolOptions): BashOperations {
	return createLocalBashOperations({ shellPath: options?.shellPath })
}
