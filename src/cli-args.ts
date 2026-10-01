import { existsSync } from "node:fs"
import { parseArgs } from "node:util"
import { parseArgs as parsePiArgs } from "@earendil-works/pi-coding-agent"
import { type CliMode, getCliModeArg, PROTOCOL_MODES } from "./cli-modes.js"
import { resolveUserPath } from "./fs-paths.js"

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
	"session-id": undefined,
	name: "n",
	fork: undefined,
	"session-dir": undefined,
	models: undefined,
	tools: "t",
	"exclude-tools": undefined,
	thinking: undefined,
	export: undefined,
	extension: "e",
	skill: undefined,
	"prompt-template": undefined,
	theme: undefined,
	"use-theme": undefined,
	"tui-mode": undefined,
}

// Pi treats these as whole aliases, not POSIX short-option clusters.
const PI_LITERAL_ALIASES: Record<string, string> = {
	"-nt": "--no-tools",
	"-nbt": "--no-builtin-tools",
	"-ne": "--no-extensions",
	"-ns": "--no-skills",
	"-np": "--no-prompt-templates",
	"-nc": "--no-context-files",
	"-na": "--no-approve",
	"-xt": "--exclude-tools",
}

const PRE_DISPATCH_VALUE_FLAGS = new Set(
	Object.entries(PRE_DISPATCH_VALUE_FLAG_SHORTS).flatMap(([name, short]) =>
		short ? [`--${name}`, `-${short}`] : [`--${name}`],
	),
)

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
 */
export function stripMultiModelArgs(args: string[]): string[] {
	const result: string[] = []
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === "--multi-model") {
			continue
		}
		if (arg === "--model" && i + 1 < args.length && args[i + 1] === MULTI_MODEL_ID) {
			i += 1
			continue
		}
		if (arg === `--model=${MULTI_MODEL_ID}`) {
			continue
		}
		result.push(arg)
	}
	return result
}

export type CliOptionType = "string" | "boolean"

