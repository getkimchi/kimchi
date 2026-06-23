import { type ControlOperator, type ParseEntry, parse as parseShell } from "shell-quote"
import type { ToolCategory } from "./types.js"

export const FILE_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"])

const STATIC_CATEGORIES: Record<string, ToolCategory> = {
	read: "readOnly",
	grep: "readOnly",
	find: "readOnly",
	ls: "readOnly",
	edit: "write",
	write: "write",
	bash: "execute",
	web_search: "readOnly",
	web_fetch: "readOnly",
	questionnaire: "readOnly",
	set_phase: "readOnly",
}

const READ_ONLY_NAME_HINT = /^(read|get|list|search|query|describe|find|grep|ls|loki_|view|show)/i

// Verbs at the start of an underscore-separated segment that signal a read-only
// operation on namespaced MCP direct tools like `jetbrains_get_all_open_file_paths`
// or `supabase_list_tables`. We require an exact segment-position match (not a
// substring) to avoid false positives — e.g. server names that happen to contain
// `get` should not flip the classification.
const READ_ONLY_VERB_SEGMENTS = new Set([
	"read",
	"get",
	"list",
	"search",
	"query",
	"describe",
	"find",
	"grep",
	"ls",
	"view",
	"show",
	"preview",
	"inspect",
])

function hasReadOnlyVerbSegment(toolName: string): boolean {
	const lower = toolName.toLowerCase()
	if (!lower.includes("_")) return false
	// Skip the first segment (typically the server/namespace prefix) so a
	// namespace called "list" or "get" doesn't blanket-mark every tool
	// underneath it as read-only. Verbs in any subsequent segment count.
	const segments = lower.split("_")
	for (let i = 1; i < segments.length; i++) {
		if (READ_ONLY_VERB_SEGMENTS.has(segments[i])) return true
	}
	return false
}

export function classifyTool(toolName: string): ToolCategory {
	const lower = toolName.toLowerCase()
	if (lower in STATIC_CATEGORIES) return STATIC_CATEGORIES[lower]

	if (toolName.startsWith("mcp__")) {
		const last = toolName.split("__").pop() ?? ""
		if (READ_ONLY_NAME_HINT.test(last)) return "readOnly"
		return "unknown"
	}

	if (READ_ONLY_NAME_HINT.test(toolName)) return "readOnly"
	// MCP direct tools (with toolPrefix: "server") arrive flattened to a single
	// underscore-separated name. Inspect post-prefix verb segments so they're
	// not all stranded as "unknown" in plan mode.
	if (hasReadOnlyVerbSegment(toolName)) return "readOnly"
	return "unknown"
}

export function isReadOnlyTool(toolName: string): boolean {
	return classifyTool(toolName) === "readOnly"
}

// Programs safe to invoke with any arguments: they read files or system state
// but cannot execute other programs, write files (beyond stdout), or mutate
// system state. If you need to add a program here, confirm it has no flag that
// runs a subcommand (-exec, -c, -e, --output, etc.) or writes outside stdout.
// NOTE: cd/pushd/popd are included — they only change process cwd, no files.
const READ_ONLY_PROGRAMS = new Set([
	"cat",
	"head",
	"tail",
	"ls",
	"pwd",
	"cd",
	"pushd",
	"popd",
	"echo",
	"printf",
	"wc",
	"sort",
	"uniq",
	"file",
	"stat",
	"du",
	"df",
	"tree",
	"which",
	"whereis",
	"type",
	"printenv",
	"uname",
	"whoami",
	"id",
	"date",
	"cal",
	"uptime",
	"ps",
	"top",
	"htop",
	"free",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"fd",
	"jq",
	"yq",
	"bat",
	"eza",
	"column",
	"basename",
	"dirname",
	"realpath",
	"tr",
	"cut",
])

// Programs that look read-only but accept a flag that executes code or writes
// files (`-exec`, `--output`, `system()` in awk, etc.). These are allowed only
// if every argument passes a program-specific safety check.
const RESTRICTED_PROGRAMS: Record<string, (args: string[]) => boolean> = {
	find: (args) => !args.some((a) => FIND_EXECUTION_FLAGS.has(a)),
	// `diff --output=FILE` / `-o FILE` writes to FILE.
	diff: (args) =>
		!args.some((a, i) => a === "-o" || a === "--output" || a.startsWith("--output=") || args[i - 1] === "-o"),
}

const FIND_EXECUTION_FLAGS = new Set([
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-delete",
	"-fprint",
	"-fprintf",
	"-fprint0",
	"-fls",
])

