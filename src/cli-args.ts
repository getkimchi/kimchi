import { parseArgs as parsePiArgs } from "@earendil-works/pi-coding-agent"
import { PROMPT_VARIANT_ENV } from "./extensions/prompt-construction/variants/index.js"

// Pre-dispatch scanners still need to skip values for Kimchi-local raw scans
// such as `--mode acp`, which upstream pi does not parse.
const PRE_DISPATCH_VALUE_FLAGS = new Set([
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--session",
	"--fork",
	"--session-dir",
	"--models",
	"--tools",
	"-t",
	"--thinking",
	"--export",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
])

export function isPreDispatchValueFlag(arg: string): boolean {
	return PRE_DISPATCH_VALUE_FLAGS.has(arg)
}

export function getCliModeArg(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]
		if (arg === "--mode" && i + 1 < args.length) return args[i + 1]
		if (arg.startsWith("--mode=")) return arg.slice("--mode=".length)
	}
	return undefined
}

export function isHelpOrVersionArgs(args: string[]): boolean {
	return args.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-v")
}

// Modes where stdout belongs to the caller (protocol channel or user-facing
// print output). Terminal OSC writes and compat warnings must be suppressed
// because they corrupt that stream.
export function isProtocolOrPrintMode(args: string[]): boolean {
	const parsed = parsePiArgs(args)
	const mode = parsed.mode ?? getCliModeArg(args)
	return mode === "json" || mode === "rpc" || mode === "acp" || parsed.print === true
}

export function isTerminalUiMode(args: string[], io: { stdinIsTTY: boolean; stdoutIsTTY: boolean }): boolean {
	return io.stdinIsTTY && io.stdoutIsTTY && !isProtocolOrPrintMode(args)
}

export function isExperimentalFeaturesArg(args: string[]): boolean {
	return args.includes("--enable-experimental-features")
}

export function stripExperimentalFeaturesArg(args: string[]): string[] {
	return args.filter((a) => a !== "--enable-experimental-features")
}

/**
 * Extract the `--spicy` boolean flag from argv.
 *
 * Strips the `--spicy` token wherever it appears and returns spicy=true if it
 * was present. The flag takes no value. The flag is removed from `rest` so it
 * never reaches the pi SDK parser.
 */
export function extractSpicyFlag(args: string[]): { spicy: boolean; rest: string[] } {
	const rest = args.filter((a) => a !== "--spicy")
	return { spicy: rest.length !== args.length, rest }
}

/**
 * Apply the `--spicy` flag to the process environment and return the stripped argv.
 *
 * TEMPORARY (testing): the spicy variant is forced on for every launch,
 * regardless of whether `--spicy` was passed. The flag token is still stripped
 * from the returned array. To restore the opt-in behaviour, only set the env
 * var when `spicy` is true (see the commented-out conditional below).
 *
 * Pass an isolated env object in tests to avoid mutating `process.env`.
 */
export function applyVariantSelection(argv: string[], env: NodeJS.ProcessEnv): string[] {
	const { rest } = extractSpicyFlag(argv)
	// Restore opt-in behaviour by replacing the line below with:
	//   if (spicy) env[PROMPT_VARIANT_ENV] = "spicy"
	env[PROMPT_VARIANT_ENV] = "spicy"
	return rest
}

export { PROMPT_VARIANT_ENV }
