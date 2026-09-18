/**
 * Decide once per session whether a human is reachable ("user loop"), so the
 * system prompt can drop interactive-session-only sections (Consent, Harness
 * Notes, Documents, orient-the-user) in headless runs.
 *
 * User-present:
 * - ACP sessions (a human is driving from an IDE)
 * - Interactive terminal sessions (TUI: stdin+stdout TTY, not print/protocol mode)
 *
 * Userless: print mode, protocol modes, piped IO, benchmark/CI harnesses.
 *
 * Computed once at first use and cached — the system prompt must stay static
 * within a session or the provider KV cache invalidates.
 */

import { isTerminalUiMode } from "../../cli-args.js"
import { IS_ACP_MODE } from "../../modes/acp/state.js"

export interface UserLoopInputs {
	readonly args: readonly string[]
	readonly stdinIsTTY: boolean
	readonly stdoutIsTTY: boolean
	readonly acpMode: boolean
}

export function resolveHasUserLoop(inputs: UserLoopInputs): boolean {
	if (inputs.acpMode) return true
	return isTerminalUiMode([...inputs.args], {
		stdinIsTTY: inputs.stdinIsTTY,
		stdoutIsTTY: inputs.stdoutIsTTY,
	})
}

let cachedHasUserLoop: boolean | undefined

export function hasUserLoop(): boolean {
	cachedHasUserLoop ??= resolveHasUserLoop({
		args: process.argv.slice(2),
		stdinIsTTY: Boolean(process.stdin.isTTY),
		stdoutIsTTY: Boolean(process.stdout.isTTY),
		acpMode: IS_ACP_MODE,
	})
	return cachedHasUserLoop
}
