/**
 * CLI tool-allowlist coupling: allowing `bash` also allows `bash_control`.
 *
 * The background `bash` tool and its `bash_control` companion are
 * registered together (src/cli.ts), but upstream pi's `--tools` flag
 * filters tools BY NAME at registration: an allowlist that names `bash`
 * without `bash_control` keeps the background tool while dropping its
 * control tool. The model then receives handoff results that reference a
 * tool it cannot call, and the completion guard demands dispositions it
 * cannot make — the runaway documented in the background-bash bug report
 * (models polling /proc/<pid> and `sleep` loops for hundreds of turns).
 *
 * This module rewrites the `--tools` value BEFORE pi's `main()` parses it:
 * an allowlist that admits `bash` but not `bash_control` gets
 * `bash_control` appended, so the pair behaves like one tool.
 *
 * Exclusions are honored as an explicit opt-out: when `--exclude-tools`
 * names `bash_control` (exact name or pattern), nothing is appended and
 * the session's `bash` falls back to plain blocking execution with a
 * deterministic timeout instead (see ./bash-background-tool.ts — the
 * execute-time availability check is authoritative; this coupling is the
 * capability-preserving path).
 *
 * Matching semantics mirror upstream pi exactly, because the decision must
 * match what `AgentSessionConfig.allowedToolNames` will do with the list:
 *
 *  - list entries are comma-separated, trimmed, empties dropped
 *    (cli/args.js `--tools` branch);
 *  - a list mixing plain names with `+name`/`-name` modifiers, or a
 *    modifier containing `*`, is rejected by `getToolListError`
 *    (core/settings-manager.js) — the whole flag is ignored, so there is
 *    no allowlist and nothing to couple;
 *  - an all-modifier list changes the default selection instead of
 *    replacing it (allowedToolNames stays unset — extension tools stay
 *    registered), so nothing to couple either;
 *  - plain entries match by exact name or `*` pattern
 *    (`createToolNameMatcher`, core/mcp-servers.js).
 *
 * The argv scan reproduces pi's parser walk: `--` terminates flag
 * parsing, known value-taking flags consume the next token
 * unconditionally, `--mode` consumes a non-dash follower, unknown
 * `--flags` consume a follower that is not `-`/`@`-prefixed, and the
 * LAST `--tools`/`--exclude-tools` occurrence wins (later flags
 * overwrite earlier ones). Upstream drift in the flag list degrades
 * gracefully: a missed coupling falls through to the blocking-bash
 * fallback, never to the runaway.
 */
import { BASH_CONTROL_TOOL_NAME } from "./bash-control-tool.js"

/** The tool whose allowlisting implies its companion control tool. */
export const BASH_TOOL_NAME = "bash"

/**
 * Split one `--tools`/`--exclude-tools` value exactly like pi's parser
 * (cli/args.js): comma-separated, trimmed, empty entries dropped.
 */
