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
 * bash invocation has a deterministic upper bound. Explicit user-provided
 * timeouts are preserved — the extension only acts when the field is
 * absent.
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

/**
 * Pure helper: returns the timeout (in seconds) that should be used for a
 * given bash `input` object, defaulting to `DEFAULT_BASH_TIMEOUT_SECONDS`
 * when the caller did not provide one.
 *
 * Treats both `undefined` and `null` as "not set" so JSON-decoded RPC
 * inputs (where omitted fields often arrive as `null`) get the same
 * fallback as in-process objects. An explicit `0` is preserved: upstream
 * treats `timeout <= 0` as "no timeout", so we honour that contract
 * rather than overriding it with the default.
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
		// / null) and the default value live in one place. An explicit
		// value (including 0, which upstream treats as "no timeout")
		// is preserved as-is.
		bashEvent.input.timeout = resolveBashTimeout(bashEvent.input)
	})
}
