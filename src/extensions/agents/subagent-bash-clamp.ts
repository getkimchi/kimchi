/**
 * Subagent bash wall-clock clamp
 *
 * Subagent sessions run the plain upstream (blocking) `bash` tool — the
 * background-bash cohort machinery is a main-session feature. Upstream
 * bash treats `timeout` as optional, so an omitted timeout can hang a
 * worker indefinitely on a misbehaving command. This extension gives
 * every subagent bash call a deterministic upper bound
 * (`DEFAULT_BASH_TIMEOUT_SECONDS` when none is supplied) and, when the
 * subagent has a `max_duration` budget, clamps the resolved timeout to
 * the REMAINING wall-clock budget so a bash call can never block past
 * the enclosing `max_duration`.
 *
 * This is lifecycle containment, not a model-facing timing control: the
 * model never sets or extends it, and it is not toggleable (subagent
 * containment must hold for the harness to keep its own promises). The
 * main session's equivalent bound is the background-bash harness safety
 * limit (`--bash-process-limit`), which lives in
 * `src/extensions/bash-background/`.
 *
 * Implementation layer: extension hook on the upstream `tool_call` event
 * (mutable `event.input`, per upstream docs) — the lightest layer that
 * composes with the upstream tool without forking it.
 */

import type { BashToolCallEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"

/** Default timeout (seconds) applied when a subagent bash call omits one. */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 120

/**
 * Pure helper: returns the timeout (in seconds) that should be used for a
 * given bash `input` object, defaulting to `DEFAULT_BASH_TIMEOUT_SECONDS`
 * when the caller did not provide one.
 *
 * Treats both `undefined` and `null` as "not set" so JSON-decoded RPC
 * inputs (where omitted fields often arrive as `null`) get the same
 * fallback as in-process objects. A non-positive timeout is ALSO treated
 * as "not set": upstream reads `timeout <= 0` as "no timeout", and
 * honouring that here would let the model opt out of the deterministic
 * bound the subagent containment contract relies on.
 */
export function resolveBashTimeout(
	input: { timeout?: number | null } | undefined,
	defaultSeconds: number = DEFAULT_BASH_TIMEOUT_SECONDS,
): number {
	if (!input) return defaultSeconds
	const explicit = input.timeout
	if (explicit === undefined || explicit === null) return defaultSeconds
	if (explicit <= 0) return defaultSeconds
	return explicit
}

/**
 * Shared `tool_call` hook for bash timeout mutation: narrows to bash
 * calls and assigns `input.timeout` from `resolve`. Both subagent
 * extensions below are this harness over different resolvers.
 */
function onSubagentBashCall(pi: ExtensionAPI, resolve: (input: { timeout?: number | null }) => number): void {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return
		const bashEvent = event as BashToolCallEvent
		bashEvent.input.timeout = resolve(bashEvent.input)
	})
}

/**
 * Fills in `DEFAULT_BASH_TIMEOUT_SECONDS` whenever a subagent bash call
 * omits `timeout` (or requests a non-positive — upstream "no timeout" —
 * one). Explicit positive timeouts are preserved.
 */
export function subagentBashDefaultTimeoutExtension(pi: ExtensionAPI): void {
	onSubagentBashCall(pi, (input) => resolveBashTimeout(input))
}

/**
 * Subagent-aware bash timeout extension. Behaves like
 * `subagentBashDefaultTimeoutExtension` (fills in the default when
 * `timeout` is absent) but additionally clamps the resolved timeout to
 * the subagent's remaining wall-clock budget so a bash call can never
 * block past `max_duration`.
 *
 * The deadline is computed lazily inside the `tool_call` handler so the
 * clamp reflects the budget remaining at execution time, not at
 * registration time.
 *
 * @param maxDurationSeconds  The subagent's max_duration in seconds.
 * @param startTimeMs          Wall-clock timestamp (ms) when the subagent started.
 */
export function createSubagentBashClampExtension(maxDurationSeconds: number, startTimeMs: number) {
	return function subagentBashClampExtension(pi: ExtensionAPI): void {
		onSubagentBashCall(pi, (input) => {
			const resolved = resolveBashTimeout(input)
			const remainingMs = startTimeMs + maxDurationSeconds * 1000 - Date.now()
			const remainingSeconds = Math.floor(remainingMs / 1000)
			if (remainingSeconds <= 0) {
				// Budget exhausted — the max_duration timer should already be
				// firing. Floor at 1s so the command gets a chance to run
				// briefly rather than being killed instantly.
				return 1
			}
			return Math.min(resolved, remainingSeconds)
		})
	}
}