export function parseToolListValue(raw: string): string[] {
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

/** `+name`/`-name` entries modify the default selection instead of replacing it. */
function isModifierEntry(entry: string): boolean {
	return entry.startsWith("+") || entry.startsWith("-")
}

/**
 * Whether pi rejects the whole `--tools` flag for this list
 * (`getToolListError`, core/settings-manager.js): modifiers mixed with
 * plain names, or a modifier containing a pattern. Such a flag leaves no
 * allowlist at all.
 */
export function isInvalidToolList(entries: readonly string[]): boolean {
	const modifiers = entries.filter(isModifierEntry)
	if (modifiers.length === 0) return false
	if (modifiers.length < entries.length) return true
	return modifiers.some((entry) => entry.includes("*"))
}

/**
 * Name matcher mirroring pi's `createToolNameMatcher` (core/mcp-servers.js,
 * not re-exported at the package root): exact names plus `*` patterns,
 * where `*` matches any run of characters and everything else is literal.
 */
export function createToolNameMatcher(entries: readonly string[]): (name: string) => boolean {
	const names = new Set(entries.filter((entry) => !entry.includes("*")))
	const patterns = entries
		.filter((entry) => entry.includes("*"))
		.map((pattern) => {
			const source = pattern
				.split("*")
				.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
				.join(".*")
			return new RegExp(`^${source}$`)
		})
	return (name: string) => names.has(name) || patterns.some((pattern) => pattern.test(name))
}

/**
 * Resolve the coupling for one parsed `--tools` list: the entries to append
 * so `bash`'s companion control tool is callable. Empty when the list
 * needs no coupling (no allowlist, `bash` not admitted, `bash_control`
 * already admitted) or when `--exclude-tools` explicitly opts out.
 */
export function resolveBashControlCoupling(
	tools: readonly string[] | undefined,
	excludeTools: readonly string[] | undefined,
): string[] {
	// No explicit list, an empty list (nothing is allowed — including bash),
	// or a list pi rejects / treats as modifiers: no allowlist to couple.
	if (!tools || tools.length === 0 || isInvalidToolList(tools)) return []
	const allowed = createToolNameMatcher(tools)
	if (!allowed(BASH_TOOL_NAME)) return []
	if (allowed(BASH_CONTROL_TOOL_NAME)) return []
	// Explicit exclusion is an intentional opt-out: honor it — the session
	// runs the blocking-bash fallback instead of background execution.
	if (excludeTools && excludeTools.length > 0 && createToolNameMatcher(excludeTools)(BASH_CONTROL_TOOL_NAME)) {
		return []
	}
	return [BASH_CONTROL_TOOL_NAME]
}

/**
 * Flags pi's parser consumes a value for unconditionally (the token after
 * the flag is its value even when it looks like another flag). Mirrors the
 * value-taking branches of cli/args.js `parseArgs`.
 */
const PI_VALUE_FLAGS = new Set([
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
])

/**
 * Rewrite `args` so a `--tools` allowlist admitting `bash` also admits
 * `bash_control`. Returns the input array (same identity) when no coupling
 * applies; otherwise a copy with the last `--tools`/`-t` value extended by
 * `,bash_control`. The scan mirrors pi's parse walk (see module docstring).
 */
export function coupleBashControlToolArg(args: readonly string[]): string[] {
	let toolsValueIndex = -1
	let tools: string[] | undefined
	let excludeTools: string[] | undefined
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		// pi stops flag parsing at `--`; the rest are prompt messages.
		if (arg === "--") break
		if (PI_VALUE_FLAGS.has(arg)) {
			// A trailing value flag is ignored by pi (i + 1 check).
			if (i + 1 >= args.length) break
			const value = args[++i]
			if (arg === "--tools" || arg === "-t") {
				toolsValueIndex = i
				tools = parseToolListValue(value)
			} else if (arg === "--exclude-tools" || arg === "-xt") {
				excludeTools = parseToolListValue(value)
			}
			continue
		}
		if (arg === "--mode") {
			// --mode consumes its value only when it is not dash-prefixed.
			const next = args[i + 1]
			if (next !== undefined && !next.startsWith("-")) i++
			continue
		}
		if (arg.startsWith("--")) {
			// Unknown long flags: `--flag=value` is self-contained; a bare
			// `--flag` consumes a follower that is not `-`/`@`-prefixed.
			if (arg.includes("=")) continue
			const next = args[i + 1]
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) i++
		}
		// Single-dash unknowns, `@file` args, and bare positionals consume
		// no value in pi's parser.
	}
	if (toolsValueIndex < 0 || !tools) return args as string[]
	const append = resolveBashControlCoupling(tools, excludeTools)
	if (append.length === 0) return args as string[]
	const coupled = [...args]
	coupled[toolsValueIndex] = `${args[toolsValueIndex]},${append.join(",")}`
	return coupled
}
