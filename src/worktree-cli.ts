/**
 * Pre-main `--worktree` hook for the TUI/CLI surface (slice 1).
 *
 * Runs in cli.ts before the project-trust block: creates/reuses the worktree
 * under `<mainRoot>/.kimchi/worktrees/<name>`, chdirs the process into it, and
 * seeds the worktree path's trust decision from the main checkout — so a
 * trusted project does not prompt twice. Everything downstream (pi's main()
 * reading process.cwd(), session dir, config, LSP) then follows the worktree.
 *
 * Also exports the shared exit-prompt decision helper used post-main.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent"

import { resolvePreMainProjectTrustWithOverrides } from "./project-trust.js"
import {
	createWorktree,
	generateWorktreeName,
	resolveRepoRoots,
	WORKTREE_INCLUDE_FILE,
	WorktreeError,
	worktreeStatus,
} from "./shared/git/worktree.js"

export const KIMCHI_WORKTREE_ENV = "KIMCHI_WORKTREE"
export const KIMCHI_WORKTREE_MAIN_ENV = "KIMCHI_WORKTREE_MAIN"

export interface PreMainWorktree {
	/** Resolved directory (realpath). */
	path: string
	/** Main checkout root (realpath). */
	mainRoot: string
	/** Branch name, `worktree-<name>`. */
	branch: string
	/** Resolved base ref (branch or SHA). */
	baseRef: string
	/** The name this worktree ended up with (generated for `--worktree` without a name). */
	name: string
	/** True when the directory already existed and was reused. */
	reused: boolean
}

/** <mainRoot>/.kimchi/worktrees/<name> */
function joinWorktreeDir(mainRoot: string, name: string): string {
	return join(mainRoot, ".kimchi", "worktrees", name)
}

/**
 * Validate the launch environment for a worktree session and return the
 * resolved main root. The launch cwd must be (inside) the main checkout —
 * nested worktree-of-a-worktree is refused for v1.
 */
function resolveLaunchRepo(cwd: string): { mainRoot: string; worktreeRoot?: string } {
	const roots = resolveRepoRoots(cwd)
	if (roots.worktreeRoot && roots.worktreeRoot !== roots.mainRoot) {
		throw new WorktreeError("already inside a git worktree — nested worktrees are not supported")
	}
	return roots
}

/**
 * Create (or reuse) the launch worktree, chdir into it, and seed trust.
 *
 * @param cwd launch directory (process.cwd() at the time of the call)
 * @param requestedName undefined for `--worktree` without a name (generated)
 * @param agentDir kimchi's harness agent dir (trust store location)
 * @param trustOverride --approve/--no-approve run override, if any
 */
export async function ensurePreMainWorktree(opts: {
	cwd: string
	requestedName?: string
	agentDir: string
	trustOverride: boolean | undefined
}): Promise<PreMainWorktree> {
	const { mainRoot } = resolveLaunchRepo(opts.cwd)

	const name = opts.requestedName ?? generateWorktreeName()
	const reuseExisting = existsSync(joinWorktreeDir(mainRoot, name))

	const created = await createWorktree({
		mainRoot,
		name,
		baseRef: "fresh",
		reuseExisting,
	})

	// Trust seeding: reuse the same resolution the trust block below applies to
	// the launch dir, but persist the decision for the worktree path so the
	// interactive prompt (inside pi's main) does not fire a second time for the
	// same project in a different directory. Only a *positive* decision is
	// seeded — fail-closed (untrusted) states are never persisted here.
	const launchTrusted = resolvePreMainProjectTrustWithOverrides(mainRoot, opts.agentDir, opts.trustOverride)
	if (launchTrusted) {
		try {
			new ProjectTrustStore(opts.agentDir).set(created.path, true)
		} catch {
			// Trust seeding is best-effort: a failure must not fail the session.
		}
	}

	// Everything downstream (pi's main(), session dir, LSP) reads process.cwd(),
	// so the chdir happens here and the env exports let extensions and
	// subprocesses tell the worktree from the main checkout.
	process.chdir(created.path)
	process.env[KIMCHI_WORKTREE_ENV] = created.path
	process.env[KIMCHI_WORKTREE_MAIN_ENV] = mainRoot

	return { ...created, mainRoot, name, reused: reuseExisting }
}

/** Print the one-line `.worktreeinclude` hint on first creation (no include
 *  file in the main checkout yet). Kept out of the module's core path so
 *  callers choose when to surface it. */
export function maybePrintWorktreeIncludeHint(mainRoot: string, worktree: PreMainWorktree): void {
	if (worktree.reused) return
	if (existsSync(join(mainRoot, WORKTREE_INCLUDE_FILE))) return
	console.error(
		`[worktree] ${worktree.name}: fresh worktree — .kimchi/config.json is not copied. Add a .worktreeinclude file (e.g. ".kimchi/config.json", ".kimchi/permissions.local.json") in the main checkout to carry project config into new worktrees.`,
	)
}

/**
 * Worktree state for the post-main exit prompt (slice 1, TUI only).
 * Returns `undefined` when the directory is no longer a worktree (already
 * removed) — the caller then skips the prompt.
 */
export async function worktreeStatusForExit(dir: string, mainRoot: string) {
	try {
		return await worktreeStatus(dir, mainRoot)
	} catch {
		return undefined
	}
}

export { listWorktrees, removeWorktree, resolveBaseRef, WorktreeError } from "./shared/git/worktree.js"
