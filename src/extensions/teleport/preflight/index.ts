import { refuse } from "../commands/errors.js"
import type { TeleportContext } from "../types.js"
import { gitWorkingTreeDirty } from "./git.js"
import { rsyncInstallHint, whichRsync } from "./rsync.js"

export interface PreflightArgs {
	allowDirty?: boolean
	force?: boolean
	/**
	 * When set, the workspace is hydrated from a fresh `git clone` on the
	 * sandbox rather than rsynced from the local tree, so none of the
	 * local-tree checks below apply.
	 */
	gitRepo?: string
	/**
	 * Clone + working-tree-diff provisioning (`/teleport --fast`). Shipping
	 * uncommitted changes is the whole point of the fast path, so the
	 * dirty-tree refusal is skipped — the rsync availability check still
	 * runs (the diff rsync needs it).
	 */
	fast?: boolean
}

export interface PreflightDeps {
	whichRsync?: typeof whichRsync
	gitWorkingTreeDirty?: typeof gitWorkingTreeDirty
	rsyncInstallHint?: typeof rsyncInstallHint
}

/**
 * Preflight checks that must complete before the progress overlay opens.
 * Kept fast (sub-100 ms) on purpose: the slow workspace-size check is
 * deferred to `runTeleport`'s parallel kick-off, which uses the
 * gitignored-aware local-walker estimate instead of a 5+ second `du -sk`.
 */
export function runPreflight(ctx: TeleportContext, args: PreflightArgs, deps: PreflightDeps = {}): void {
	if (args.gitRepo) return

	const checkRsync = deps.whichRsync ?? whichRsync
	const checkDirty = deps.gitWorkingTreeDirty ?? gitWorkingTreeDirty
	const installHint = deps.rsyncInstallHint ?? rsyncInstallHint

	if (!checkRsync()) {
		refuse(ctx, `rsync is not on PATH. ${installHint()}`)
	}

	if (!args.allowDirty && !args.fast && checkDirty(ctx.cwd)) {
		refuse(ctx, "Working tree has uncommitted changes. Re-run with --allow-dirty to ship them.")
	}
}
