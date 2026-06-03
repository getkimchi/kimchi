import { parseArgs as parsePiArgs } from "@earendil-works/pi-coding-agent"

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
