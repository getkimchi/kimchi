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
 * Observability: every clamp that actually reduces the timeout below the
 * resolved value publishes a `subagent_bash_clamp:clamped` domain event
 * (subagent-bash-clamp-events.ts). The telemetry extension translates it
 * to the `subagent.bash_clamped` OTLP event and reclassifies the resulting
 * tool error — a clamped timeout is expected lifecycle behavior, not a
 * `tool_failure`.
 *
 * Model-facing explanation: when a clamped call dies to its clamped
 * timeout, the raw "Command timed out after N seconds" gives the agent no
 * way to distinguish "the command is slow" from "my budget is spent" —
 * the natural response is to retry, which can never succeed. The
 * `tool_result` handler below appends a direct, second-person note
 * (matching the <budget> block's voice from the subagent prompt) so the
 * agent knows why the command died and what to do: run only sub-second
 * essentials (commit, write out results) or summarize now.
 *
 * Implementation layer: extension hook on the upstream `tool_call` event
 * (mutable `event.input`, per upstream docs) — the lightest layer that
 * composes with the upstream tool without forking it.
 */

import type { TextContent } from "@earendil-works/pi-ai"
import type { BashToolCallEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { SUBAGENT_BASH_CLAMP_EVENTS, type SubagentBashClampedPayload } from "./subagent-bash-clamp-events.js"

/** Default timeout (seconds) applied when a subagent bash call omits one. */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 120

/** Upstream bash reports a timeout-killed command as `Command timed out
 *  after N seconds` appended to the result text (pi tools/bash.ts). Shared
 *  by this module's result annotation and the telemetry error
 *  reclassification (telemetry/handlers/tools.ts). */
export const BASH_TIMEOUT_STATUS_PATTERN = /Command timed out after \d+ seconds/

const BUDGET_EXHAUSTED_NOTE =
	"You have reached your wall-clock time budget. The command above was killed by the harness time limit — not because the command was slow. " +
	"Run only commands that finish within a second (commit your work, write out results) or reply with your final summary now. Do not retry commands."

/** Budget note for a clamped-timeout result, computed from the budget
 *  remaining AT RESULT TIME — the clamped value is what remained when the
 *  command started, and the command has been running since, so reporting
 *  it would overstate the remaining budget (a full-tail clamp that times
 *  out has consumed it entirely). */
function budgetNote(remainingMs: number): string {
	const remainingSeconds = Math.floor(remainingMs / 1000)
	if (remainingSeconds <= 0) return BUDGET_EXHAUSTED_NOTE
	return `You are close to your wall-clock time budget — roughly ${remainingSeconds}s remain. Commands that take longer will be killed. Finish the change in progress or summarize your progress for the orchestrator now.`
}

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
 * extensions below are this harness over different resolvers. The
 * resolver also receives the tool call id so the clamp can publish the
 * domain event keyed to the call.
 */
function onSubagentBashCall(
	pi: ExtensionAPI,
	resolve: (input: { timeout?: number | null }, toolCallId: string) => number,
): void {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return
		const bashEvent = event as BashToolCallEvent
		bashEvent.input.timeout = resolve(bashEvent.input, bashEvent.toolCallId)
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
 * Publish a clamp fact on the domain channel. Best-effort: pi.events may
 * be unavailable on older hosts or lightweight test mocks, and the clamp
 * must still function without telemetry (precedent: emitSteerFired in
 * steer-events.ts).
 */
function emitBashClamped(pi: ExtensionAPI, payload: SubagentBashClampedPayload): void {
	try {
		pi.events.emit(SUBAGENT_BASH_CLAMP_EVENTS.CLAMPED, payload)
	} catch {
		// see above
	}
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
 * registration time. Every clamp that reduces the timeout below the
 * resolved value publishes a `subagent_bash_clamp:clamped` domain event
 * (expected lifecycle behavior — telemetry reports it as
 * `subagent.bash_clamped`, not an error).
 *
 * @param maxDurationSeconds  The subagent's max_duration in seconds.
 * @param startTimeMs          Wall-clock timestamp (ms) when the subagent started.
 * @param agentType            The subagent's agent type, forwarded on the clamp
 *                             event for attribution (matches subagent.spawned's
 *                             agent_type).
 */
export function createSubagentBashClampExtension(maxDurationSeconds: number, startTimeMs: number, agentType?: string) {
	return function subagentBashClampExtension(pi: ExtensionAPI): void {
		/** Tool call ids of calls this run clamped — consumed by the
		 *  tool_result annotation below. Per-run closure: concurrent
		 *  subagents each construct their own factory. */
		const clamped = new Set<string>()

		onSubagentBashCall(pi, (input, toolCallId) => {
			const resolved = resolveBashTimeout(input)
			const remainingMs = startTimeMs + maxDurationSeconds * 1000 - Date.now()
			const remainingSeconds = Math.floor(remainingMs / 1000)
			if (remainingSeconds <= 0) {
				// Budget exhausted — the max_duration timer should already be
				// firing. Floor at 1s so the command gets a chance to run
				// briefly rather than being killed instantly.
				if (resolved > 1) {
					clamped.add(toolCallId)
					emitBashClamped(pi, {
						toolCallId,
						...(agentType !== undefined ? { agentType } : {}),
						reason: "budget_exhausted",
						requestedTimeoutS: resolved,
						clampedToS: 1,
						remainingMs,
					})
				}
				return 1
			}
			const effective = Math.min(resolved, remainingSeconds)
			if (effective < resolved) {
				clamped.add(toolCallId)
				emitBashClamped(pi, {
					toolCallId,
					...(agentType !== undefined ? { agentType } : {}),
					reason: "budget_tail",
					requestedTimeoutS: resolved,
					clampedToS: effective,
					remainingMs,
				})
			}
			return effective
		})

		// Annotate the failed result so the agent knows WHY the command died:
		// without this, a budget-clamped timeout looks like a slow command and
		// the natural response is a retry that can never succeed. Returns
		// replacement content — upstream applies tool_result hook results to
		// what the model sees (agent-session.js afterToolCall); details and
		// usage have no fallback there, so they are passed through unchanged.
		pi.on("tool_result", (event) => {
			if (event.toolName !== "bash") return
			// Release the marker regardless of outcome — the annotation is only
			// for the clamped call's own (terminal) result.
			if (!clamped.delete(event.toolCallId)) return
			if (!event.isError) return
			const timedOut = event.content.some(
				(block) => block.type === "text" && BASH_TIMEOUT_STATUS_PATTERN.test(block.text),
			)
			// Other failures on a clamped call (e.g. non-zero exit before the
			// timeout) are genuine command errors — leave them untouched.
			if (!timedOut) return
			const note: TextContent = {
				type: "text",
				// Recompute the budget at result time: the clamped value is what
				// remained when the command STARTED, and the command has been
				// running since. A timed-out full-tail clamp has consumed the
				// budget entirely, so the exhausted guidance applies even when the
				// clamp originally fired in the tail.
				text: budgetNote(startTimeMs + maxDurationSeconds * 1000 - Date.now()),
			}
			return {
				content: [...event.content, note],
				details: event.details,
				usage: event.usage,
			}
		})
	}
}
