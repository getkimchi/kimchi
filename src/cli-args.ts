import { parseArgs } from "node:util"
import { parseArgs as parsePiArgs } from "@earendil-works/pi-coding-agent"
import { type CliMode, getCliModeArg, PROTOCOL_MODES } from "./cli-modes.js"

// Re-export the shared leaf-module helpers so existing callers can keep
// importing them from cli-args.ts without touching their import paths.
export { type CliMode, getCliModeArg, hasExportFlag, hasPrintFlag, PROTOCOL_MODES } from "./cli-modes.js"

// Pre-dispatch scanners still need to skip values for Kimchi-local raw scans
// such as `--mode acp`, which upstream pi does not parse.
//
// Each entry maps a long value-taking flag to its single-letter alias, if any.
// Both forms must reach `PARSE_ARGS_OPTIONS` below: a short flag that parseArgs
// does not know consumes a value would leave the following token (e.g. `-t
// --model`) to be parsed as an explicit model selection.
const PRE_DISPATCH_VALUE_FLAG_SHORTS: Record<string, string | undefined> = {
	provider: undefined,
	model: undefined,
	"api-key": undefined,
	"system-prompt": undefined,
	"append-system-prompt": undefined,
	session: undefined,
	fork: undefined,
	"session-dir": undefined,
	models: undefined,
	tools: "t",
	thinking: undefined,
	export: undefined,
	extension: "e",
	skill: undefined,
	additionalSkillsPaths: undefined,
	"prompt-template": undefined,
	theme: undefined,
}

const PRE_DISPATCH_VALUE_FLAGS = new Set(
	Object.entries(PRE_DISPATCH_VALUE_FLAG_SHORTS).flatMap(([name, short]) =>
		short ? [`--${name}`, `-${short}`] : [`--${name}`],
	),
)

export function isPreDispatchValueFlag(arg: string): boolean {
	return PRE_DISPATCH_VALUE_FLAGS.has(arg)
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
		description: "Comma-separated model ids the auto model picks from",
		placeholder: "<a,b>",
	},
	"enable-experimental-features": {
		type: "boolean",
		description: "Enable experimental features, such as kimchi-experimental models and the background daemon",
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
	"pr-watch": {
		type: "boolean",
		description: "Watch the PR for this session's branch (read-only; /pr-watch enables fixes)",
	},
	auto: {
		type: "boolean",
		description: "Start in auto mode (run freely, classifier guards)",
	},
	yolo: {
		type: "boolean",
		description: "Start in yolo mode (run freely, no classifier; deny rules still apply - DANGER)",
	},
	"dangerously-skip-permissions": {
		type: "boolean",
		description: "Skip all permission checks (DANGER)",
	},
	approve: {
		type: "boolean",
		short: "a",
		description: "Trust project-local files for this run",
	},
	"no-approve": {
		type: "boolean",
		description: "Ignore project-local files for this run",
	},
	"permissions-config": {
		type: "string",
		description: "Replace the merged permissions config with this file",
		placeholder: "<path>",
	},
	"bash-process-limit": {
		type: "string",
		description: "Absolute per-process safety limit for background bash commands, in seconds (default 3600)",
		placeholder: "<seconds>",
	},
	"mcp-config": {
		type: "string",
		description: "Use a specific MCP configuration file",
		placeholder: "<path>",
	},
	additionalSkillsPaths: {
		type: "string",
		multiple: true,
		description: "Additional skill root directories (repeatable)",
		placeholder: "<path>",
	},
	verbose: {
		type: "boolean",
		description: "Force verbose startup (overrides quietStartup)",
	},
	"no-auto-update": {
		type: "boolean",
		description: "Skip background updates for this session",
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
		memory?: boolean
		thinking?: string
		mode?: string
		print?: boolean
		"no-session"?: boolean
		"allow-tool"?: string[]
		"deny-tool"?: string[]
		plan?: boolean
		"pr-watch"?: boolean
		auto?: boolean
		yolo?: boolean
		"dangerously-skip-permissions"?: boolean
		approve?: boolean
		"no-approve"?: boolean
		"permissions-config"?: string
		"bash-process-limit"?: string
		"mcp-config"?: string
		additionalSkillsPaths?: string[]
		verbose?: boolean
		"no-auto-update"?: boolean
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
	// Validate the raw --additionalSkillsPaths occurrences before any cached
	// value is consumed: node:util parseArgs (strict:false) reports a dangling
	// flag as boolean `true` and `--additionalSkillsPaths --` as the path value
	// `"--"`, and either would spread into ACP loader options or non-ACP
	// discovery as a bogus root.
	assertAdditionalSkillPathsWellFormed(args)
	const parsed = parseCliArgs(args)
	// Validate eagerly so an invalid operator value fails fast with a clear
	// error instead of surfacing mid-session from the first bash call.
	resolveBashProcessLimitSeconds(parsed)
	cachedCliArgs = parsed
}

/**
 * Resolve the configured background-bash process safety limit in seconds.
 * Returns undefined when the flag is absent (callers apply their default).
 * Throws for values that are not a finite positive integer — this flag is
 * operator-only configuration and invalid input must be a startup error.
 */
export function resolveBashProcessLimitSeconds(parsed: SessionCliArgs = getParsedCliArgs()): number | undefined {
	const raw = parsed.options["bash-process-limit"]
	if (raw === undefined) return undefined
	if (!/^\d+$/.test(raw.trim())) {
		throw new Error(`Invalid --bash-process-limit value "${raw}": expected a positive integer number of seconds.`)
	}
	const seconds = Number.parseInt(raw.trim(), 10)
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`Invalid --bash-process-limit value "${raw}": expected a positive integer number of seconds.`)
	}
	return seconds
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
// (or its short form, `-t --model`) cannot be mistaken for a model-selection
// flag by our cached parse.
for (const [name, short] of Object.entries(PRE_DISPATCH_VALUE_FLAG_SHORTS)) {
	PARSE_ARGS_OPTIONS[name] ??= { type: "string", ...(short ? { short } : {}) }
}

