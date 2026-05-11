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

export function classifyTool(toolName: string): ToolCategory {
	const lower = toolName.toLowerCase()
	if (lower in STATIC_CATEGORIES) return STATIC_CATEGORIES[lower]

	if (toolName.startsWith("mcp__")) {
		const last = toolName.split("__").pop() ?? ""
		if (READ_ONLY_NAME_HINT.test(last)) return "readOnly"
		return "unknown"
	}

	if (READ_ONLY_NAME_HINT.test(toolName)) return "readOnly"
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
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
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
		const program = segment.tokens[0]
		if (!program) continue
		if (HARD_BLOCK_PROGRAMS.has(program)) return true
		if (program === "rm" && isDangerousRmSegment(segment.tokens)) return true
		if (program === "dd" && segment.tokens.some((t) => t.startsWith("of=/dev/"))) return true
	}
	return false
}

export function extractBashProgram(command: string): { program: string; subcommand: string | undefined } {
	const tokens = firstSegmentTokens(command)
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

	const allowedSubs = READ_ONLY_SUBCOMMANDS[program]
	if (allowedSubs) {
		const sub = tokens[1]
		return sub !== undefined && allowedSubs.has(sub)
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
function parseCommandSegments(command: string): Segment[] {
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
