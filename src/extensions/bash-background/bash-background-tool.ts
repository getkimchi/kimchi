/**
 * Background-execution `bash` tool definition.
 *
 * Wraps upstream `createBashToolDefinition(cwd)` so the tool name stays
 * `bash` (preserving every extension that keys off `toolName === "bash"`),
 * but replaces `execute` with background semantics:
 *
 *  1. Spawn the command under the session process registry (no model-set
 *     timeout — the registry applies the harness-owned safety limit).
 *  2. Wait for natural exit or the command's ONE-TIME initial handoff
 *     deadline (bounded, ≤ 15s), whichever comes first. In user-facing
 *     sessions a queued user message hands off early.
 *  3. If it exits, return the normal final result with no live handle.
 *  4. If it is still running, start its complete output log, then resolve
 *     with the handle, identity/activity facts, the log path, and unseen
 *     output; the process stays tracked and its exit is delivered
 *     automatically.
 *
 * The model-facing schema advertises `{ command, description? }`. Legacy
 * `timeout`/`checkin_interval` fields from resumed sessions and ACP
 * replays are accepted as deprecated, ignored compatibility inputs.
 *
 * Shared Bash renderers display identity, elapsed time and bounded live output.
 */
import type { BashOperations, BashToolDetails, BashToolOptions, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import { DEFAULT_BASH_TIMEOUT_SECONDS } from "../agents/subagent-bash-clamp.js"
import { readE2eSeam } from "../e2e-seam.js"
import { createWorkCommitTrackingOperations } from "../work-attribution/commits.js"
import { createBashRenderers } from "./bash-display.js"
import {
	createProcessRegistry,
	DEFAULT_BASH_PROCESS_LIMIT_SECONDS,
	elapsedSecondsSince,
	type ProcessDisplaySnapshot,
	type ProcessRegistry,
} from "./process-registry.js"
import { createReviewCoordinator } from "./review-coordinator.js"
import type { BashSessionState } from "./session-registry.js"
import { handoffGuidanceText, outputLogNoticeText, runningResultText, terminalResultText } from "./status-text.js"
import { createTerminalDelivery } from "./terminal-delivery.js"
import { appendStatus, throwIfTerminal } from "./terminal-status.js"

/** Details returned in background-mode results (adds the handle). */
export interface BackgroundBashToolDetails extends BashToolDetails {
	display?: ProcessDisplaySnapshot
	/** Handle for the background process; pass to `bash_control`. Omitted when the command exited pre-handoff. */
	handle?: string
	/** Whether the process has exited. */
	exited?: boolean
	/** Process exit code (null until exit / if killed). */
	exitCode?: number | null
	/** True when this result is the pre-exit background handoff (process still alive). */
	handoff?: boolean
	/** Reason the process stopped, if any ("stop" | "safety-limit" | "aborted" | …). */
	reason?: string | null
	/** Whole seconds the process has run (from spawn). Omitted when no handle is known. */
	elapsedSeconds?: number
}

/** Model-facing schema: command and optional purpose. Legacy timing fields are deprecated/ignored. */
const backgroundBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	description: Type.Optional(Type.String({ maxLength: 120, description: "Short purpose of this command" })),
	/** @deprecated Ignored. Runtimes are bounded by the harness process limit; retained so resumed sessions and ACP replays with legacy payloads still validate. */
	timeout: Type.Optional(Type.Number()),
	/** @deprecated Ignored. Review cadence is harness-owned; retained for the same compatibility reason. */
	checkin_interval: Type.Optional(Type.Number()),
})

export type BackgroundBashInput = Static<typeof backgroundBashSchema>