/** Tokens that consume the following token as their value, per the derived
 * parseArgs schema (long and short forms). Used to tell a value-position token
 * (e.g. the `--additionalSkillsPaths` in `--system-prompt
 * --additionalSkillsPaths`) apart from a standalone flag occurrence. */
const VALUE_FLAG_TOKENS = new Set<string>(
	Object.entries(PARSE_ARGS_OPTIONS).flatMap(([name, opt]) =>
		opt.type === "string" ? [`--${name}`, ...(opt.short ? [`-${opt.short}`] : [])] : [],
	),
)

/** Option names that affect the running session and are cached in `SessionCliArgs`. */
export const CACHEABLE_OPTION_NAMES = [
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
	"pr-watch",
	"auto",
	"yolo",
	"dangerously-skip-permissions",
	"approve",
	"no-approve",
	"permissions-config",
	"bash-process-limit",
	"mcp-config",
	"additionalSkillsPaths",
	"verbose",
	"no-auto-update",
] as const satisfies ReadonlyArray<keyof SessionCliArgs["options"]>

/** Parse args without caching. Exported for tests. */
export function parseCliArgs(args: string[]): SessionCliArgs {
	const { values, positionals } = parseArgs({
		args,
		options: PARSE_ARGS_OPTIONS,
		strict: false,
		allowPositionals: true,
	})
	const options: SessionCliArgs["options"] = {}
	for (const key of CACHEABLE_OPTION_NAMES) {
		let value = values[key]
		if (value === undefined) continue
		// node:util parseArgs with strict:false returns the raw string for
		// `--flag=value` even when the flag is declared boolean. For boolean
		// flags, accept only the explicit =true/=false forms — anything else
		// (e.g. --memory=1) would store a string into a boolean-typed option,
		// making `=== true` and truthiness checks disagree.
		if (CLI_OPTIONS[key]?.type === "boolean" && typeof value === "string") {
			if (value !== "true" && value !== "false") {
				throw new Error(`--${key} expects a boolean (=true or =false); got --${key}=${JSON.stringify(value)}`)
			}
			value = value === "true"
		}
		;(options as Record<string, unknown>)[key] = value
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

/** True when the parsed `--mode` value selects a protocol (non-TUI) CLI mode. */
export function isProtocolCliMode(mode: string | undefined): boolean {
	return mode !== undefined && PROTOCOL_MODES.has(mode as CliMode)
}

export function isProtocolOrPrintMode(args: string[]): boolean {
	const parsed = parsePiArgs(args)
	const mode = parsed.mode ?? getCliModeArg(args)
	return isProtocolCliMode(mode) || parsed.print === true
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

/**
 * Remove Kimchi-local `--additionalSkillsPaths` flags from raw argv before
 * upstream pi parses it — never rewrite them to another option.
 *
 * Recognizes the separated (`--additionalSkillsPaths <path>`) and equals
 * (`--additionalSkillsPaths=<path>`) forms and drops the flag and its value
 * token. Everything else — including explicit upstream `--skill` flags,
 * prompt positionals, and unrelated options — passes through untouched. A
 * `--additionalSkillsPaths` token that is itself the value of another option
 * (as in `--system-prompt --additionalSkillsPaths`) is left verbatim: it is
 * not a standalone flag occurrence. A dangling standalone
 * `--additionalSkillsPaths` (no following value, or followed by a bare `--`)
 * is simply dropped so the Kimchi-local flag never reaches pi; startup
 * validation reports the missing value. The first bare `--` ends option
 * parsing: every token after it is positional and is copied verbatim.
 */
export function stripAdditionalSkillsPathsArg(args: string[]): string[] {
	const occurrences = scanAdditionalSkillsPathsArgs(args)
	if (occurrences.length === 0) return args
	const dropped = new Set<number>()
	for (const occurrence of occurrences) {
		dropped.add(occurrence.index)
		if (occurrence.valueIndex !== undefined) dropped.add(occurrence.valueIndex)
	}
	return args.filter((_, index) => !dropped.has(index))
}

/** A standalone `--additionalSkillsPaths` occurrence in raw argv. */
interface AdditionalSkillsPathsOccurrence {
	/** Index of the flag token itself. */
	index: number
	/** Index of the token holding the value, for the separated form. */
	valueIndex?: number
	/** The path value. Undefined for a dangling flag (terminal or before a bare `--`). */
	value?: string
}

/**
 * Scan raw argv left-to-right, classifying every actual standalone
 * `--additionalSkillsPaths` occurrence with the same value-position and
 * bare-`--` rules node:util.parseArgs applies:
 *
 * - a token directly after a value-taking option (VALUE_FLAG_TOKENS, long or
 *   short form) is that option's value, never a standalone flag, even when it
 *   is flag-shaped;
 * - the first bare `--` ends option parsing: everything after it is
 *   positional and is never scanned;
 * - a following bare `--` is the option-terminator, not a path value: the
 *   occurrence is dangling.
 */
function scanAdditionalSkillsPathsArgs(args: string[]): AdditionalSkillsPathsOccurrence[] {
	const occurrences: AdditionalSkillsPathsOccurrence[] = []
	let inValuePosition = false
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]
		if (inValuePosition) {
			inValuePosition = false
			continue
		}
		if (arg === "--") return occurrences
		if (arg.startsWith("--additionalSkillsPaths=")) {
			occurrences.push({ index: i, value: arg.slice("--additionalSkillsPaths=".length) })
			continue
		}
		if (arg === "--additionalSkillsPaths") {
			const next = i + 1 < args.length ? args[i + 1] : undefined
			if (next !== undefined && next !== "--") {
				occurrences.push({ index: i, valueIndex: i + 1, value: next })
				i += 1
			} else {
				occurrences.push({ index: i })
			}
			continue
		}
		inValuePosition = VALUE_FLAG_TOKENS.has(arg)
	}
	return occurrences
}

/**
 * Reject malformed raw `--additionalSkillsPaths` occurrences with a clear
 * startup error, using the strip helper's scan rules. Rejects a terminal
 * standalone flag, an empty `--additionalSkillsPaths=`, and
 * `--additionalSkillsPaths --` (which node parses as the path value `"--"`).
 * Never rejects local-looking tokens belonging to another value-taking
 * option nor tokens after a bare `--`.
 */
export function assertAdditionalSkillPathsWellFormed(args: string[]): void {
	for (const occurrence of scanAdditionalSkillsPathsArgs(args)) {
		if (occurrence.value === undefined || occurrence.value === "") {
			throw new Error("--additionalSkillsPaths requires a path")
		}
	}
}

/**
 * Validated process-scoped additional skill roots (typed empty array when the
 * flag is absent). Raw occurrences are validated by populateCliArgs, so no
 * boolean `true` or `"--"` pseudo-value can reach consumers here.
 */
export function resolveAdditionalSkillPaths(parsed: SessionCliArgs = getParsedCliArgs()): string[] {
	return parsed.options.additionalSkillsPaths ?? []
}

/** Kimchi Studio still starts new terminal sessions with `--model multi-model`.
 *  Dropping that pair lets those launches start on the default model instead
 *  of failing with "model not found".
 *  ponytail: one-release bridge; remove once Studio stops passing it
 *  (kimchi-studio `ptyHandlers.ts` `buildModelArgs`). */
export function dropRetiredMultiModelArg(args: string[]): string[] {
	const kept: string[] = []
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--model" && args[i + 1] === "multi-model") {
			i += 1
			continue
		}
		if (args[i] === "--model=multi-model") continue
		kept.push(args[i])
	}
	return kept
}