// Programs where only specific subcommands are read-only.
/** Allowed subcommands for a program in plan mode.
 *  Two shapes are supported:
 *  - `Set<string>` (legacy): the first subcommand must be in the set; sub-sub-
 *    commands are NOT checked. Used by `git`, `npm`, `kubectl`, etc., whose
 *    listed subcommands have no mutation-capable sub-sub-commands worth
 *    distinguishing, OR where the team has accepted the trade-off (e.g. `git
 *    branch <new>` creates a branch but is rarely abused in plan mode).
 *  - `Record<subcommand, string[] | "*">` (fine-grained): the first subcommand
 *    must be a key, then `tokens[2]` is matched against the array, or the value
 *    `"*"` allows any sub-sub-command. Absent sub-sub-command (e.g. bare
 *    `gh pr`) is blocked. Used by CLIs whose parent commands have both safe
 *    and unsafe children (e.g. `gh pr`, `glab mr`).
 */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string> | Record<string, string[] | "*">> = {
	git: new Set([
		"status",
		"log",
		"diff",
		"show",
		"branch",
		"remote",
		"ls-files",
		"ls-tree",
		"ls-remote",
		"rev-parse",
		"describe",
		"blame",
		"config",
		"tag",
		"stash",
		"reflog",
		"shortlog",
		"fsck",
		"verify-pack",
		"count-objects",
		"for-each-ref",
		"show-ref",
		"symbolic-ref",
		"name-rev",
		"rev-list",
	]),
	npm: new Set(["list", "ls", "view", "info", "search", "outdated", "audit", "--version", "-v"]),
	yarn: new Set(["list", "info", "why", "audit", "--version", "-v"]),
	pnpm: new Set(["list", "ls", "view", "info", "outdated", "audit", "--version", "-v"]),
	pip: new Set(["list", "show", "search", "freeze", "--version"]),
	cargo: new Set(["tree", "search", "--version"]),
	docker: new Set(["ps", "images", "logs", "inspect", "version", "info"]),
	kubectl: new Set(["get", "describe", "logs", "top", "version", "config"]),
	// `gh` and `glab` use the fine-grained form (per-sub-sub-command
	// allowlist) because both CLIs have mutation-capable sub-sub-commands
	// under each parent (e.g. `gh pr create`, `glab mr create`, `gh repo
	// delete`, `glab ci run`). Plan mode has no classifier gate, so anything
	// past `isReadOnlyBashCommand` runs without a prompt — a coarse
	// parent-level allowlist would let those mutations through.
	//
	// Sub-sub-commands not listed under a parent (e.g. `gh pr checkout`) are
	// BLOCKED. To widen, add to the relevant sub-sub-command array.
	//
	// The matcher inspects `tokens[2]` only — sub-sub-sub-commands and flags
	// are not considered. If a parent has both safe and unsafe sub-sub-
	// sub-commands (e.g. `glab cluster agent list` vs `glab cluster agent
	// uninstall`), the parent is omitted entirely to avoid over-broad
	// allowance.
	//
	// Intentionally NOT included as parents at all:
	//   - `gh api` / `glab api`: thin HTTP wrappers that can mutate.
	//   - `gh browse` / `gh codespace`: process side effects (browser, VM).
	//   - `glab cluster`: nested sub-sub-sub-commands include mutations
	//      (e.g. `agent uninstall`); wildcards would be over-broad.
	gh: {
		pr: ["view", "list", "diff", "checks", "status"],
		issue: ["view", "list", "status"],
		repo: ["view", "list"],
		run: ["view", "list", "watch"],
		workflow: ["view", "list"],
		release: ["view", "list"],
		auth: ["status"],
		config: ["list", "get"],
		extension: ["list", "search"],
		gist: ["list", "view"],
		status: "*",
		search: "*",
	},
	glab: {
		mr: ["list", "view", "diff"],
		"merge-request": ["list", "view", "diff"],
		issue: ["list", "view"],
		repo: ["list", "view"],
		project: ["list", "view"],
		ci: ["list", "view", "status", "trace", "lint"],
		pipeline: ["list", "view", "status", "trace"],
		release: ["list", "view"],
		snippet: ["list", "view"],
		variable: ["list", "get"],
		auth: ["status"],
		config: ["get", "list"],
		user: "*",
		status: "*",
		search: "*",
	},
}

// Programs that must never run — even when gated behind rules — because the
// damage is instant and irreversible (root privilege escalation, disk wipes,
// fork bombs). Anything caught here bypasses the classifier and all allow
// rules; to run one of these, switch out of plan/auto mode.
const HARD_BLOCK_PROGRAMS = new Set(["sudo", "su", "shutdown", "reboot", "halt", "poweroff", "mkfs"])