export interface CreateBackgroundBashToolOptions extends BashToolOptions {
	/** State owned by the calling session; omission creates an isolated tool-owned registry. */
	state?: BashSessionState
	/** Safety limit used by this tool's isolated fallback when `state` is omitted. */
	limitSeconds?: number
	/**
	 * Whether `bash_control` is callable by the model RIGHT NOW. When false
	 * — or when the check itself throws — commands run in plain blocking
	 * mode with a deterministic timeout instead of handing off to the
	 * background cohort: a session must never hold background processes the
	 * model cannot disposition. Evaluated on every execution so tool-set
	 * changes (plan-mode profiles, allowlist tweaks) apply immediately.
	 * When OMITTED, background semantics stand — the caller owns its own
	 * cohort contract (isolated/test callers); the production registration
	 * (./index.ts) always wires the check against the live active tool set.
	 */
	controlToolAvailable?: () => boolean
}

/**
 * Deterministic blocking-mode timeout (seconds), matching the subagent
 * bash clamp default (./../agents/subagent-bash-clamp.ts): a session
 * without `bash_control` gets the same plain-blocking bash bound so a
 * long command can never hang the turn or leak an unmanaged process.
 */
export const BLOCKING_FALLBACK_TIMEOUT_SECONDS = DEFAULT_BASH_TIMEOUT_SECONDS

/**
 * E2E seam override for the blocking-mode timeout
 * (KIMCHI_E2E_BASH_BLOCKING_TIMEOUT_SECONDS), honored inside test harnesses
 * only: smoke rigs script commands that must time out quickly. Production
 * always uses BLOCKING_FALLBACK_TIMEOUT_SECONDS.
 */
