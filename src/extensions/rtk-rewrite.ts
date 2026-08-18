import { execFile, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { type BashOperations, createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { parse as parseShell } from "shell-quote"
import { applyEnabledBashHooks } from "../resources/bash-hooks.js"
import { globalRtkLinkPath, managedRtkPath } from "../resources/rtk-install.js"
import { isResourceEnabled } from "../resources/store.js"

// ---------------------------------------------------------------------------
// RTK (Rust Token Killer) integration
//
// When the `rtk` binary is on PATH, bash commands are rewritten through
// `rtk rewrite <cmd>` before execution.  This reduces LLM token consumption
// by 60-90% on common dev commands (git, cargo, npm, etc.).
//
// Disable via hooks.rtk-rewrite in /resources.
//
// See https://github.com/rtk-ai/rtk
// ---------------------------------------------------------------------------

/** Tri-state: undefined = not yet probed, true/false = cached result. */
let rtkAvailable: boolean | undefined

/** Cached in-flight detection promise to avoid concurrent spawns. */
let rtkDetectPromise: Promise<boolean> | undefined

function isRtkDisabled(): boolean {
	return !isResourceEnabled("hooks.rtk-rewrite")
}

function rtkBinary(): string {
	const global = globalRtkLinkPath()
	if (existsSync(global)) return global
	const managed = managedRtkPath()
	return existsSync(managed) ? managed : "rtk"
}

/**
 * Probe for the `rtk` binary once per process.  Caches the result so
 * subsequent calls are free.  The in-flight promise is also cached so
 * concurrent callers share a single `rtk --version` subprocess.
 *
 * Returns true when rtk is installed and responds to `--version` within 1 s.
 */
export function detectRtk(): Promise<boolean> {
	if (rtkAvailable !== undefined) return Promise.resolve(rtkAvailable)
	if (isRtkDisabled()) {
		rtkAvailable = false
		return Promise.resolve(false)
	}
	if (rtkDetectPromise) return rtkDetectPromise
	rtkDetectPromise = new Promise<boolean>((resolve) => {
		execFile(rtkBinary(), ["--version"], { timeout: 1000 }, (err) => {
			rtkAvailable = !err
			rtkDetectPromise = undefined
			resolve(rtkAvailable)
		})
	})
	return rtkDetectPromise
}

/**
 * Package-manager invocations that RTK must not rewrite.
 *
 * RTK hijacks subcommand names that collide with its own — the most painful
 * example is `pnpm lint` / `pnpm run lint` → `rtk lint` (its own ESLint
 * wrapper), which breaks projects that use Biome or other linters.
 *
 * Rather than maintaining an allowlist of package-manager built-ins, we pass
 * through every invocation of the supported package managers and launchers.
 * RTK's token-compression benefit on these commands is negligible compared to
 * the risk of current or future subcommand collisions.
 */
const RTK_PASSTHROUGH_COMMANDS = new Set(["pnpm", "npm", "yarn", "bun", "npx", "bunx"])

// Shell operators that begin another executable command context. shell-quote
// keeps quoted operators inside string tokens, avoiding substring matches such
// as `echo "pnpm test"`. Opening subshell/process-substitution operators are
// included so nested commands such as `$(pnpm test)` and `<(pnpm test)` are
// checked independently from their outer command. Quoted source passed to a
// nested shell, such as `bash -c 'pnpm test'`, remains outside this policy.
const COMMAND_SEPARATORS = new Set(["||", "&&", "|&", "&", ";", "|", "(", "<("])
const LEADING_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const COMMAND_PREFIXES = new Set(["!", "{", "if", "then", "elif", "else", "while", "until", "do", "time"])
const FULL_LINE_COMMENT_RE = /^[\t ]*#[^\r\n]*(?:\r?\n|$)/gm

function segmentInvokesPassthroughCommand(tokens: string[]): boolean {
	let commandIndex = 0
	while (commandIndex < tokens.length) {
		const token = tokens[commandIndex]
		if (token === undefined) return false
		if (!LEADING_ASSIGNMENT_RE.test(token) && !COMMAND_PREFIXES.has(token)) break
		commandIndex++
	}

	const command = tokens[commandIndex]
	if (command === undefined) return false
	return RTK_PASSTHROUGH_COMMANDS.has(command)
}

/**
 * Returns true for commands that must bypass RTK rewriting entirely.
 */
export function isRtkPassthrough(command: string): boolean {
	try {
		// shell-quote treats a comment as extending to the end of its input and
		// newlines as whitespace. Remove full-line comments before normalizing
		// newlines so a following command is still parsed as its own segment.
		const entries = parseShell(command.replace(FULL_LINE_COMMENT_RE, "").replace(/\r?\n/g, ";"))
		let segment: string[] = []

		for (const entry of entries) {
			if (typeof entry === "string") {
				segment.push(entry)
				continue
			}

			if ("op" in entry && COMMAND_SEPARATORS.has(entry.op)) {
				if (segmentInvokesPassthroughCommand(segment)) return true
				segment = []
			}
		}

		return segmentInvokesPassthroughCommand(segment)
	} catch {
		// RTK is an optional optimization. If we cannot safely classify a shell
		// command, preserve its original semantics instead of asking RTK to
		// reinterpret malformed or unsupported syntax.
		return true
	}
}

/**
 * Synchronously ask `rtk rewrite` to compress / rewrite a command string.
 * Used by the synchronous `tool_call` extension event before Bash execution.
 *
 * Returns the original command unchanged when:
 *   - rtk is not available or hooks.rtk-rewrite is disabled
 *   - the command invokes a passthrough package manager or launcher
 *   - rtk returns empty output or the same string
 *   - the subprocess times out or fails to spawn
 */
export function rewriteWithRtk(command: string): string {
	if (isRtkDisabled()) return command
	if (isRtkPassthrough(command)) return command
	if (rtkAvailable === false && rtkBinary() === "rtk") return command

	try {
		const stdout = execFileSync(rtkBinary(), ["rewrite", command], { timeout: 2000, encoding: "utf-8" })
		const rewritten = stdout.trim()
		return rewritten && rewritten !== command ? rewritten : command
	} catch (err) {
		// execFileSync throws on any non-zero exit code.  RTK uses exit code 3
		// to signal a successful rewrite, so we extract stdout from the error.
		const execErr = err as { status?: number; stdout?: string; code?: string }
		if (execErr.status === 3 && typeof execErr.stdout === "string") {
			const rewritten = execErr.stdout.trim()
			return rewritten && rewritten !== command ? rewritten : command
		}
		// On first ENOENT, cache the negative result so we stop spawning.
		if (execErr.code === "ENOENT") {
			rtkAvailable = false
		}
		return command
	}
}

/** Cache of rewrite results so renderCall never spawns a subprocess. */
const rewriteCache = new Map<string, string>()

export function getBashCommandForDisplay(command: string | undefined): string | undefined {
	if (!command) return command
	return rewriteCache.get(command) ?? command
}

/** Reset cached detection state (for tests). */
export function _resetRtkState(): void {
	rtkAvailable = undefined
	rtkDetectPromise = undefined
	rewriteCache.clear()
}

export function rewritePreparedBashCommand(prepared: string, original: string, rewritten: string): string {
	if (prepared === original) return rewritten
	const suffix = `\n${original}`
	if (prepared.endsWith(suffix)) return `${prepared.slice(0, -original.length)}${rewritten}`
	return rewritten
}

function rewrittenCommandOperations(original: string, rewritten: string): BashOperations {
	const local = createLocalBashOperations()
	return {
		exec: (command, cwd, options) => local.exec(rewritePreparedBashCommand(command, original, rewritten), cwd, options),
	}
}

export default function (pi: ExtensionAPI) {
	// Eagerly probe for rtk at extension load time (non-blocking).
	detectRtk()

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return
		const command = event.input.command
		if (typeof command !== "string") return
		const rewritten = rewriteWithRtk(command)
		const cwd =
			typeof (event.input as { cwd?: unknown }).cwd === "string" ? (event.input as { cwd: string }).cwd : process.cwd()
		const hooked = applyEnabledBashHooks(rewritten, cwd)
		if (hooked.block) return { block: true, reason: hooked.reason }
		rewriteCache.set(command, hooked.command)
		if (rewritten !== hooked.command) rewriteCache.set(rewritten, hooked.command)
		event.input.command = hooked.command
	})

	pi.on("user_bash", (event) => {
		const hooked = applyEnabledBashHooks(event.command, event.cwd)
		if (hooked.block) {
			return {
				result: {
					output: hooked.reason ?? "Bash hook blocked command",
					exitCode: 2,
					cancelled: false,
					truncated: false,
				},
			}
		}
		if (hooked.command === event.command) return
		rewriteCache.set(event.command, hooked.command)
		return { operations: rewrittenCommandOperations(event.command, hooked.command) }
	})
}
