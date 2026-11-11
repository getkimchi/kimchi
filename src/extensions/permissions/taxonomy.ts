import { type ControlOperator, type ParseEntry, parse as parseShell } from "shell-quote"
import type { ToolCategory } from "./types.js"

// shell-quote >= 1.11 types ControlOperator as an interface; the operator
// string itself is the `op` field.
type ShellOp = ControlOperator["op"]

export const FILE_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"])

const STATIC_CATEGORIES: Record<string, ToolCategory> = {
	read: "readOnly",
	skill: "readOnly",
	grep: "readOnly",
	find: "readOnly",
	ls: "readOnly",
	edit: "write",
	write: "write",
	bash: "execute",
	// LSP tools: read-only inspection vs. write-capable rename.
	lsp_diagnostics: "readOnly",
	lsp_hover: "readOnly",
	lsp_definition: "readOnly",
	lsp_references: "readOnly",
	lsp_rename: "write",
	// daemon + daemon_control spawn/manage session-surviving processes —
	// same risk class as bash (execute), so they inherit the same
	// permission-mode treatment. (bash_control is `unknown` upstream;
	// daemon tools are classified explicitly rather than inheriting that.)
	daemon: "execute",
	daemon_control: "execute",
	web_search: "readOnly",
	web_fetch: "readOnly",
	questionnaire: "readOnly",
	set_phase: "readOnly",
	workflow_submit_result: "readOnly",
	workflow_submit_questions: "readOnly",
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
	"who",
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
	"bat",
	"eza",
	"column",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"tty",
	"tr",
	"cut",
	"true",
	"false",
	"sleep",
	"test",
	"[",
	"md5",
	"md5sum",
	"sha1sum",
	"sha224sum",
	"sha256sum",
	"sha384sum",
	"sha512sum",
	"shasum",
	"cksum",
	"b3sum",
	"comm",
	"cmp",
	"tac",
	"nl",
	"od",
	"hexdump",
	"strings",
	// Windows counterpart of grep (no grep.exe on stock Windows).
	"findstr",
])

// Programs that look read-only but accept a flag that executes code or writes
// files (`-exec`, `--output`, `system()` in awk, etc.). These are allowed only
// if every argument passes a program-specific safety check.
//
// Dashed flags that make a program print its version or usage and exit:
// `node --version`, `python3 -V`, `git --version`, `gh --version`,
// `java -version`. Only exact, non-path-qualified program names count
// (`./script.sh --help` does not), and only for known programs — `bash -v`
// is verbose mode, not a version query: the shell reads and executes stdin.
// Bare words (`version`, `help`) are never covered; for many programs they
// name a file or a mutating subcommand.
const VERSION_HELP_FLAGS = new Set(["--version", "-V", "-version", "--help", "-h"])
// Known programs whose version/help flags print and exit. Interpreters whose
// `-v` is verbose/REPL mode (bash, sh, python3, lua, …) deliberately stay out.
const VERSION_QUERY_PROGRAMS = new Set(["node", "bun", "deno", "rustc", "python3", "python", "java", "tsc", "gh"])
// Programs whose `-v` shorthand is a version query that prints and exits.
const VERSION_V_SHORTHAND_PROGRAMS = new Set(["node", "bun", "deno"])

function isVersionQuery(program: string, args: string[]): boolean {
	// Exact names only: path-qualified or relative programs (`./x`,
	// `/usr/bin/sudo`) never borrow the rule.
	if (program.includes("/")) return false
	const known =
		READ_ONLY_PROGRAMS.has(program) ||
		Object.hasOwn(READ_ONLY_SUBCOMMANDS, program) ||
		VERSION_QUERY_PROGRAMS.has(program)
	if (!known) return false
	const allowV = VERSION_V_SHORTHAND_PROGRAMS.has(program)
	return args.every((a) => VERSION_HELP_FLAGS.has(a) || (allowV && a === "-v"))
}