// Operators we never want to see in a read-only command.
//   - `>` / `>>`: writes (except `/dev/null|stdout|stderr` targets, handled
//      separately in isReadOnlyBashCommand)
//   - `<`: input redirect — also appears twice in a row for heredocs (<<EOF)
//   - `<(` / `(`: process substitution / subshell — can hide arbitrary code
//   - `&`: backgrounding
const DANGEROUS_OPS = new Set<ControlOperator>([">", ">>", ">&", "<", "<(", "(", ")", "&"])

// `>` / `>>` targets that are allowed because they discard or duplicate
// existing streams rather than creating persistent state.
const READ_ONLY_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"])

// Root-adjacent paths that are never safe to `rm -rf` recursively.
const DANGEROUS_RM_PATHS = /^(\/$|\/\*$|~$|~\/|\/(bin|sbin|etc|usr|var|lib|boot|root|home|opt|proc|sys|dev)(\/|$))/

export function isHardBlockedBash(command: string): boolean {
	// Fork bomb is a shell-syntax pattern, not a program invocation.
	if (/:\(\)\s*\{/.test(command)) return true

	for (const segment of parseCommandSegments(command)) {
		// See through RTK wrapper so `rtk rm -rf /` is still caught.
		const tokens = segment.tokens[0] === "rtk" ? segment.tokens.slice(1) : segment.tokens
		const program = tokens[0]
		if (!program) continue
		if (HARD_BLOCK_PROGRAMS.has(program)) return true
		if (program === "rm" && isDangerousRmSegment(tokens)) return true
		if (program === "dd" && tokens.some((t) => t.startsWith("of=/dev/"))) return true
	}
	return false
}

/**
 * Returns true if the command contains top-level `&&`, `||`, or `;` operators.
 * Pipes (`|`) do NOT make a command compound for this purpose — they are a
 * single data-flow pipeline and are already handled by isReadOnlyBashCommand.
 */
export function isCompoundCommand(command: string): boolean {
	const entries = parseShell(command) as ParseEntry[]
	for (const entry of entries) {
		if (typeof entry === "object" && "op" in entry) {
			const op = entry.op
			if (op === "&&" || op === "||" || op === ";") {
				return true
			}
		}
	}
	return false
}

/**
 * Split a compound command into individual subcommands.
 * Only splits on `&&`, `||`, `;` — NOT on `|` (pipes).
 * Strips leading/trailing whitespace from each subcommand.
 * Returns null if the command is not compound.
 */
export function splitCompoundCommand(command: string): string[] | null {
	if (!isCompoundCommand(command)) return null

	const entries = parseShell(command) as ParseEntry[]
	const segments: string[] = []
	let currentTokens: string[] = []

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		if (typeof entry === "string") {
			// Strip leading env-var assignments
			if (currentTokens.length === 0 && /^[A-Za-z_][\w]*=/.test(entry)) {
				continue
			}
			currentTokens.push(entry)
			continue
		}
		if ("comment" in entry) continue
		if ("op" in entry && entry.op === "glob") {
			currentTokens.push(entry.pattern)
			continue
		}
		if ("op" in entry) {
			const op = entry.op
			// Only split on compound operators, not pipes
			if (op === "&&" || op === "||" || op === ";") {
				const reconstructed = currentTokens.join(" ").trim()
				if (reconstructed) segments.push(reconstructed)
				currentTokens = []
				continue
			}
			if (op === "|" || op === "|&") {
				currentTokens.push(entry.op)
				continue
			}
			if ((op === ">" || op === ">>") && typeof entries[i + 1] === "string") {
				// Consume the redirect target.
				// NOTE: We intentionally handle only > and >>. Other redirects (<, >&, <<)
				// are intentionally not supported — they would not change the program
				// classification outcome for permission evaluation.
				currentTokens.push(entry.op)
				currentTokens.push(entries[i + 1] as string)
				i++
			}
		}
	}

	// Append the last segment
	const reconstructed = currentTokens.join(" ").trim()
	if (reconstructed) segments.push(reconstructed)

	return segments.filter((s) => s.length > 0)
}

export function extractBashProgram(command: string): { program: string; subcommand: string | undefined } {
	// See through the RTK wrapper so callers get the real program/subcommand.
	const raw = firstSegmentTokens(command)
	const tokens = raw[0] === "rtk" ? raw.slice(1) : raw
	return { program: tokens[0] ?? "", subcommand: tokens[1] }
}

