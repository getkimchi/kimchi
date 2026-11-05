/**
 * CLI tool-allowlist coupling: `bash` and `bash_control` are always enabled
 * and disabled together.
 *
 * The background `bash` tool and its `bash_control` companion are
 * registered together (src/cli.ts), but upstream pi's `--tools` and
 * `--exclude-tools` flags filter tools BY NAME at registration — so an
 * allowlist that names `bash` without `bash_control` keeps the background
 * tool while dropping its control tool, and a denylist naming only one
 * member splits the pair the same way. The model then receives handoff
 * results that reference a tool it cannot call, and the completion guard
 * demands dispositions it cannot make — the runaway documented in the
 * background-bash bug report (models polling /proc/<pid> and `sleep`
 * loops for hundreds of turns).
 *
 * This module rewrites the flag values BEFORE pi's `main()` parses them,
 * making the pair atomic — either both are available or neither is:
 *
 *  - a `--tools` allowlist that admits `bash` but not `bash_control` gets
 *    `bash_control` appended;
 *  - `--exclude-tools` naming either member (`bash` or `bash_control`,
 *    exact name or pattern) gets the other appended, so both tools go
 *    away — `bash_control` cannot be excluded separately from `bash`,
 *    because background `bash` without its control tool is the runaway
 *    state this coupling exists to prevent.
 *
 * (pi applies `--exclude-tools` over the allowlist, so the extended
 * denylist is authoritative: `--tools bash --exclude-tools bash_control`
 * disables both.) The execute-time availability check in
 * ./bash-background-tool.ts stays as the safety net for restriction paths
 * that bypass this rewrite (dynamic tool-set changes, custom extensions).
 *
 * Matching semantics mirror upstream pi exactly, because the decision must
 * match what `AgentSessionConfig.allowedToolNames`/`excludedToolNames` will
 * do with the lists:
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
 * The pair coupling decision for one parsed argv: what to append to the
 * `--tools` allowlist and to the `--exclude-tools` denylist so `bash` and
 * `bash_control` are enabled and disabled together (they are registered
 * together, and the control tool exists to manage the bash tool's
 * background processes — neither tool is useful without the other).
 */
export interface BashControlCoupling {
	/** Entries to append to the `--tools` allowlist. */
	appendTools: string[]
	/** Entries to append to the `--exclude-tools` denylist. */
	appendExclusions: string[]
}

/** The empty coupling (nothing to rewrite). */

/**
 * Resolve the pair coupling for parsed `--tools`/`--exclude-tools` values:
 *
 *  - Allowlist: a list that admits `bash` but not `bash_control` gets the
 *    companion appended, so a session that can start background commands
 *    can always stop, inspect, or wait on them.
 *  - Denylist: `bash_control` cannot be excluded separately from `bash`.
 *    Excluding either member excludes both — the pair is all-or-nothing.
 *    (pi applies `--exclude-tools` over the allowlist, so extending the
 *    denylist is authoritative.)
 */
export function resolveBashControlCoupling(
	tools: readonly string[] | undefined,
	excludeTools: readonly string[] | undefined,
): BashControlCoupling {
	const excluded = excludeTools && excludeTools.length > 0 ? createToolNameMatcher(excludeTools) : undefined
	const bashExcluded = excluded?.(BASH_TOOL_NAME) === true
	const controlExcluded = excluded?.(BASH_CONTROL_TOOL_NAME) === true

	// Denylist coupling: excluding one member excludes the whole tool.
	const appendExclusions: string[] = []
	if (controlExcluded && !bashExcluded) appendExclusions.push(BASH_TOOL_NAME)
	if (bashExcluded && !controlExcluded) appendExclusions.push(BASH_CONTROL_TOOL_NAME)

	// Allowlist coupling: only when the allowlist itself is in play (an
	// explicit non-modifier list) and the pair is not being excluded anyway.
	// No list, an empty list (nothing is allowed — including bash), or a list
	// pi rejects / treats as modifiers: no allowlist to couple.
	if (!tools || tools.length === 0 || isInvalidToolList(tools)) {
		return { appendTools: [], appendExclusions }
	}
	const allowed = createToolNameMatcher(tools)
	if (!allowed(BASH_TOOL_NAME) || allowed(BASH_CONTROL_TOOL_NAME)) {
		return { appendTools: [], appendExclusions }
	}
	// An exclusion of either member removes the whole pair, so there is
	// nothing left for the allowlist to couple.
	if (bashExcluded || controlExcluded) return { appendTools: [], appendExclusions }
	return { appendTools: [BASH_CONTROL_TOOL_NAME], appendExclusions }
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
	let excludeValueIndex = -1
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
				excludeValueIndex = i
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
			// `--flag` consumes a follower that is not `-`/`@`-prefixed. Note
			// `--tools=value` lands HERE, not in the coupling: pi's parser only
			// accepts the space-separated form, so the equals form creates no
			// allowlist at all (documented in tool-coupling.test.ts).
			if (arg.includes("=")) continue
			const next = args[i + 1]
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) i++
		}
		// Single-dash unknowns, `@file` args, and bare positionals consume
		// no value in pi's parser.
	}
	if ((toolsValueIndex < 0 || !tools) && excludeValueIndex < 0) return args as string[]
	const { appendTools, appendExclusions } = resolveBashControlCoupling(tools, excludeTools)
	if (appendTools.length === 0 && appendExclusions.length === 0) return args as string[]
	const coupled = [...args]
	if (toolsValueIndex >= 0 && tools && appendTools.length > 0) {
		coupled[toolsValueIndex] = `${args[toolsValueIndex]},${appendTools.join(",")}`
	}
	if (excludeValueIndex >= 0 && appendExclusions.length > 0) {
		coupled[excludeValueIndex] = `${args[excludeValueIndex]},${appendExclusions.join(",")}`
	}
	return coupled
}