export function e2eBlockingTimeoutSeconds(): number | undefined {
	const seam = readE2eSeam("KIMCHI_E2E_BASH_BLOCKING_TIMEOUT_SECONDS")
	const parsed = seam === undefined || seam.trim() === "" ? Number.NaN : Number(seam)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function fallbackState(
	limitSeconds = DEFAULT_BASH_PROCESS_LIMIT_SECONDS,
	cwd?: string,
): { state: BashSessionState; registry: ProcessRegistry } {
	const registry = createProcessRegistry()
	const state: BashSessionState = {
		registry,
		coordinator: createReviewCoordinator({ registry }),
		delivery: createTerminalDelivery(),
		limitSeconds,
		// Isolated fallback (no session owning the state): default to the
		// strictest policy — unattended keeps waits and the completion guard.
		sessionKind: "unattended",
		cwd,
	}
	return { state, registry }
}

/**
 * Build the background-execution `bash` ToolDefinition.
 *
 * @param cwd Working directory for command execution.
 * @param options Forwarded to upstream `createBashToolDefinition` (operations, shellPath, spawnHook, commandPrefix). `state` overrides the session state.
 */
export function createBackgroundBashToolDefinition(
	cwd: string,
	options?: CreateBackgroundBashToolOptions,
): ToolDefinition<typeof backgroundBashSchema, BackgroundBashToolDetails | undefined> {
	// Wrap the upstream definition once — we reuse its promptSnippet and
	// renderCall/renderResult. Only schema/description/execute are replaced.
	const wrapped = createBashToolDefinition(cwd, options)
	const state = options?.state ?? fallbackState(options?.limitSeconds, cwd).state

	// The production registration site (./index.ts) overwrites this
	// description with bashToolDescription() so tool-selection steering and
	// the cohort contract live in ONE place. Keep this base description
	// close to upstream — minus the timeout sentence, because the model no
	// longer sets runtimes (the harness owns the safety limit).
	const description = wrapped.description.replace(" Optionally provide a timeout in seconds.", "")

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
		const { command } = params
		const { registry, coordinator } = state

		// Blocking fallback (see module docstring): without a callable
		// bash_control, no command is ever backgrounded. When the option is
		// omitted the caller owns its cohort contract (isolated/test callers)
		// and background semantics stand; a check that THROWS degrades to
		// blocking — the fail-safe direction for the documented runaway.
		let controlAvailable = true
		try {
			controlAvailable = options?.controlToolAvailable?.() ?? true
		} catch {
			controlAvailable = false
		}
		if (!controlAvailable) {
			return executeBlocking(toolCallId, params, signal, onUpdate, ctx)
		}

		const handle = registry.spawn(
			options?.operations ?? createWorkCommitTrackingOperations(ctx, toolCallId, defaultLocalOps(options)),
			command,
			cwd,
			undefined,
			{
				limitSeconds: state.limitSeconds,
				toolCallId,
				description: params.description,
			},
		)
		coordinator.handleSpawned(handle)

		// Display updates never advance the model's delivered-output cursor.
		const unsubscribe = onUpdate
			? registry.observeDisplay(handle, (display) => {
					onUpdate({
						content: [{ type: "text", text: display.output }],
						details: { handle, exited: display.state !== "running", exitCode: display.exitCode, display },
					})
				})
			: undefined
		let outcome: Awaited<ReturnType<typeof coordinator.awaitInitialHandoff>>
		try {
			const pendingUserInput = state.sessionKind === "user-facing" ? () => ctx.hasPendingMessages() : undefined
			outcome = await coordinator.awaitInitialHandoff(handle, signal, pendingUserInput)
		} catch (error) {
			unsubscribe?.()
			throw error
		}

		if (outcome === "aborted") {
			await registry.kill(handle, "aborted")
			unsubscribe?.()
			coordinator.handleRemoved(handle)
			await registry.remove(handle).catch(() => {})
			throw new Error("Command aborted")
		}

		if (outcome === "exited") {
			const entry = registry.getEntry(handle)
			const elapsed = elapsedSecondsSince(entry?.spawnedAtMs ?? Date.now())
			const deadlineSeconds = entry?.deadlineSeconds ?? state.limitSeconds
			const final = registry.finalSnapshot(handle)
			const snapshot = registry.snapshotTail(handle)
			const display = registry.displaySnapshot(handle)
			unsubscribe?.()
			coordinator.handleRemoved(handle)

			// Mirror upstream's error behavior: throw on non-zero exit,
			// abort, or a safety-limit kill.
			const fullOutput = final?.content ?? snapshot.text
			onUpdate?.({
				content: [{ type: "text", text: fullOutput }],
				details: {
					handle,
					exited: true,
					exitCode: snapshot.exitCode,
					reason: snapshot.reason,
					display,
					...(final?.truncation?.truncated
						? { truncation: final.truncation, fullOutputPath: final.fullOutputPath }
						: {}),
				},
			})
			await registry.remove(handle).catch(() => {})
			const truncated = final?.truncation?.truncated === true
			// A failing command is exactly when the agent needs to search its
			// output: the error carries the log notice too.
			const logNotice = outputLogNoticeText(truncated, final?.fullOutputPath)
			throwIfTerminal(snapshot, logNotice ? `${fullOutput}\n${logNotice}` : fullOutput, deadlineSeconds)

			return {
				content: [
					{
						type: "text",
						// The shared terminal formatter: pre-handoff exits carry no
						// background identity, so no handle/command header.
						text: terminalResultText({
							elapsedSeconds: elapsed,
							state: snapshot.state,
							exitCode: snapshot.exitCode,
							reason: snapshot.reason,
							deadlineSeconds,
							output: fullOutput,
							truncated,
							fullOutputPath: final?.fullOutputPath,
						}),
					},
				],
				// Pre-handoff exit IS the normal final result: never expose a live
				// handle for a process that no longer exists.
				details: {
					...(truncated ? { truncation: final?.truncation, fullOutputPath: final?.fullOutputPath } : {}),
					exited: true,
					exitCode: snapshot.exitCode,
					display,
					elapsedSeconds: elapsed,
				},
			}
		}

		unsubscribe?.()

		// Still running at the handoff — start the complete output log, then
		// deliver identity, activity facts, the log path, and unseen output;
		// the process stays tracked and its exit is delivered automatically
		// (no recurring clock while the agent works).
		const logPath = registry.persistOutput(handle)
		const incremental = registry.snapshotSince(handle)
		const entry = registry.getEntry(handle)
		const elapsed = elapsedSecondsSince(entry?.spawnedAtMs ?? Date.now())
		let body: string
		if (entry) {
			registry.markDelivered(handle, incremental.nextCursor)
			body = runningResultText(entry, incremental, state.cwd)
		} else {
			body = snapshotBodyFallback(registry.snapshotTail(handle).text)
		}

		return {
			content: [{ type: "text", text: `${body}\n\n${handoffGuidanceText(state.sessionKind, logPath)}` }],
			details: {
				handle,
				exited: false,
				exitCode: null,
				handoff: true,
				display: registry.displaySnapshot(handle),
				reason: null,
				elapsedSeconds: elapsed,
			},
		}
	}

	/** Outcome of the blocking-mode exit race. */
	type BlockingOutcome = "exited" | "timeout" | "aborted"

	/**
	 * Race natural exit, the deterministic blocking timeout, and abort.
	 * Mirrors the abort semantics of `awaitInitialHandoff` (the caller kills
	 * the process on abort) and the subagent clamp's timeout bound.
	 */
	function awaitExitOrTimeout(
		handle: string,
		timeoutSeconds: number,
		signal: AbortSignal | undefined,
	): Promise<BlockingOutcome> {
		return new Promise<BlockingOutcome>((resolve) => {
			let settled = false
			let timer: NodeJS.Timeout | undefined
			const finish = (outcome: BlockingOutcome) => {
				if (settled) return
				settled = true
				if (timer) clearTimeout(timer)
				signal?.removeEventListener("abort", onAbort)
				resolve(outcome)
			}
			const onAbort = () => finish("aborted")
			if (signal) {
				if (signal.aborted) {
					resolve("aborted")
					return
				}
				signal.addEventListener("abort", onAbort, { once: true })
			}
			timer = setTimeout(() => finish("timeout"), timeoutSeconds * 1000)
			void state.registry
				.whenExited(handle)
				.then(() => finish("exited"))
				.catch(() => finish("exited"))
		})
	}

	/**
	 * Plain blocking execution for sessions without a callable
	 * `bash_control`: spawn under the registry (output capture, work
	 * attribution, kill-on-abort), wait for the exit, and return the final
	 * result — the deterministic timeout kills the process and reports the
	 * upstream `Command timed out after N seconds` error so timeout guidance
	 * and retry steering compose unchanged. No handle is ever returned, so
	 * the completion guard and exit watchers stay out of the picture.
	 */
	async function executeBlocking(
		toolCallId: string,
		params: BackgroundBashInput,
		signal: AbortSignal | undefined,
		onUpdate: Parameters<ToolDefinition["execute"]>[3] | undefined,
		ctx: Parameters<ToolDefinition["execute"]>[4],
	): Promise<{
		content: { type: "text"; text: string }[]
		details: BackgroundBashToolDetails | undefined
	}> {
		const { command } = params
		const { registry, coordinator } = state
		const timeoutSeconds = e2eBlockingTimeoutSeconds() ?? BLOCKING_FALLBACK_TIMEOUT_SECONDS
		const handle = registry.spawn(
			options?.operations ?? createWorkCommitTrackingOperations(ctx, toolCallId, defaultLocalOps(options)),
			command,
			cwd,
			undefined,
			{
				limitSeconds: state.limitSeconds,
				toolCallId,
				description: params.description,
			},
		)
		coordinator.handleSpawned(handle)

		// Display updates never advance the model's delivered-output cursor.
		const unsubscribe = onUpdate
			? registry.observeDisplay(handle, (display) => {
					onUpdate({
						content: [{ type: "text", text: display.output }],
						details: { handle, exited: display.state !== "running", exitCode: display.exitCode, display },
					})
				})
			: undefined

		try {
			const outcome = await awaitExitOrTimeout(handle, timeoutSeconds, signal)
			if (outcome === "aborted") {
				await registry.kill(handle, "aborted")
				throw new Error("Command aborted")
			}
			if (outcome === "timeout") {
				// kill() awaits exec settlement, so the final snapshot below is
				// complete — unless the kill itself failed and the process is
				// still alive. Fabricating a terminal result for a live process
				// would untrack it silently (no output capture, no guard
				// visibility), so the entry stays registered and the harness
				// safety limit / shutdown drain still bound it.
				await registry.kill(handle, "timeout").catch(() => {})
				if (registry.getEntry(handle)?.state === "running") {
					throw new Error(`Command timed out after ${timeoutSeconds} seconds but could not be stopped`)
				}
				// The reason renders as `killed (timeout)` in the facts
				// header; the error text carries the upstream timeout spelling so
				// bash-timeout-guidance steers compose unchanged.
				await registry.kill(handle, "timeout").catch(() => {})
			}

			const entry = registry.getEntry(handle)
			const elapsed = elapsedSecondsSince(entry?.spawnedAtMs ?? Date.now())
			const deadlineSeconds = entry?.deadlineSeconds ?? state.limitSeconds
			const final = registry.finalSnapshot(handle)
			const snapshot = registry.snapshotTail(handle)
			const display = registry.displaySnapshot(handle)
			const fullOutput = final?.content ?? snapshot.text
			const truncated = final?.truncation?.truncated === true
			onUpdate?.({
				content: [{ type: "text", text: fullOutput }],
				details: {
					handle,
					exited: true,
					exitCode: snapshot.exitCode,
					reason: snapshot.reason,
					display,
					...(truncated ? { truncation: final?.truncation, fullOutputPath: final?.fullOutputPath } : {}),
				},
			})

			if (outcome === "timeout") {
				const logNotice = outputLogNoticeText(truncated, final?.fullOutputPath)
				const text = logNotice ? `${fullOutput}\n${logNotice}` : fullOutput
				throw new Error(appendStatus(text, `Command timed out after ${timeoutSeconds} seconds`))
			}

			// Natural exit: mirror upstream's error behavior (non-zero exit,
			// abort, safety-limit kill) and the shared terminal contract.
			const logNotice = outputLogNoticeText(truncated, final?.fullOutputPath)
			throwIfTerminal(snapshot, logNotice ? `${fullOutput}\n${logNotice}` : fullOutput, deadlineSeconds)
			return {
				content: [
					{
						type: "text",
						text: terminalResultText({
							elapsedSeconds: elapsed,
							state: snapshot.state,
							exitCode: snapshot.exitCode,
							reason: snapshot.reason,
							deadlineSeconds,
							output: fullOutput,
							truncated,
							fullOutputPath: final?.fullOutputPath,
						}),
					},
				],
				details: {
					...(truncated ? { truncation: final?.truncation, fullOutputPath: final?.fullOutputPath } : {}),
					exited: true,
					exitCode: snapshot.exitCode,
					display,
					elapsedSeconds: elapsed,
				},
			}
		} finally {
			unsubscribe?.()
			// Remove only a settled entry: a timeout kill that failed leaves a
			// live process that must stay registered (the harness safety limit
			// and the shutdown drain own its lifecycle).
			if (registry.getEntry(handle)?.state !== "running") {
				coordinator.handleRemoved(handle)
				await registry.remove(handle).catch(() => {})
			}
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
		...createBashRenderers(() => state.registry),
	}
}

function snapshotBodyFallback(text: string): string {
	return text.length > 0 ? text : "[Background bash process started; no output yet.]"
}

// Lazily import the local backend so this module stays testable without a
// real shell when `operations` is injected. The registry calls ops.exec.
function defaultLocalOps(options?: CreateBackgroundBashToolOptions): BashOperations {
	return createLocalBashOperations({ shellPath: options?.shellPath })
}
