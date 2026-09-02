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
 *     deadline (bounded, ≤ 15s), whichever comes first.
 *  3. If it exits, return the normal final result with no live handle.
 *  4. If it is still running, resolve with the handle, identity/activity
 *     facts, and unseen output; the process joins the session cohort's
 *     recurring review schedule and its exit is delivered automatically.
 *
 * The model-facing schema advertises only `{ command }`. Legacy
 * `timeout`/`checkin_interval` fields from resumed sessions and ACP
 * replays are accepted as deprecated, ignored compatibility inputs.
 *
 * `renderCall`/`renderResult` are delegated to the wrapped upstream
 * definition so the TUI rendering is unchanged.
 */
import type { BashOperations, BashToolDetails, BashToolOptions, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import {
	createProcessRegistry,
	DEFAULT_BASH_PROCESS_LIMIT_SECONDS,
	elapsedSecondsSince,
	type ProcessRegistry,
} from "./process-registry.js"
import { createReviewCoordinator } from "./review-coordinator.js"
import { type BashSessionState, getSessionState } from "./session-registry.js"
import { handoffGuidanceText, runningResultText, terminalResultText } from "./status-text.js"
import { throwIfTerminal } from "./terminal-status.js"

/** Details returned in background-mode results (adds the handle). */
export interface BackgroundBashToolDetails extends BashToolDetails {
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

/** Model-facing schema: only the command. Legacy timing fields are deprecated/ignored. */
const backgroundBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	/** @deprecated Ignored. Runtimes are bounded by the harness process limit; retained so resumed sessions and ACP replays with legacy payloads still validate. */
	timeout: Type.Optional(Type.Number()),
	/** @deprecated Ignored. Review cadence is harness-owned; retained for the same compatibility reason. */
	checkin_interval: Type.Optional(Type.Number()),
})

export type BackgroundBashInput = Static<typeof backgroundBashSchema>

export interface CreateBackgroundBashToolOptions extends BashToolOptions {
	/** Override the session state (tests inject a fake). Defaults to the session-scoped state. */
	state?: BashSessionState
	/** Safety limit used only when `state` is omitted and no session state exists. */
	limitSeconds?: number
}

function fallbackState(
	limitSeconds = DEFAULT_BASH_PROCESS_LIMIT_SECONDS,
	cwd?: string,
): { state: BashSessionState; registry: ProcessRegistry } {
	const registry = createProcessRegistry()
	const state: BashSessionState = {
		registry,
		coordinator: createReviewCoordinator({ registry }),
		limitSeconds,
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
	const fallback = options?.state ? undefined : fallbackState(options?.limitSeconds, cwd)

	// The production registration site (./index.ts) overwrites this
	// description with bashToolDescription() so tool-selection steering and
	// the cohort contract live in ONE place. Keep this base description
	// close to upstream — minus the timeout sentence, because the model no
	// longer sets runtimes (the harness owns the safety limit).
	const description = wrapped.description.replace(" Optionally provide a timeout in seconds.", "")

	async function execute(
		_toolCallId: string,
		params: BackgroundBashInput,
		signal: AbortSignal | undefined,
		onUpdate: Parameters<ToolDefinition["execute"]>[3] | undefined,
		_ctx: Parameters<ToolDefinition["execute"]>[4],
	): Promise<{
		content: { type: "text"; text: string }[]
		details: BackgroundBashToolDetails | undefined
	}> {
		const { command } = params
		const state = options?.state ?? getSessionState() ?? fallback?.state
		if (!state) {
			throw new Error("bash background state unavailable: no active session registry")
		}
		const { registry, coordinator } = state

		const handle = registry.spawn(options?.operations ?? defaultLocalOps(options), command, cwd, undefined, {
			limitSeconds: state.limitSeconds,
		})
		coordinator.handleSpawned(handle)

		// Emit an initial partial (empty) so the TUI shows the call as running.
		onUpdate?.({
			content: [{ type: "text", text: "" }],
			details: { handle, exited: false, exitCode: null, handoff: true },
		})

		// Resolve at the one-time handoff OR process exit (or abort), whichever
		// comes first. Aborting before the handoff kills the process tree,
		// matching upstream behavior for a cancelled bash call.
		const outcome = await coordinator.awaitInitialHandoff(handle, signal)

		if (outcome === "aborted") {
			await registry.kill(handle, "aborted")
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
			coordinator.handleRemoved(handle)
			await registry.remove(handle).catch(() => {})

			// Mirror upstream's error behavior: throw on non-zero exit,
			// abort, or a safety-limit kill.
			const fullOutput = final?.content ?? snapshot.text
			throwIfTerminal(snapshot, fullOutput, deadlineSeconds)

			const truncated = final?.truncation?.truncated === true
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
					elapsedSeconds: elapsed,
				},
			}
		}

		// Still running at the handoff — deliver identity, activity facts,
		// and unseen output; the cohort review clock takes over from here.
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
			content: [{ type: "text", text: `${body}\n\n${handoffGuidanceText()}` }],
			details: {
				handle,
				exited: false,
				exitCode: null,
				handoff: true,
				reason: null,
				elapsedSeconds: elapsed,
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

function snapshotBodyFallback(text: string): string {
	return text.length > 0 ? text : "[Background bash process started; no output yet.]"
}

// Lazily import the local backend so this module stays testable without a
// real shell when `operations` is injected. The registry calls ops.exec.
function defaultLocalOps(options?: CreateBackgroundBashToolOptions): BashOperations {
	return createLocalBashOperations({ shellPath: options?.shellPath })
}