/** Virtual model id that enables multi-model orchestration mode. */
export const MULTI_MODEL_ID = "multi-model"

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
	worktree: {
		type: "string",
		short: "w",
		placeholder: "<branch>",
		description: "Start in a separate Git worktree; create or reuse the branch",
	},
	branch: {
		type: "string",
		placeholder: "<branch>",
		description: "Switch or create a Git branch in this checkout before starting",
	},
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
	models: {
		type: "string",
		description: "Comma-separated model ids the auto model picks from",
		placeholder: "<a,b>",
	},
	"multi-model": {
		type: "boolean",
		description: "Explicitly select multi-model orchestration (same as `--model multi-model`)",
	},
	"enable-experimental-features": {
		type: "boolean",
		description: "Enable experimental features, including the kimchi-dev/auto model",
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
	"mcp-config": {
		type: "string",
		description: "Use a specific MCP configuration file",
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
		"multi-model"?: boolean
		memory?: boolean
		thinking?: string
		mode?: string
		print?: boolean
		"no-session"?: boolean
		"allow-tool"?: string[]
		"deny-tool"?: string[]
		plan?: boolean
		auto?: boolean
		yolo?: boolean
		"dangerously-skip-permissions"?: boolean
		approve?: boolean
		"no-approve"?: boolean
		"permissions-config"?: string
		"mcp-config"?: string
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
// (or its short form, `-t --model`) cannot be mistaken for a model-selection
// flag by our cached parse.
for (const [name, short] of Object.entries(PRE_DISPATCH_VALUE_FLAG_SHORTS)) {
	PARSE_ARGS_OPTIONS[name] ??= { type: "string", ...(short ? { short } : {}) }
}

/** Option names that affect the running session and are cached in `SessionCliArgs`. */
export const CACHEABLE_OPTION_NAMES = [
	"provider",
	"model",
	"models",
	"multi-model",
	"thinking",
	"mode",
	"print",
	"no-session",
	"allow-tool",
	"deny-tool",
	"plan",
	"auto",
	"yolo",
	"dangerously-skip-permissions",
	"approve",
	"no-approve",
	"permissions-config",
	"mcp-config",
	"verbose",
] as const satisfies ReadonlyArray<keyof SessionCliArgs["options"]>

/** Parse args without caching. Exported for tests. */
export function parseCliArgs(args: string[]): SessionCliArgs {
	const { values, positionals } = parseArgs({
		args: normalizePiAliases(args),
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

function normalizePiAliases(args: string[]): string[] {
	const normalized = args.map((arg) =>
		arg.startsWith("-r") && arg.length > 2 ? `--session=${arg.slice(2)}` : (PI_LITERAL_ALIASES[arg] ?? arg),
	)
	const { tokens } = parseArgs({
		args: normalized,
		options: PARSE_ARGS_OPTIONS,
		strict: false,
		allowPositionals: true,
		tokens: true,
	})
	// An alias-shaped filename or prompt is a value, not an option.
	for (const token of tokens) {
		if (token.kind === "positional") normalized[token.index] = args[token.index]
		else if (token.kind === "option" && token.value !== undefined && !token.inlineValue) {
			normalized[token.index + 1] = args[token.index + 1]
		}
	}
	return normalized
}

/** Consume startup-only options before a fresh process initializes cwd-bound resources. */
export function takeWorkspaceArgs(
	args: string[],
	cwd: string,
):
	| {
			kind: "worktree" | "branch"
			name: string
			args: string[]
	  }
	| undefined {
	const { tokens } = parseArgs({
		args: normalizePiAliases(args),
		options: PARSE_ARGS_OPTIONS,
		strict: false,
		allowPositionals: true,
		tokens: true,
	})
	const options = tokens.filter((token) => token.kind === "option")
	const selections = options.filter((token) => token.name === "worktree" || token.name === "branch")
	if (
		!selections.length ||
		options.some((token) => ["help", "version", "list-models", "export"].includes(token.name))
	) {
		return undefined
	}
	if (selections.length !== 1) throw new Error("Choose one --worktree <branch> or --branch <branch>.")
	const selection = selections[0]
	if (selection.rawName === "-w" && !args[selection.index].startsWith("-w")) {
		throw new Error("Pass -w as a separate option, for example: -p -w fix/login.")
	}
	if (!selection.value) throw new Error(`--${selection.name} requires a branch name.`)
	const incompatible = options.find((token) => ["session", "resume", "r", "fork", "session-dir"].includes(token.name))
	if (incompatible) {
		throw new Error(
			`Cannot combine --${selection.name} with ${incompatible.rawName}. Use --continue to resume in the destination.`,
		)
	}
	if (options.some((token) => token.name === "mode" && (token.value === "acp" || token.value === "rpc"))) {
		throw new Error(
			"Worktree and branch launch options support terminal and print sessions. Set the working directory in your ACP/RPC client.",
		)
	}
	const forwarded = [...args]
	// Explicit CLI paths keep their caller-relative meaning after the child changes cwd.
	for (const token of tokens) {
		if (token.kind === "positional" && token.value.startsWith("@") && token.value !== "@") {
			forwarded[token.index] = `@${resolveUserPath(token.value.slice(1), cwd)}`
		} else if (token.kind === "option" && token.value) {
			const pathOption = ["extension", "skill", "prompt-template", "permissions-config", "mcp-config"].includes(
				token.name,
			)
			const fileOrText = ["system-prompt", "append-system-prompt", "theme"].includes(token.name)
			if (
				(pathOption && !/^(?:npm:|git:|https?:)/.test(token.value)) ||
				(fileOrText && existsSync(resolveUserPath(token.value, cwd)))
			) {
				const path = resolveUserPath(token.value, cwd)
				if (token.inlineValue) forwarded[token.index] = `${token.rawName}=${path}`
				else forwarded[token.index + 1] = path
			}
		}
	}
	forwarded.splice(selection.index, selection.inlineValue ? 1 : 2)
	return { kind: selection.name === "worktree" ? "worktree" : "branch", name: selection.value, args: forwarded }
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
