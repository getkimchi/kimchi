/**
 * Records the worktree a session runs in: one `kimchi_worktree` entry per
 * `session_start`, appended only when the session launched inside a worktree.
 *
 * The entry is the record the exit prompt and resume logic read — it carries
 * the worktree dir, the main checkout root, the branch and whether the
 * worktree was user-named (vs auto-generated, which are safe to auto-remove
 * when clean). The pre-main `--worktree` hook (src/worktree-cli.ts) exports
 * KIMCHI_WORKTREE / KIMCHI_WORKTREE_MAIN before pi's main() runs; session
 * entry + env together are the two sources of truth, with the entry being the
 * durable one (it survives a resume).
 */

import { basename, isAbsolute, resolve } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import { WORKTREE_BRANCH_PREFIX } from "../shared/git/worktree.js"
import { KIMCHI_WORKTREE_ENV, KIMCHI_WORKTREE_MAIN_ENV } from "../worktree-cli.js"
import { trackWorktreeEvent, trySessionId } from "./telemetry/index.js"

export const KIMCHI_WORKTREE_ENTRY_TYPE = "kimchi_worktree"
export const KIMCHI_WORKTREE_SCHEMA_VERSION = 1

export interface KimchiWorktreeEntry {
	schemaVersion: typeof KIMCHI_WORKTREE_SCHEMA_VERSION
	/** Absolute (realpath) worktree directory. */
	dir: string
	/** Absolute main checkout root. */
	mainRoot: string
	/** Branch name, `worktree-<name>`. */
	branch: string
	/** Worktree name (the dir basename). */
	name: string
	/** True when the user named the worktree; false for auto-generated names
	 *  (which the exit prompt may remove silently when clean). */
	named: boolean
}

/** Resolve the worktree binding from the process environment (set by the
 *  pre-main hook). Returns undefined when the session is not in a worktree. */
export function readWorktreeBindingFromEnv(env: NodeJS.ProcessEnv = process.env): KimchiWorktreeEntry | undefined {
	const dir = env[KIMCHI_WORKTREE_ENV]
	const mainRoot = env[KIMCHI_WORKTREE_MAIN_ENV]
	if (!dir || !mainRoot) return undefined
	const absoluteDir = isAbsolute(dir) ? dir : resolve(dir)
	const absoluteMain = isAbsolute(mainRoot) ? mainRoot : resolve(mainRoot)
	const name = basename(absoluteDir)
	return {
		schemaVersion: KIMCHI_WORKTREE_SCHEMA_VERSION,
		dir: absoluteDir,
		mainRoot: absoluteMain,
		branch: `${WORKTREE_BRANCH_PREFIX}${name}`,
		name,
		named: isUserNamedWorktree(name),
	}
}

/** Auto-generated names look like `bold-oak-a3f2` (adjective-noun-hex). */
const AUTO_NAME_RE = /^[a-z]+-[a-z]+-[0-9a-f]{4}$/

/** True when the worktree name was chosen by the user (not generated). */
export function isUserNamedWorktree(name: string): boolean {
	return !AUTO_NAME_RE.test(name)
}

/**
 * The extension: on session_start, when a worktree binding exists, append a
 * `kimchi_worktree` entry best-effort (a failure must never fail the session).
 * A session_shutdown handler holds the shutdown until the pending append
 * settles, so a short-lived session (ACP) still gets its entry.
 */
export function createWorktreeSessionBindingExtension(
	resolveEntry: () => KimchiWorktreeEntry | undefined = readWorktreeBindingFromEnv,
) {
	const pending = new Set<Promise<void>>()

	const settled = (): Promise<void> => Promise.all([...pending]).then(() => undefined)

	const extension = (pi: ExtensionAPI): void => {
		pi.on("session_start", (event, ctx) => {
			const entry = resolveEntry()
			if (!entry) return
			trackWorktreeEvent(
				"created",
				{ source: "user", named: entry.named, resumed: event?.reason === "resume" },
				trySessionId(ctx),
			)
			const append = Promise.resolve()
				.then(() => pi.appendEntry(KIMCHI_WORKTREE_ENTRY_TYPE, entry))
				.catch((err: unknown) => {
					console.warn(`kimchi_worktree entry not recorded: ${String(err)}`)
				})
				.finally(() => pending.delete(append))
			pending.add(append)
		})
		pi.on("session_shutdown", () => settled())
	}

	return Object.assign(extension, { settled })
}

export default createWorktreeSessionBindingExtension
