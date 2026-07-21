/**
 * Bash default-timeout extension
 *
 * The upstream bash tool treats `timeout` as optional: when the LLM omits
 * it, the command runs without any upper bound and can hang a session
 * indefinitely on a misbehaving command (interactive prompts, broken
 * pipes, network mounts, etc.).
 *
 * This extension fills in a default timeout (`DEFAULT_BASH_TIMEOUT_SECONDS`,
 * currently 120s) whenever the bash tool is called without one, so every
 * bash invocation has a deterministic upper bound. It additionally applies
 * a hard maximum (`MAX_BASH_TIMEOUT_SECONDS`, currently 600s) to every
 * bash call — including ones where the LLM set an explicit `timeout` — so
 * a single command can never consume an entire trial's wall-clock budget.
 * The LLM routinely requests `timeout=1800` or `3600` on trials whose
 * budget is 900-3600s; without the cap, one such call runs until the
 * trial's `AgentTimeoutError` fires, even though the agent had enough
 * turns and tokens to recover had the call been bounded.
 *
 * The cap only ever lowers a timeout — it never raises one — so shorter
 * explicit values and the default are preserved. An explicit `0` or
 * negative value (upstream: "no timeout", unbounded) is treated as
 * `Infinity` and clamped to the cap — an unbounded bash call can consume
 * the entire trial budget, the exact failure mode this cap prevents.
 *
 * Implementation layer: extension hook on the upstream `tool_call` event,
 * which the upstream runtime documents as having a mutable `event.input`
 * ("Mutate it in place to patch tool arguments before execution. Later
 * `tool_call` handlers see earlier mutations."). This is the lightest
 * layer that satisfies the requirement without forking or patching the
 * upstream bash tool.
 *
 * Toggleable from the /resources UI via the `extensions.bash-default-timeout`
 * resource so users who want unbounded bash calls can opt out. When
 * disabled, the extension is a no-op.
 */

import type { BashToolCallEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "../resources/store.js"

/** Resource id mirrored in `src/resources/definitions.ts`. */
export const BASH_DEFAULT_TIMEOUT_RESOURCE_ID = "extensions.bash-default-timeout"

/** Default applied when the bash tool is invoked without an explicit
 *  timeout. Kept as a named export so tests and tools can reference it
 *  without duplicating the literal. */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 120

/** Hard maximum applied to every bash timeout — including explicit ones
 *  set by the LLM — so a single bash call can never consume an entire
 *  trial budget. The cap only ever lowers a timeout; it never raises one,
 *  so shorter explicit timeouts and the default are preserved. An
 *  explicit `0` or negative value (upstream: "no timeout", unbounded) is
 *  treated as `Infinity` and clamped to the cap. See the module docstring
 *  for the failure mode this prevents. */
export const MAX_BASH_TIMEOUT_SECONDS = 600

/** Env var used to override `MAX_BASH_TIMEOUT_SECONDS` at runtime, so the
 *  cap can be tuned for a benchmark configuration without code changes. */
export const MAX_BASH_TIMEOUT_ENV = "KIMCHI_MAX_BASH_TIMEOUT_SECONDS"

/**
 * Pure helper: returns the hard cap (in seconds) for any bash timeout,
 * reading `KIMCHI_MAX_BASH_TIMEOUT_SECONDS` from the environment so the
 * cap can be tuned at runtime. Falls back to `MAX_BASH_TIMEOUT_SECONDS`
 * when the env var is unset or holds an invalid (non-positive, non-numeric)
 * value — never returns 0 or NaN, since `0` would disable the cap and
 * `NaN` would propagate as a non-finite timeout downstream. Re-read on
 * every call so env changes take effect immediately, mirroring the
 * dynamic `isResourceEnabled` toggle.
 */
export function resolveMaxBashTimeoutSeconds(): number {
	const raw = process.env[MAX_BASH_TIMEOUT_ENV]
	if (!raw) return MAX_BASH_TIMEOUT_SECONDS
	const parsed = Number.parseInt(raw, 10)
	if (Number.isNaN(parsed) || parsed <= 0) return MAX_BASH_TIMEOUT_SECONDS
	return parsed
}

/**
 * Pure helper: returns the timeout (in seconds) that should be used for a
 * given bash `input` object, defaulting to `DEFAULT_BASH_TIMEOUT_SECONDS`
 * when the caller did not provide one.
 *
 * Treats both `undefined` and `null` as "not set" so JSON-decoded RPC
 * inputs (where omitted fields often arrive as `null`) get the same
 * fallback as in-process objects. An explicit `0` is preserved as a raw
 * value so callers can distinguish "explicit 0" from "not set" (which
 * gets the default). The `tool_call` handlers then treat `0` as unbounded
 * (`Infinity`) and clamp it to the cap — see the NOTE below.
 *
 * NOTE: this helper does NOT apply the hard cap (`MAX_BASH_TIMEOUT_SECONDS`).
 * The cap is applied by the `tool_call` handlers, which additionally treat
 * `resolved <= 0` as unbounded (`Infinity`) before clamping via `Math.min` —
 * so an explicit `0` (upstream: "no timeout") is clamped to the cap, not
 * preserved. Callers that want the raw resolved value (e.g. tests of the
 * default-fill behaviour) can still get it from this helper. The handlers
 * always combine the two.
 */
export function resolveBashTimeout(
	input: { timeout?: number | null } | undefined,
	defaultSeconds: number = DEFAULT_BASH_TIMEOUT_SECONDS,
): number {
	if (!input) return defaultSeconds
	const explicit = input.timeout
	if (explicit === undefined || explicit === null) return defaultSeconds
	return explicit
}

export default function bashDefaultTimeoutExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return
		// Dynamic toggle: a user disabling this from /resources turns the
		// extension into a no-op immediately, with no restart required.
		if (!isResourceEnabled(BASH_DEFAULT_TIMEOUT_RESOURCE_ID)) return

		const bashEvent = event as BashToolCallEvent
		// Delegate to the pure helper so the "not set" rules (undefined
		// / null) and the default value live in one place. Then apply the
		// hard cap so an LLM-requested `timeout=3600` cannot eat an entire
		// trial budget. An explicit `0` or negative value (upstream: "no
		// timeout", unbounded) is treated as `Infinity` so it is clamped to
		// the cap — an unbounded bash call is the worst case of the failure
		// mode this cap prevents, and a finite cap also lets the
		// `bash-timeout-guidance` steer fire (an unbounded call produces no
		// "Command timed out" error, so the steer never triggers).
		// `Math.min` preserves shorter positive explicit values while
		// clamping only the values that exceed the cap.
		const resolved = resolveBashTimeout(bashEvent.input)
		const maxSeconds = resolveMaxBashTimeoutSeconds()
		const effective = resolved <= 0 ? Infinity : resolved
		bashEvent.input.timeout = Math.min(effective, maxSeconds)
	})
}