export function isReadOnlyBashCommand(command: string): boolean {
	if (isHardBlockedBash(command)) return false

	const segments = parseCommandSegments(command)
	if (segments.length === 0) return false

	for (const segment of segments) {
		for (const op of segment.ops) {
			if (!DANGEROUS_OPS.has(op.op)) continue
			if ((op.op === ">" || op.op === ">>") && op.target && READ_ONLY_REDIRECT_TARGETS.has(op.target)) continue
			return false
		}
		if (!isSegmentReadOnly(segment.tokens)) return false
	}
	return true
}

function isSegmentReadOnly(tokens: string[]): boolean {
	const program = tokens[0]
	if (!program) return false

	// RTK is a transparent wrapper (`rtk git status` → classify `git status`).
	// Delegate to the wrapped command so read-only checks apply as if RTK
	// were not present.  If there is no wrapped command, reject — bare `rtk`
	// is not read-only.
	if (program === "rtk") {
		return tokens.length > 1 ? isSegmentReadOnly(tokens.slice(1)) : false
	}

	const allowedSubs = READ_ONLY_SUBCOMMANDS[program]
	if (allowedSubs) {
		const sub = tokens[1]
		if (sub === undefined) return false

		// Legacy Set<string>: any sub-sub-command allowed once the parent
		// subcommand is in the set. Used by git, npm, kubectl, etc.
		if (allowedSubs instanceof Set) {
			return allowedSubs.has(sub)
		}

		// Fine-grained: per-sub-sub-command allowlist. Absent sub-sub-command
		// (e.g. `gh pr` with no third token) is blocked — `gh pr` alone is
		// useless and treating it as read-only invites confusion.
		const allowedActions = allowedSubs[sub]
		if (allowedActions === undefined) return false
		if (allowedActions === "*") return true

		const action = tokens[2]
		return action !== undefined && allowedActions.includes(action)
	}

	const restrictedCheck = RESTRICTED_PROGRAMS[program]
	if (restrictedCheck) return restrictedCheck(tokens.slice(1))

	return READ_ONLY_PROGRAMS.has(program)
}

// Is this `rm ...` segment doing recursive+forceful deletion of a system path?
function isDangerousRmSegment(tokens: string[]): boolean {
	let recursive = false
	let force = false
	const paths: string[] = []
	for (const tok of tokens.slice(1)) {
		if (tok === "--recursive") recursive = true
		else if (tok === "--force") force = true
		else if (tok.startsWith("-") && !tok.startsWith("--")) {
			for (const ch of tok.slice(1)) {
				if (ch === "r" || ch === "R") recursive = true
				else if (ch === "f") force = true
			}
		} else if (!tok.startsWith("-")) {
			paths.push(tok)
		}
	}
	if (!recursive && !force) return false
	return paths.some((p) => DANGEROUS_RM_PATHS.test(p))
}

interface Segment {
	tokens: string[]
	ops: Array<{ op: ControlOperator; target?: string }>
}

// Parse a bash command into top-level segments separated by `|`, `;`, `&&`,
// `||`. Each segment carries its word tokens plus the operators (`>`, `>>`,
// etc.) that appear within it. Backticks are pre-rejected because
// shell-quote leaves them as opaque strings.
export function parseCommandSegments(command: string): Segment[] {
	// shell-quote does not recognize legacy backtick substitution; treat any
	// backtick as a poison pill to avoid silently accepting embedded commands.
	if (command.includes("`")) return [{ tokens: [], ops: [{ op: "(" }] }]

	const entries = parseShell(command) as ParseEntry[]
	const segments: Segment[] = []
	let current: Segment = { tokens: [], ops: [] }

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		if (typeof entry === "string") {
			if (current.tokens.length === 0 && /^[A-Za-z_][\w]*=/.test(entry)) {
				continue // strip leading `FOO=bar` assignments
			}
			current.tokens.push(entry)
			continue
		}
		if ("comment" in entry) continue
		if ("op" in entry && entry.op === "glob") {
			current.tokens.push(entry.pattern)
			continue
		}
		if ("op" in entry) {
			const op = entry.op
			if (op === "|" || op === "|&" || op === "||" || op === "&&" || op === ";") {
				segments.push(current)
				current = { tokens: [], ops: [] }
				continue
			}
			if ((op === ">" || op === ">>") && typeof entries[i + 1] === "string") {
				current.ops.push({ op, target: entries[i + 1] as string })
				i++ // consume the redirect target
				continue
			}
			current.ops.push({ op })
		}
	}
	if (current.tokens.length || current.ops.length) segments.push(current)
	return segments.filter((s) => s.tokens.length > 0 || s.ops.length > 0)
}

function firstSegmentTokens(command: string): string[] {
	return parseCommandSegments(command)[0]?.tokens ?? []
}
