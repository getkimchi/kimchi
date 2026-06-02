import { existsSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import type { WorkspaceCredentials } from "../../../sandbox/cloud/types.js"
import { rsyncInstallHint, whichRsync } from "../preflight/rsync.js"
import { SANDBOX_USER } from "../provisioning/constants.js"
import { deriveSandboxDest } from "../provisioning/paths.js"
import { RsyncError, runRsync } from "../provisioning/rsync-runner.js"
import type { TeleportContext } from "../types.js"
import { parseSyncArgs } from "./args.js"
import { info, refuse, status } from "./errors.js"
import { resolveWorkspaceRef } from "./workspace-ref.js"

export async function runSync(rawArgs: string, ctx: TeleportContext): Promise<void> {
	let args: ReturnType<typeof parseSyncArgs>
	try {
		args = parseSyncArgs(rawArgs)
	} catch (err) {
		refuse(ctx, err instanceof Error ? err.message : String(err))
	}

	if (!ctx.apiKey) {
		refuse(ctx, "No API key configured. Run `kimchi login`.")
	}

	if (!whichRsync()) {
		refuse(ctx, `rsync is not on PATH. ${rsyncInstallHint()}`)
	}

	const workspaceId = await resolveWorkspaceRef(ctx, args.workspace, {
		onEmpty: { kind: "refuse", message: "No workspaces available to sync to. Run /teleport first to create one." },
		cannotCreateMessage: "/sync cannot create a new workspace. Run /teleport first.",
	})

	status(ctx, `Syncing ${args.direction}…`)
	let creds: WorkspaceCredentials
	try {
		creds = await authenticateWorkspace(workspaceId, ctx.apiKey, `Sync for ${basename(ctx.cwd)}`, {
			endpoint: ctx.endpoint,
		})
	} catch (err) {
		status(ctx, undefined)
		refuse(ctx, `Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
	}

	const sandboxDest = deriveSandboxDest(ctx.cwd)
	const { localPath, remotePath, fileFilter } = resolveSyncPaths(ctx.cwd, sandboxDest, args)

	try {
		const result = await runRsync({
			source: localPath,
			destination: remotePath,
			remoteHost: creds.host,
			remoteUser: SANDBOX_USER,
			authToken: creds.connectToken,
			excludeGlobs: args.exclude,
			includeIgnored: args.includeIgnored,
			deleteExtraneous: args.delete,
			direction: args.direction,
			dryRun: args.dryRun,
			signal: ctx.signal,
			fileFilter,
		})

		const kb = (result.totalBytes / 1024).toFixed(0)
		const sec = (result.durationMs / 1000).toFixed(1)
		const prefix = args.dryRun ? "Dry run complete" : "Sync complete"
		info(ctx, `${prefix}: ${result.fileCount} file(s), ${kb} KB in ${sec}s.`)
	} catch (err) {
		let msg: string
		if (err instanceof RsyncError) {
			const stderrHead = err.stderr?.trim().slice(0, 1500) ?? ""
			msg = stderrHead ? `${err.message}\nstderr:\n${stderrHead}` : err.message
		} else {
			msg = err instanceof Error ? err.message : String(err)
		}
		refuse(ctx, `rsync failed: ${msg}`)
	} finally {
		status(ctx, undefined)
	}
}

interface ResolvedPaths {
	localPath: string
	remotePath: string
	fileFilter?: string
}

/**
 * Detect single-file mode and split the path into the directory rsync
 * should operate on plus the file-filter that limits the transfer to one file.
 *
 * For `up` we can stat the local source directly. For `down` we cannot stat
 * the remote, so we treat paths that don't end with "/" and whose last
 * segment contains a dot as files (heuristic — covers the vast majority of
 * real filenames).
 */
function resolveSyncPaths(cwd: string, sandboxDest: string, args: ReturnType<typeof parseSyncArgs>): ResolvedPaths {
	if (!args.path) {
		return { localPath: cwd, remotePath: sandboxDest }
	}

	let singleFile = false
	if (args.direction === "up") {
		const full = join(cwd, args.path)
		singleFile = existsSync(full) && statSync(full).isFile()
	} else {
		const last = args.path.split("/").pop() ?? ""
		singleFile = !args.path.endsWith("/") && last.includes(".")
	}

	if (singleFile) {
		const fileName = basename(args.path)
		return {
			localPath: join(cwd, dirname(args.path)),
			remotePath: join(sandboxDest, dirname(args.path)),
			fileFilter: fileName,
		}
	}

	return {
		localPath: join(cwd, args.path),
		remotePath: join(sandboxDest, args.path),
	}
}
