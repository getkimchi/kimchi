import { execFile, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import {
	type BashOperations,
	type BashSpawnContext,
	type ExtensionAPI,
	createLocalBashOperations,
} from "@earendil-works/pi-coding-agent"
import { applyEnabledBashHooks } from "../resources/bash-hooks.js"
import { globalRtkLinkPath, managedRtkPath } from "../resources/rtk-install.js"
import { isResourceEnabled } from "../resources/store.js"

export function collapseCommand(command: string | undefined): string {
	return (command ?? "").replace(/\n+/g, " ⏎ ")
}

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
 * Synchronously ask `rtk rewrite` to compress / rewrite a command string.
 * Used as a pi-mono BashSpawnHook (which must be synchronous).
 *
 * Returns the original command unchanged when:
 *   - rtk is not available or hooks.rtk-rewrite is disabled
 *   - rtk returns empty output or the same string
 *   - the subprocess times out or fails to spawn
 */
export function rewriteWithRtk(command: string): string {
	if (isRtkDisabled()) return command
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

/**
 * BashSpawnHook for pi-mono's createBashToolDefinition.
 * Rewrites the command through `rtk rewrite` before the shell spawns.
 * Caches the result so renderCall can display it without a subprocess.
 */
export function rtkSpawnHook(context: BashSpawnContext): BashSpawnContext {
	const rewritten = rewriteWithRtk(context.command)
	rewriteCache.set(context.command, rewritten)
	return rewritten !== context.command ? { ...context, command: rewritten } : context
}

/** Reset cached detection state (for tests). */
export function _resetRtkState(): void {
	rtkAvailable = undefined
	rtkDetectPromise = undefined
	rewriteCache.clear()
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

function rewrittenCommandOperations(original: string, rewritten: string): BashOperations {
	const local = createLocalBashOperations()
	return {
		exec: (command, cwd, options) => local.exec(rewritePreparedBashCommand(command, original, rewritten), cwd, options),
	}
}

export function rewritePreparedBashCommand(prepared: string, original: string, rewritten: string): string {
	if (prepared === original) return rewritten
	const suffix = `\n${original}`
	if (prepared.endsWith(suffix)) return `${prepared.slice(0, -original.length)}${rewritten}`
	return rewritten
}