// `-o` / `--output` in any spelling writes a file: exact (`-o`), attached
// (`-oFILE`), bundled (`-ro`), or long (`--output`, `--output=FILE`).
function hasOutputFileFlag(args: string[]): boolean {
	for (const a of args) {
		if (a === "--") break
		if (a === "--output" || a.startsWith("--output=")) return true
		if (/^-[^-]*o/.test(a)) return true
	}
	return false
}

// Flags that take a separate value token when they appear BEFORE a git
// subcommand (`git -C <dir> status`, `git -c key=val diff`). `=`-attached
// forms (`--git-dir=<dir>`) are single tokens and need no special handling.
const GIT_GLOBAL_VALUE_FLAGS = new Set(["--git-dir", "--work-tree", "--namespace", "--super-prefix"])

// git subcommands of the diff/log family that accept `--output=<file>` /
// `--output <file>` and would write a file while looking like a read.
const GIT_OUTPUT_CAPABLE_SUBCOMMANDS = new Set([
	"diff",
	"log",
	"show",
	"reflog",
	"diff-tree",
	"diff-files",
	"diff-index",
	"range-diff",
])

const RESTRICTED_PROGRAMS: Record<string, (args: string[]) => boolean> = {
	find: (args) => !args.some((a) => FIND_EXECUTION_FLAGS.has(a)),
	// `diff --output=FILE` / `-o FILE` writes to FILE, in every flag spelling.
	diff: (args) => !hasOutputFileFlag(args),
	// BSD/macOS `base64 -o FILE` writes a file (`-D -o ~/.zshrc` overwrites
	// arbitrary content); GNU flags are stdout-only but the check is shared.
	base64: (args) => !hasOutputFileFlag(args),
	// `hostname <name>` SETS the hostname and `-F`/`--file` loads the new name
	// from a file (attached form included). Only bare flags are reads.
	hostname: (args) =>
		args.every((a) => a.startsWith("-")) &&
		!args.some((a) => /^-[^-]*F/.test(a) || a === "--file" || a.startsWith("--file=")),
	// `sort -o FILE` / `--output FILE` writes (attached and bundled spellings
	// included) and `--compress-program=CMD` executes CMD.
	sort: (args) => {
		if (hasOutputFileFlag(args)) return false
		return !args.some(
			(a, i) =>
				a === "--compress-program" || a.startsWith("--compress-program=") || args[i - 1] === "--compress-program",
		)
	},
	// yq v4 spells it `--inplace`; `-i` and the older `--in-place` are rejected
	// too so neither spelling slips through.
	yq: (args) => !args.some((a) => a === "-i" || a.startsWith("--inplace") || a.startsWith("--in-place")),
	// git: global options may precede the subcommand (`git -C <dir> status`,
	// `git --no-pager log`), so they are skipped before the subcommand is
	// matched against READ_ONLY_SUBCOMMANDS.git. A few subcommands carry write
	// vectors the wildcard map cannot express and are gated here first:
	// `config key value` writes .git/config (and values like core.fsmonitor
	// name a command git later executes), `fetch` without --dry-run updates
	// local refs, diff-family `--output` writes files, `reflog
	// expire/delete` destroys history, and stash pop/apply/drop/clear mutate
	// the stash and the working tree.
	git: (args) => {
		let i = 0
		while (i < args.length) {
			const a = args[i]
			if (!a.startsWith("-")) break
			// `-c` / `--config-env` inject config whose values can name a
			// command git later executes (core.fsmonitor, core.sshCommand,
			// diff.external, gpg.program, …) — always refused. `-p` /
			// `--paginate` runs the configured pager, `--exec-path` relocates
			// where git finds external subcommands.
			if (a === "-c" || a.startsWith("--config-env")) return false
			if (a === "-p" || a === "--paginate") return false
			// Attached `-cVALUE` is invalid usage in git but there is no valid
			// global flag that starts with lowercase -c, so refuse it anyway.
			if (a.startsWith("-c") && a !== "-C") return false
			if (a === "--exec-path" || a.startsWith("--exec-path=")) return false
			if (a === "-C" || GIT_GLOBAL_VALUE_FLAGS.has(a)) i += 2
			else i++
		}
		const sub = args[i]
		if (sub === undefined) return true // bare `git` (or only global flags) prints usage
		const subArgs = args.slice(i + 1)

		// Flags that run an external program or pager in any allowed
		// subcommand: `git grep -O cmd`, `--open-files-in-pager`,
		// `--ext-diff`, `--textconv`, `--filters`.
		if (
			subArgs.some(
				(a) =>
					a.startsWith("-O") ||
					a === "--open-files-in-pager" ||
					a.startsWith("--open-files-in-pager=") ||
					a === "--ext-diff" ||
					a === "--textconv" ||
					a === "--filters",
			)
		)
			return false

		if (GIT_OUTPUT_CAPABLE_SUBCOMMANDS.has(sub)) {
			for (const a of subArgs) {
				if (a === "--output" || a.startsWith("--output=")) return false
			}
		}
		// `git config key value` writes; read forms carry at most one bare
		// operand (`git config user.name`, `git config --get x`, `git config
		// --list`). -e opens an editor; --add/--unset(–-all)/--replace-all and
		// the section operations write.
		if (sub === "config") {
			if (
				subArgs.some(
					(a) =>
						a === "-e" ||
						a === "--edit" ||
						a === "--add" ||
						a === "--unset" ||
						a === "--unset-all" ||
						a === "--replace-all" ||
						a === "--rename-section" ||
						a === "--remove-section",
				)
			)
				return false
			// Count bare operands: `--` ends flag parsing, a lone `-` IS an
			// operand (the value in `git config user.name -`), and
			// --file/--blob/--default consume a value that is not an operand.
			let bare = 0
			for (let j = 0; j < subArgs.length; j++) {
				const a = subArgs[j]
				if (a === "--") {
					bare += subArgs.length - j - 1
					break
				}
				if (a === "-f" || a === "--file" || a === "--blob" || a === "--default") {
					j++ // flag value, not an operand
					continue
				}
				if (a.startsWith("--file=") || a.startsWith("--blob=") || a.startsWith("--default=")) continue
				if (a.startsWith("-") && a !== "-") continue
				bare++
			}
			return bare <= 1
		}
		// `git fetch` updates local refs; only --dry-run is a pure read.
		if (sub === "fetch") return subArgs.includes("--dry-run")
		// `git help -w/-i` opens a browser/info viewer — process side effects.
		if (sub === "help") return !subArgs.some((a) => a === "-w" || a === "--web" || a === "-i" || a === "--info")
		// `git reflog expire/delete` destroys reflog history.
		if (sub === "reflog") return subArgs[0] !== "expire" && subArgs[0] !== "delete"
		// Only the listing forms of stash are read-only. Bare `git stash` is
		// `git stash push` (it stashes and resets the worktree), so only
		// `list`/`show` pass; pop/apply/drop/clear mutate.
		if (sub === "stash") return subArgs[0] === "list" || subArgs[0] === "show"

		const allowedSubs = READ_ONLY_SUBCOMMANDS.git
		const actions = allowedSubs instanceof Set || !Object.hasOwn(allowedSubs, sub) ? undefined : allowedSubs[sub]
		if (actions === undefined) return false
		if (actions === "*") return true
		const action = subArgs[0]
		return action !== undefined && actions.includes(action)
	},
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
 *    commands are NOT checked. Used by `npm`, `kubectl`, etc., whose
 *    listed subcommands have no mutation-capable sub-sub-commands worth
 *    distinguishing, OR where the team has accepted the trade-off.
 *  - `Record<subcommand, string[] | "*">` (fine-grained): the first subcommand
 *    must be a key, then `tokens[2]` is matched against the array, or the value
 *    `"*"` allows any sub-sub-command. Absent sub-sub-command (e.g. bare
 *    `gh pr`) is blocked. Used by CLIs whose parent commands have both safe
 *    and unsafe children (e.g. `gh pr`, `glab mr`), or where a single
 *    subcommand needs sub-sub-command scoping (e.g. `git worktree` →
 *    `list`-only while all other git subcommands are wildcarded).
 */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string> | Record<string, string[] | "*">> = {
	// git uses the fine-grained Record form (not the legacy Set) so that
	// `worktree` can be scoped to read-only actions only. All other
	// subcommands use the `"*"` wildcard, which short-circuits before the
	// tokens[2] check — preserving the exact same behavior as the old Set
	// (any sub-sub-command allowed, including bare `git status`).
	//
	// `worktree` is scoped because `git worktree add`/`remove`/`move`
	// mutate the filesystem (create/delete/relocate directories on disk),
	// unlike e.g. `git branch <name>` which is a local, easily-reversible
	// ref operation already accepted as a trade-off.
	git: {
		status: "*",
		log: "*",
		diff: "*",
		show: "*",
		branch: "*",
		remote: "*",
		"ls-files": "*",
		"ls-tree": "*",
		"ls-remote": "*",
		"rev-parse": "*",
		describe: "*",
		blame: "*",
		tag: "*",
		worktree: ["list"],
		shortlog: "*",
		fsck: "*",
		"verify-pack": "*",
		"count-objects": "*",
		"for-each-ref": "*",
		"show-ref": "*",
		"symbolic-ref": "*",
		"name-rev": "*",
		"rev-list": "*",
		// Read-only search/plumbing used heavily by code-review workflows.
		grep: "*",
		"merge-base": "*",
		"cat-file": "*",
		cherry: "*",
		"check-ignore": "*",
		"check-attr": "*",
		"check-mailmap": "*",
		"diff-tree": "*",
		"diff-files": "*",
		"diff-index": "*",
		"range-diff": "*",
		var: "*",
		"verify-commit": "*",
		"verify-tag": "*",
		version: "*",
	},
	go: new Set(["version"]),
	npm: new Set(["list", "ls", "view", "info", "search", "outdated", "audit", "--version", "-v"]),
	yarn: new Set(["list", "info", "why", "audit", "--version", "-v"]),
	pnpm: new Set(["list", "ls", "view", "info", "outdated", "audit", "--version", "-v"]),
	pip: new Set(["list", "show", "search", "freeze", "--version"]),
	cargo: new Set(["tree", "search", "--version"]),
	docker: new Set(["ps", "images", "logs", "inspect", "version", "info"]),
	kubectl: new Set([
		"get",
		"describe",
		"logs",
		"top",
		"version",
		"config",
		"cluster-info",
		"api-resources",
		"api-versions",
		"explain",
	]),
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
	// gcloud uses the fine-grained form because most groups have both safe
	// and unsafe sub-sub-commands. The matcher inspects tokens[2] only, so
	// for gcloud's three-level structure (`gcloud <group> <resource> <action>`)
	// the safety distinction lives at tokens[3] — beyond the matcher's reach.
	// Parents whose sub-sub-commands include mutations (e.g. `container clusters`
	// has both `list` and `get-credentials`/`delete`) are omitted entirely,
	// following the same rule as `glab cluster`.
	//
	// Intentionally NOT included:
	//   - `artifacts`: `docker` → tokens[2] allows `images delete` etc.
	//   - `container`: `clusters` → allows `get-credentials` (writes kubeconfig)
	//      and `delete` (destroys clusters).
	//   - `compute`: `instances`/`zones` → allows `delete`/`start`/`stop`.
	//   - `auth configure-docker`: writes docker credential helper config.
	gcloud: {
		auth: ["list"],
		config: ["get-value", "list"],
		projects: ["list", "describe"],
		services: ["list"],
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
//   - `>&`: fd/file redirect — safe when target is a pure digit (fd-to-fd
//      duplication like `2>&1`), handled separately in isReadOnlyBashCommand.
//      File-target redirects (`>& /tmp/evil`) remain blocked.
//   - `<`: input redirect — also appears twice in a row for heredocs (<<EOF)
//   - `<(` / `(`: process substitution / subshell — can hide arbitrary code
//   - `&`: backgrounding
//   - `&>` / `&>>`: combined stdout+stderr redirect-to-file. shell-quote 1.11+
//      emits these as single operators (older versions decomposed them into `&`
//      + `>`); they are blocked unconditionally — unlike `>` there is no
//      `/dev/null` allowance, matching the pre-1.11 behavior where the `&`
//      always blocked them.
//   - `<<` / `<<-` / `<<<`: heredocs / here-strings — stdin constructs whose
//      bodies are opaque to segment parsing.
//   - `>(` / `>|` / `<>` / `<&`: process-substitution output, clobber-forced
//      redirect, and read/write fd redirects — all can write files.
const DANGEROUS_OPS = new Set<ShellOp>([
	">",
	">>",
	">&",
	"<",
	"<(",
	">(",
	"(",
	")",
	"&",
	"&>",
	"&>>",
	">|",
	"<>",
	"<&",
	"<<",
	"<<-",
	"<<<",
])

// `>` / `>>` targets that are allowed because they discard or duplicate
// existing streams rather than creating persistent state.
const READ_ONLY_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"])

// Root-adjacent paths that are never safe to `rm -rf` recursively.
const DANGEROUS_RM_PATHS = /^(\/$|\/\*$|~$|~\/|\/(bin|sbin|etc|usr|var|lib|boot|root|home|opt|proc|sys|dev)(\/|$))/

export function isHardBlockedBash(command: string): boolean {
	// Fork bomb is a shell-syntax pattern, not a program invocation.
	if (/:\(\)\s*\{/.test(command)) return true

	for (const segment of parseCommandSegments(command)) {
		const tokens = segment.tokens
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
			if (
				(op === ">" || op === ">>" || op === ">&" || op === "&>" || op === "&>>") &&
				typeof entries[i + 1] === "string"
			) {
				// Consume the redirect target (also covers `>&1` fd-to-fd redirects
				// and combined `&>` / `&>>` redirects, single ops since shell-quote 1.11).
				currentTokens.push(entry.op)
				currentTokens.push(entries[i + 1] as string)
				i++
				continue
			}
			// Every other operator is preserved verbatim so the reconstructed
			// segment still carries it — dropping it would hide redirects like
			// `>|`, `<>`, `<&`, or heredocs from downstream read-only
			// classification (fail closed).
			currentTokens.push(op)
		}
	}

	// Append the last segment
	const reconstructed = currentTokens.join(" ").trim()
	if (reconstructed) segments.push(reconstructed)

	return segments.filter((s) => s.length > 0)
}

// Canonical first-segment tokens. parseCommandSegments already strips leading
// FOO=bar assignments, shell-tokenizes (dropping quotes), and collapses whitespace.
// Env-STRIPPING: used by extractBashProgram and the hard-block / read-only /
// bare-rule-auto-rewrite callers, where env-transparency is correct. The
// remembered-rule scope/match pair uses rememberedScopeTokens instead, which
// PRESERVES env.
export function bashCommandTokens(command: string): string[] {
	return firstSegmentTokens(command)
}

export function extractBashProgram(command: string): { program: string; subcommand: string | undefined } {
	const tokens = bashCommandTokens(command)
	return { program: tokens[0] ?? "", subcommand: tokens[1] }
}

// One leading `KEY=value` assignment (value may be double/single-quoted or a
// bareword) plus its trailing whitespace. Capture group 1 is the assignment.
const LEADING_ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*))\s+/

// Split a command into its leading `KEY=value` env assignments (verbatim, value
// included) and the remainder. The shell applies these assignments at execution,
// so for remembered-rule scope/matching they are part of what was approved and
// are preserved (unlike parseCommandSegments, which strips them).
export function splitLeadingEnv(command: string): { env: string[]; rest: string } {
	let rest = command.trim()
	const env: string[] = []
	let match = rest.match(LEADING_ENV_ASSIGNMENT)
	while (match) {
		env.push(match[1])
		rest = rest.slice(match[0].length)
		match = rest.match(LEADING_ENV_ASSIGNMENT)
	}
	return { env, rest }
}

// Normalized first-segment tokens for remembered-rule scope and matching: leading
// env assignments are PRESERVED (key and value), and quotes/whitespace are
// normalized via parseCommandSegments. Returns [] when there is no program token
// (empty, env-only, or backtick-poisoned). Distinct from bashCommandTokens, which
// strips env for hard-block / read-only / auto-rewrite callers where
// env-transparency is correct.
export function rememberedScopeTokens(command: string): string[] {
	const { env, rest } = splitLeadingEnv(command)
	const tokens = parseCommandSegments(rest)[0]?.tokens ?? []
	if (tokens.length === 0) return []
	return [...env, ...tokens]
}

// Canonical command form for each top-level segment that `parseCommandSegments`
// resolves (split on `| ; && ||`), with env assignments dropped and quotes/
// whitespace normalized. Used by DENY matching, which checks every segment so a
// denied program behind a pipe still blocks. (allow matching stays single-segment
// via rememberedScopeTokens — it must not widen an approval to a piped tail.)
// NOTE: this inherits `parseCommandSegments` limits — command substitution
// (`$(...)`, backticks) and path-qualified program names are not normalized, so
// deny is not a complete sandbox. See isHardBlockedBash / the classifier for the
// other layers.
export function bashSegmentForms(command: string): string[] {
	return parseCommandSegments(command)
		.map((seg) => seg.tokens.join(" "))
		.filter((form) => form.length > 0)
}

// Programs that are pure output filters: they consume stdin, emit stdout, and
// can neither execute code nor write files. Only these may be normalized away
// as trailing pipe stages. Excluded on purpose: awk/sed/perl (can execute
// code), sort (can write files or execute a compressor), uniq/tee (write
// files), xargs (executes), sh/bash (execute).
export const OUTPUT_FILTER_PROGRAMS = new Set(["tail", "head", "wc", "grep", "cut", "tr", "jq"])

/**
 * When `command` is a pipeline whose every stage after the head is a
 * whitelisted output filter (and the head carries no operators beyond an
 * `fd>&fd` merge like `2>&1`), returns the head with its env prefix preserved
 * and the filter tail dropped (`npm install 2>&1 | tail -40` → `npm install`).
 * Otherwise returns null. This lets a remembered allow rule for the head match
 * LLM-generated piped reruns (models habitually append `2>&1 | tail -N`)
 * WITHOUT widening allow matching to arbitrary pipe tails: `| sh`, `| tee`
 * still produce no canonical form and therefore cannot match a broad scope.
 */
export function stripTrailingOutputFilters(command: string): string | null {
	if (!command.includes("|") || isCompoundCommand(command)) return null
	// Command substitution is opaque to segment parsing — never normalize it.
	if (command.includes("$(") || command.includes("`")) return null

	const segments = parseCommandSegments(command)
	if (segments.length < 2) return null

	const [head, ...filters] = segments
	// The head may carry only fd-dup redirects (`2>&1`); file redirects or
	// other operators mean the tail filter is not what bounded the output.
	if (head.tokens.length === 0) return null
	if (head.ops.some((op) => !(op.op === ">&" && op.target && /^[0-9]+$/.test(op.target)))) return null

	for (const stage of filters) {
		if (stage.ops.length > 0) return null
		if (stage.tokens.length === 0 || !OUTPUT_FILTER_PROGRAMS.has(stage.tokens[0])) return null
	}

	const { env } = splitLeadingEnv(command)
	return [...env, ...head.tokens].join(" ")
}

// Env keys that can execute code or inject config into an otherwise read-only
// command (GIT_PAGER spawns a pager, GIT_SSH_COMMAND wraps ssh, GIT_CONFIG_*
// sets fsmonitor etc., LD_PRELOAD/BASH_ENV run code, HOME/XDG_* relocate
// config so an attacker-controlled .gitconfig can inject core.fsmonitor).
// Any leading assignment with one of these prefixes/names blocks read-only
// classification.
const UNSAFE_ENV_NAMES = new Set([
	"HOME",
	"NODE_OPTIONS",
	"LESSOPEN",
	"LESSCLOSE",
	"BASH_ENV",
	"MANPAGER",
	"PAGER",
	"EDITOR",
	"VISUAL",
	"ENV",
	"SHELL",
])
const UNSAFE_ENV_PREFIXES = ["GIT_", "LD_", "DYLD_", "XDG_", "SSH_", "PYTHON", "PERL"]

function isUnsafeEnvAssignment(assignment: string): boolean {
	const eq = assignment.indexOf("=")
	const key = (eq === -1 ? assignment : assignment.slice(0, eq)).toUpperCase()
	return UNSAFE_ENV_NAMES.has(key) || UNSAFE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
}

export function isReadOnlyBashCommand(command: string): boolean {
	if (isHardBlockedBash(command)) return false

	const segments = parseCommandSegments(command)
	if (segments.length === 0) return false

	for (const segment of segments) {
		// Leading env assignments apply at execution even though they are
		// stripped from the tokens — fail closed on code-executing keys.
		if (segment.env.some((assignment) => isUnsafeEnvAssignment(assignment))) return false
		for (const op of segment.ops) {
			if (!DANGEROUS_OPS.has(op.op)) continue
			if ((op.op === ">" || op.op === ">>") && op.target && READ_ONLY_REDIRECT_TARGETS.has(op.target)) continue
			// `>&` with a pure-digit target is fd-to-fd duplication (e.g. `2>&1`), which cannot read or write files.
			// File-target `>& /tmp/evil` stays blocked because the target is not a digit.
			if (op.op === ">&" && op.target && /^[0-9]+$/.test(op.target)) continue
			return false
		}
		if (!isSegmentReadOnly(segment.tokens)) return false
	}
	return true
}

function isSegmentReadOnly(tokens: string[]): boolean {
	const program = tokens[0]
	if (!program) return false

	// Version/help queries are read-only for known programs (see
	// isVersionQuery): exact names only, `-v` only where it means version.
	if (tokens.length > 1 && isVersionQuery(program, tokens.slice(1))) return true

	// Restricted programs are checked before the subcommand map: their
	// handlers encode per-subcommand rules the map cannot express (git falls
	// back to the map itself after its global-flag normalization). Lookups
	// use Object.hasOwn so prototype keys (`toString`, `constructor`) never
	// match a table.
	const restrictedCheck = Object.hasOwn(RESTRICTED_PROGRAMS, program) ? RESTRICTED_PROGRAMS[program] : undefined
	if (restrictedCheck) return restrictedCheck(tokens.slice(1))

	const allowedSubs = Object.hasOwn(READ_ONLY_SUBCOMMANDS, program) ? READ_ONLY_SUBCOMMANDS[program] : undefined
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
		const allowedActions = Object.hasOwn(allowedSubs, sub) ? allowedSubs[sub] : undefined
		if (allowedActions === undefined) return false
		if (allowedActions === "*") return true

		const action = tokens[2]
		return action !== undefined && allowedActions.includes(action)
	}

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
	ops: Array<{ op: ShellOp; target?: string }>
	/** Leading `KEY=value` assignments — stripped from tokens, applied at execution. */
	env: string[]
}

// Parse a bash command into top-level segments separated by `|`, `;`, `&&`,
// `||`. Each segment carries its word tokens plus the operators (`>`, `>>`,
// etc.) that appear within it. Backticks are pre-rejected because
// shell-quote leaves them as opaque strings.
export function parseCommandSegments(command: string): Segment[] {
	// shell-quote does not recognize legacy backtick substitution; treat any
	// backtick as a poison pill to avoid silently accepting embedded commands.
	if (command.includes("`")) return [{ tokens: [], ops: [{ op: "(" }], env: [] }]

	const entries = parseShell(command) as ParseEntry[]
	const segments: Segment[] = []
	let current: Segment = { tokens: [], ops: [], env: [] }

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		if (typeof entry === "string") {
			if (current.tokens.length === 0 && /^[A-Za-z_][\w]*=/.test(entry)) {
				// Keep leading `FOO=bar` assignments for the unsafe-env check;
				// they are not part of the command tokens.
				current.env.push(entry)
				continue
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
				current = { tokens: [], ops: [], env: [] }
				continue
			}
			if (
				(op === ">" || op === ">>" || op === ">&" || op === "&>" || op === "&>>") &&
				typeof entries[i + 1] === "string"
			) {
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
