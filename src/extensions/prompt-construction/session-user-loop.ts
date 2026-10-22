/**
 * Decide once per session whether a human is reachable ("user loop"), so the
 * system prompt can drop interactive-session-only sections (Consent, Harness
 * Notes, Documents, orient-the-user) in headless runs.
 *
 * User-present:
 * - ACP sessions (a human is driving from an IDE)
 * - Interactive terminal sessions (TUI: stdin+stdout TTY, not print/protocol mode)
 *
 * Userless: print mode, json protocol mode, piped IO, benchmark/CI harnesses.
 *
 * `rpc` mode is the embedding channel for frontends (IDE plugins, UIs) that
 * usually have a human present, so it is treated as user-present even though
 * its stdin/stdout are pipes owned by the caller. Only internal headless callers use
 * `--mode json -p`, so this does not change any internal headless path.
 *
 * Computed once at first use and cached — the system prompt must stay static
 * within a session or the provider KV cache invalidates.
 *
 * The same inputs answer a second question: is this the interactive TUI?
 * `isTuiSession()` gates surface-specific guidance (e.g. background-subagent
 * completion notifications only reach the user in the TUI — every other
 * surface must join backgrounded agents before ending its turn).
 *
 * Ported from simplification/cost-parity `645de3c3`, adapted to read
 * `getParsedCliArgs()` (the hard rule: no `process.argv` outside cli.ts)
 * instead of scanning raw argv.
 */

import { getParsedCliArgs, isProtocolCliMode } from "../../cli-args.js"
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
	// Before the TTY check: rpc speaks JSONL over stdin/stdout, so a real rpc
	// session always has piped IO.
	if (inputs.mode === "rpc") return true
	if (!inputs.stdinIsTTY || !inputs.stdoutIsTTY) return false
	if (inputs.print === true) return false
	if (isProtocolCliMode(inputs.mode)) return false
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

/**
 * Is this process running the interactive TUI? True only for a real terminal
 * session: TTY stdin and stdout, no `--print`, no protocol `--mode` (json / rpc /
 * acp), and not an ACP server process. Unlike `resolveHasUserLoop`, rpc counts
 * as NOT TUI — a human may be driving an IDE frontend, but the TUI's
 * post-turn rendering loop (which delivers background-agent completion
 * notifications) only exists in the terminal app.
 */
export function resolveIsTuiSession(inputs: UserLoopInputs): boolean {
	if (inputs.acpMode) return false
	if (isProtocolCliMode(inputs.mode)) return false
	if (inputs.print === true) return false
	if (!inputs.stdinIsTTY || !inputs.stdoutIsTTY) return false
	return true
}

let cachedIsTuiSession: boolean | undefined

export function isTuiSession(): boolean {
	if (cachedIsTuiSession === undefined) {
		const { options } = getParsedCliArgs()
		cachedIsTuiSession = resolveIsTuiSession({
			print: options.print,
			mode: options.mode,
			stdinIsTTY: Boolean(process.stdin.isTTY),
			stdoutIsTTY: Boolean(process.stdout.isTTY),
			acpMode: IS_ACP_MODE,
		})
	}
	return cachedIsTuiSession
}
