import { parseArgs } from "node:util"
import { parseArgs as parsePiArgs } from "@earendil-works/pi-coding-agent"
import { type CliMode, getCliModeArg, PROTOCOL_MODES } from "./cli-modes.js"

// Re-export the shared leaf-module helpers so existing callers can keep
// importing them from cli-args.ts without touching their import paths.
export { type CliMode, getCliModeArg, hasExportFlag, hasPrintFlag, PROTOCOL_MODES } from "./cli-modes.js"

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

/**
 * Strip virtual multi-model CLI arguments from the args list before passing
 * them upstream. Upstream pi-mono does not recognize "multi-model" as a model
 * id, so we translate these flags into the multi-model side-channel instead.
 *
 * Recognizes:
 *   --multi-model
 *   --model multi-model
 *   --model=multi-model
 *
 * Returns the filtered args and whether multi-model was explicitly requested.
 */
export function stripMultiModelArgs(args: string[]): { args: string[]; explicitMultiModel: boolean } {
	let explicitMultiModel = false
	const result: string[] = []
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === "--multi-model") {
			explicitMultiModel = true
			continue
		}
		if (arg === "--model" && i + 1 < args.length && args[i + 1] === "multi-model") {
			explicitMultiModel = true
			i += 1
			continue
		}
		if (arg === "--model=multi-model") {
			explicitMultiModel = true
			continue
		}
		result.push(arg)
	}
	return { args: result, explicitMultiModel }
}

export type CliOptionType = "string" | "boolean" | "optional-string"

export interface CliOptionDef {
	type: CliOptionType
	description: string
	/** Placeholder shown in help text for string options. */
	placeholder?: string
	/** Single-letter short alias (without the leading `-`). */
	short?: string
	/** Whether the option can be specified multiple times. */
	multiple?: boolean
}

/**
 * Kimchi-local CLI flags.
 *
 * Single source of truth for flag names, types, short aliases, placeholders,
 * and descriptions. Help text is generated from this object. The centralized
 * parser uses the subset of flags with `type: "string" | "boolean"`.
 */
export const CLI_OPTIONS: Record<string, CliOptionDef> = {
	provider: {
		type: "string",
		description: "Provider (default: kimchi-dev)",
		placeholder: "<name>",
	},
	model: {
		type: "string",
		description:
			"Model id or pattern, optionally `provider/id` and/or `:<thinking>`. Use `multi-model` for orchestrated multi-model mode.",
		placeholder: "<pattern>",
	},
	"multi-model": {
		type: "boolean",
		description: "Explicitly select multi-model orchestration (same as `--model multi-model`)",
	},
	thinking: {
		type: "string",
		description: "Thinking level: off, minimal, low, medium, high, xhigh, max",
		placeholder: "<level>",
	},
	mode: {
		type: "string",
		description: "Output mode: text (default), json, rpc, acp",
		placeholder: "<mode>",
	},
	print: {
		type: "boolean",
		short: "p",
		description: "Non-interactive mode: process prompt and exit",
	},
	continue: {
		type: "boolean",
		short: "c",
		description: "Resume the most recent session",
	},
	resume: {
		type: "optional-string",
		short: "r",
		description: "Resume by id, or pick a previous session interactively when omitted",
		placeholder: "[id]",
	},
	session: {
		type: "string",
		description: "Resume a specific session file (full path or partial UUID)",
		placeholder: "<path>",
	},
	"no-session": {
		type: "boolean",
		description: "Run ephemerally — don't write a session file",
	},
	export: {
		type: "string",
		description: "Export a session to HTML and exit",
		placeholder: "<file>",
	},
	"list-models": {
		type: "optional-string",
		description: "Print available models (optionally fuzzy-filtered)",
		placeholder: "[search]",
	},
	"allow-tool": {
		type: "string",
		multiple: true,
		description: "Add session permission allow rules (comma-separated)",
		placeholder: "<rule>",
	},
	"deny-tool": {
		type: "string",
		multiple: true,
		description: "Add session permission deny rules (comma-separated)",
		placeholder: "<rule>",
	},
	plan: {
		type: "boolean",
		description: "Start in plan mode (read-only)",
	},
	auto: {
		type: "boolean",
		description: "Start in auto mode (run freely, classifier guards)",
	},
	yolo: {
		type: "boolean",
		description: "Start in yolo mode (run freely, no classifier - DANGER)",
	},
	"permissions-config": {
		type: "string",
		description: "Replace the merged permissions config with this file",
		placeholder: "<path>",
	},
	verbose: {
		type: "boolean",
		description: "Force verbose startup (overrides quietStartup)",
	},
	help: {
		type: "boolean",
		short: "h",
		description: "Show this help",
	},
	version: {
		type: "boolean",
		short: "v",
		description: "Show the kimchi version",
	},
}

