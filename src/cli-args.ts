import { parseArgs } from "node:util"
import { parseArgs as parsePiArgs } from "@earendil-works/pi-coding-agent"
import { type CliMode, getCliModeArg, PROTOCOL_MODES } from "./cli-modes.js"

// Re-export the shared leaf-module helpers so existing callers can keep
// importing them from cli-args.ts without touching their import paths.
export { type CliMode, getCliModeArg, hasExportFlag, hasPrintFlag, PROTOCOL_MODES } from "./cli-modes.js"

// Pre-dispatch scanners still need to skip values for raw scans. Keep the
// upstream value-taking flags here because pi's parser is not exposed as a
// value catalog; Kimchi-local string options are derived from CLI_OPTIONS below.
const PRE_DISPATCH_VALUE_FLAGS = new Set([
	"--provider",
	"--model",
	"--api-key",
	"--system-prompt",
	"--append-system-prompt",
	"--name",
	"-n",
	"--session",
	"--session-id",
	"--fork",
	"--session-dir",
	"--models",
	"--tools",
	"-t",
	"--exclude-tools",
	"-xt",
	"--thinking",
	"--export",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--tui-mode",
])

export function isPreDispatchValueFlag(arg: string): boolean {
	if (PRE_DISPATCH_VALUE_FLAGS.has(arg)) return true
	if (!arg.startsWith("--") || arg.includes("=")) return false
	const option = CLI_OPTIONS[arg.slice(2)]
	return option?.type === "string" && option.optional !== true
}

/** Return a removed multi-model flag so startup can fail with a clear message. */
export function findDeprecatedMultiModelFlag(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === "--") break
		const selectedModel = arg === "--model" ? args[i + 1] : arg.startsWith("--model=") ? arg.slice(8) : undefined
		if (
			selectedModel &&
			/^(?:(?:orchestration|kimchi-dev)\/)?multi-model(?::(?:off|minimal|low|medium|high|xhigh|max))?$/i.test(
				selectedModel,
			)
		) {
			return `--model ${selectedModel}`
		}
		if (isPreDispatchValueFlag(arg)) {
			i += 1
			continue
		}
		if (arg === "--multi-model" || arg.startsWith("--multi-model=")) return arg
	}
	return undefined
}

export type CliOptionType = "string" | "boolean"

export interface CliOptionDef {
	type: CliOptionType
	description: string
	/** Placeholder shown in help text for string options. */
	placeholder?: string
	/** Whether the value is optional (e.g. `--resume [id]`). Implies `type: "string"`. */
	optional?: boolean
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
		description: "Model id or pattern, optionally `provider/id` and/or `:<thinking>`.",
		placeholder: "<pattern>",
	},
	models: {
		type: "string",
		description: "Comma-separated model patterns for this session's model cycle",
		placeholder: "<patterns>",
	},
	"enable-experimental-features": {
		type: "boolean",
		description: "Enable experimental features",
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
		type: "string",
		optional: true,
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
		type: "string",
		optional: true,
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

/**
 * Parsed Kimchi-local CLI flags that affect the running session / model
 * selection. Only options listed in `CACHEABLE_OPTION_NAMES` are cached;
 * one-shot flags (help, version, export, resume, etc.) are handled before or
 * outside the session loop.
 */
export interface SessionCliArgs {
	options: {
		provider?: string
		model?: string
		models?: string
		thinking?: string
		mode?: string
		print?: boolean
		"no-session"?: boolean
		"allow-tool"?: string[]
		"deny-tool"?: string[]
		plan?: boolean
		auto?: boolean
		yolo?: boolean
		"permissions-config"?: string
		verbose?: boolean
	}
	positionals: string[]
}

let cachedCliArgs: SessionCliArgs | undefined

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
	if (def.optional || (def.type !== "string" && def.type !== "boolean")) continue
	PARSE_ARGS_OPTIONS[name] = {
		type: def.type,
		...(def.short ? { short: def.short } : {}),
		...(def.multiple ? { multiple: def.multiple } : {}),
	}
}
// Consume upstream option values so text such as --system-prompt "--model"
// cannot be mistaken for a model-selection flag by our cached parse.
for (const flag of PRE_DISPATCH_VALUE_FLAGS) {
	if (flag.startsWith("--")) PARSE_ARGS_OPTIONS[flag.slice(2)] ??= { type: "string" }
}

/** Option names that affect the running session and are cached in `SessionCliArgs`. */
const CACHEABLE_OPTION_NAMES = [
	"provider",
	"model",
	"models",
	"thinking",
	"mode",
	"print",
	"no-session",
	"allow-tool",
	"deny-tool",
	"plan",
	"auto",
	"yolo",
	"permissions-config",
	"verbose",
] as const satisfies ReadonlyArray<keyof SessionCliArgs["options"]>

/** Parse args without caching. Exported for tests. */
export function parseCliArgs(args: string[]): SessionCliArgs {
	// Pi accepts -xt as a single option, unlike node:util's grouped short flags.
	// Normalize only option positions; consumed values may themselves look like flags.
	const shortValueOptions: Record<string, string> = {
		"-n": "--name",
		"-e": "--extension",
		"-t": "--tools",
		"-xt": "--exclude-tools",
	}
	const normalizedArgs = [...args]
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--") break
		if (shortValueOptions[args[i]]) normalizedArgs[i] = shortValueOptions[args[i]]
		if (isPreDispatchValueFlag(args[i])) i += 1
	}
	const { values, positionals } = parseArgs({
		args: normalizedArgs,
		options: PARSE_ARGS_OPTIONS,
		strict: false,
		allowPositionals: true,
	})
	const options: SessionCliArgs["options"] = {}
	for (const key of CACHEABLE_OPTION_NAMES) {
		const value = values[key]
		if (value === undefined) continue
		;(options as Record<string, unknown>)[key] = value
	}
	return { options, positionals }
}

/** An inherited model is an explicit launch choice; command-line selection wins. */
export function applyModelEnvArgs(args: string[], model: string | undefined): string[] {
	if (!model) return args
	const { options } = parseCliArgs(args)
	if (options.model || options.provider || options.models) return args
	return ["--model", model, ...args]
}

/**
 * Return parsed Kimchi-local CLI flags.
 *
 * Uses the cached value set by `populateCliArgs()` if available; otherwise
 * falls back to parsing `process.argv.slice(2)`. This lets code loaded before
 * the main harness entry still resolve flags in a consistent way.
 */
export function getParsedCliArgs(): SessionCliArgs {
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

/** True when argv requests a ferment one-shot `--ferment-oneshot[=true]` or the
 * bare kwarg form. A headless one-shot planner still needs the ferment suite,
 * so suppression must compose. */
export function hasFermentOneshotArg(args: readonly string[]): boolean {
	return args.some((a) => a === "--ferment-oneshot" || a === "--ferment-oneshot=true" || a === "ferment-oneshot=true")
}

export function stripExperimentalFeaturesArg(args: string[]): string[] {
	return args.filter((a) => a !== "--enable-experimental-features")
}
