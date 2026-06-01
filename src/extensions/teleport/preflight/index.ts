import { refuse, warn } from "../commands/errors.js"
import type { TeleportContext } from "../types.js"
import { gitWorkingTreeDirty } from "./git.js"
import { rsyncInstallHint, whichRsync } from "./rsync.js"
import { SIZE_REFUSE_BYTES, SIZE_WARN_BYTES, estimateWorkspaceBytes } from "./workspace-size.js"

export interface PreflightArgs {
	allowDirty?: boolean
	force?: boolean
	/**
	 * When set, the workspace is hydrated from a fresh `git clone` on the
	 * sandbox rather than rsynced from the local tree, so none of the
	 * local-tree checks below apply.
	 */
	gitRepo?: string
}

export interface PreflightDeps {
	whichRsync?: typeof whichRsync
	gitWorkingTreeDirty?: typeof gitWorkingTreeDirty
	estimateWorkspaceBytes?: typeof estimateWorkspaceBytes
	rsyncInstallHint?: typeof rsyncInstallHint
}

export function runPreflight(ctx: TeleportContext, args: PreflightArgs, deps: PreflightDeps = {}): void {
	if (args.gitRepo) return

	const checkRsync = deps.whichRsync ?? whichRsync
	const checkDirty = deps.gitWorkingTreeDirty ?? gitWorkingTreeDirty
	const checkSize = deps.estimateWorkspaceBytes ?? estimateWorkspaceBytes
	const installHint = deps.rsyncInstallHint ?? rsyncInstallHint

	if (!checkRsync()) {
		refuse(ctx, `rsync is not on PATH. ${installHint()}`)
	}

	if (!args.allowDirty && checkDirty(ctx.cwd)) {
		refuse(ctx, "Working tree has uncommitted changes. Re-run with --allow-dirty to ship them.")
	}

	const wsBytes = checkSize(ctx.cwd)
	if (wsBytes > SIZE_REFUSE_BYTES && !args.force) {
		const gb = (wsBytes / 1_000_000_000).toFixed(1)
		refuse(ctx, `Workspace is large (${gb} GB). Re-run with --force to proceed.`)
	}
	if (wsBytes > SIZE_WARN_BYTES) {
		const mb = (wsBytes / 1_000_000).toFixed(0)
		warn(ctx, `Workspace is ${mb} MB — sync may take a while.`)
	}
}