/** Parsed Kimchi-local CLI flags. Populated once at startup. */
export interface CliArgs {
	options: {
		provider?: string
		model?: string
		thinking?: string
		mode?: string
		print?: boolean
		continue?: boolean
		session?: string
		"no-session"?: boolean
		export?: string
		"allow-tool"?: string[]
		"deny-tool"?: string[]
		plan?: boolean
		auto?: boolean
		yolo?: boolean
		"permissions-config"?: string
		verbose?: boolean
		help?: boolean
		version?: boolean
	}
	positionals: string[]
}

let cachedCliArgs: CliArgs | undefined

/**
 * Parse Kimchi-local CLI flags and cache the result. Should be called once
 * from cli.ts after @file args and resume-id aliases have been normalized,
 * so the rest of the harness reads the same argument list that upstream will
 * receive.
 */
export function populateCliArgs(args: string[]): void {
	cachedCliArgs = parseCliArgs(args)
}

/** Schema `node:util.parseArgs` expects, derived once from `CLI_OPTIONS`. */
const PARSE_ARGS_OPTIONS: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> = {}
for (const [name, def] of Object.entries(CLI_OPTIONS)) {
	if (def.type !== "string" && def.type !== "boolean") continue
	PARSE_ARGS_OPTIONS[name] = {
		type: def.type,
		...(def.short ? { short: def.short } : {}),
		...(def.multiple ? { multiple: def.multiple } : {}),
	}
}

/** Parse args without caching. Exported for tests. */
export function parseCliArgs(args: string[]): CliArgs {
	const { values, positionals } = parseArgs({
		args,
		options: PARSE_ARGS_OPTIONS,
		strict: false,
		allowPositionals: true,
	})
	const { "multi-model": _, ...rest } = values as Record<string, unknown>
	const options = rest as CliArgs["options"]
	if (values["multi-model"] === true) {
		options.model = "multi-model"
	}
	return { options, positionals }
}

/**
 * Return parsed Kimchi-local CLI flags.
 *
 * Uses the cached value set by `populateCliArgs()` if available; otherwise
 * falls back to parsing `process.argv.slice(2)`. This lets code loaded before
 * the main harness entry still resolve flags in a consistent way.
 */
export function getParsedCliArgs(): CliArgs {
	if (!cachedCliArgs) {
		cachedCliArgs = parseCliArgs(process.argv.slice(2))
	}
	return cachedCliArgs
}

export function normalizeResumeIdArgs(args: string[]): string[] {
	const normalized: string[] = []
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]
		if (arg.startsWith("--resume=") && arg.length > "--resume=".length) {
			normalized.push("--session", arg.slice("--resume=".length))
		} else if (arg.startsWith("-r") && arg.length > 2) {
			normalized.push("--session", arg.slice(2))
		} else if ((arg === "-r" || arg === "--resume") && i + 1 < args.length && isSessionSelector(args[i + 1])) {
			normalized.push("--session", args[i + 1])
			i += 1
		} else {
			normalized.push(arg)
		}
	}
	return normalized
}

function isSessionSelector(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || isPathLike(value)
}

function isPathLike(value: string): boolean {
	return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/")
}

export function isCliAtFileArg(arg: string, index: number, args: string[]): boolean {
	if (!arg.startsWith("@") || arg === "@") return false
	// Use Pi's parser as the source of truth instead of mirroring every value-taking flag.
	return parsePiArgs(args.slice(0, index + 1)).fileArgs.length > parsePiArgs(args.slice(0, index)).fileArgs.length
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
	return (mode !== undefined && PROTOCOL_MODES.has(mode as CliMode)) || parsed.print === true
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
