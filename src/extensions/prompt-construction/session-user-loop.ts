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
 *
 * Ported from simplification/cost-parity `645de3c3`, adapted to read
 * `getParsedCliArgs()` (the hard rule: no `process.argv` outside cli.ts)
 * instead of scanning raw argv.
 */

import { type CliMode, getParsedCliArgs, PROTOCOL_MODES } from "../../cli-args.js"
import { IS_ACP_MODE } from "../../modes/acp/state.js"

export interface UserLoopInputs {
	/** Parsed `--print` flag (e.g. from `getParsedCliArgs().options`). */
	readonly print?: boolean
	/** Parsed `--mode` value (e.g. from `getParsedCliArgs().options`). */
	readonly mode?: string
	readonly stdinIsTTY: boolean
	readonly stdoutIsTTY: boolean
	readonly acpMode: boolean
}

export function resolveHasUserLoop(inputs: UserLoopInputs): boolean {
	if (inputs.acpMode) return true
	if (!inputs.stdinIsTTY || !inputs.stdoutIsTTY) return false
	if (inputs.print === true) return false
	if (inputs.mode !== undefined && PROTOCOL_MODES.has(inputs.mode as CliMode)) return false
	return true
}

let cachedHasUserLoop: boolean | undefined

export function hasUserLoop(): boolean {
	if (cachedHasUserLoop === undefined) {
		const { options } = getParsedCliArgs()
		cachedHasUserLoop = resolveHasUserLoop({
			print: options.print,
			mode: options.mode,
			stdinIsTTY: Boolean(process.stdin.isTTY),
			stdoutIsTTY: Boolean(process.stdout.isTTY),
			acpMode: IS_ACP_MODE,
		})
	}
	return cachedHasUserLoop
}