/**
 * Subagent-aware bash timeout extension. Behaves like
 * `bashDefaultTimeoutExtension` (fills in the default when `timeout` is
 * absent) but additionally clamps the resolved timeout to the subagent's
 * remaining wall-clock budget so a bash call can never block past
 * `max_duration`.
 *
 * The deadline is computed lazily inside the `tool_call` handler so the
 * clamp reflects the budget remaining at execution time, not at
 * registration time. The hard cap (`MAX_BASH_TIMEOUT_SECONDS`) is also
 * applied: `Math.min(resolved, remainingSeconds, maxSeconds)` — so a
 * subagent inherits the same main-agent guardrail, and the smallest of
 * the three bounds always wins. The cap can only further reduce the
 * timeout; it never raises one.
 *
 * @param maxDurationSeconds  The subagent's max_duration in seconds.
 * @param startTimeMs          Wall-clock timestamp (ms) when the subagent started.
 */
export function createSubagentBashClampExtension(maxDurationSeconds: number, startTimeMs: number) {
	return function subagentBashClampExtension(pi: ExtensionAPI): void {
		pi.on("tool_call", (event) => {
			if (event.toolName !== "bash") return
			if (!isResourceEnabled(BASH_DEFAULT_TIMEOUT_RESOURCE_ID)) return

			const bashEvent = event as BashToolCallEvent
			const resolved = resolveBashTimeout(bashEvent.input)
			const remainingMs = startTimeMs + maxDurationSeconds * 1000 - Date.now()
			const remainingSeconds = Math.floor(remainingMs / 1000)
			if (remainingSeconds <= 0) {
				// Budget exhausted — the max_duration timer should already be
				// firing. Floor at 1s so the command gets a chance to run
				// briefly rather than being killed instantly.
				bashEvent.input.timeout = 1
				return
			}
			const maxSeconds = resolveMaxBashTimeoutSeconds()
			// Treat `resolved <= 0` (upstream: "no timeout", unbounded) as
			// `Infinity` so it is clamped to the smaller of the cap and the
			// remaining budget — same rationale as the main-agent handler.
			const effective = resolved <= 0 ? Infinity : resolved
			bashEvent.input.timeout = Math.min(effective, remainingSeconds, maxSeconds)
		})
	}
}
