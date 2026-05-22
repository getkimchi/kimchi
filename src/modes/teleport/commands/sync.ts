import { existsSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { RemoteAuthError, authenticateRemoteSession } from "../api/index.js"
import type { AuthenticateResponse } from "../api/types.js"
import type { RemoteAgentSession } from "../proxy/agent-session.js"
import { BASE_EXCLUDE_GLOBS, RsyncError, runRsync } from "../sync/rsync.js"
import type { SyncArgs } from "./args.js"
import { info, refuse, status, warn } from "./errors.js"
import { readSessionId } from "./session-resolve.js"
import { deriveSandboxDest, rsyncInstallHint, whichRsync } from "./teleport-helpers.js"
import { SANDBOX_USER, type TeleportContext } from "./types.js"

/**
 * Rsync files between the local workspace and the foregrounded remote sandbox.
 *
 * - `/sync up`   — push local changes to the remote.
 * - `/sync down` — pull remote changes to local.
 *
 * An optional `path` narrows the sync to a sub-directory or file relative to
 * the workspace root.
 */
export async function runSync(args: SyncArgs, ctx: TeleportContext): Promise<void> {
	const wrapper = ctx.wrapper

	// ── Pre-flight ──

	if (wrapper.isForegroundHomeBase) {
		refuse(ctx, "Not attached to a remote session. Use /attach first, then /sync.")
	}

	if (!(await whichRsync())) {
		refuse(ctx, `rsync is not on PATH. ${rsyncInstallHint()}`)
	}

	const remote = wrapper.foreground as unknown as RemoteAgentSession
	const sessionId = readSessionId(remote)
	if (!sessionId) {
		refuse(ctx, "Foreground remote has no session id; cannot sync.")
	}

	// ── Authenticate for a connect token ──

	status(ctx, `Syncing ${args.direction}\u2026`)
	let authResult: AuthenticateResponse
	try {
		authResult = await authenticateRemoteSession(sessionId, ctx.apiKey, `Sync for ${basename(ctx.cwd)}`, {
			endpoint: ctx.endpoint,
		})
	} catch (err) {
		if (err instanceof RemoteAuthError) {
			refuse(ctx, `Authentication failed for ${sessionId}: ${err.message}`)
		}
		refuse(ctx, `Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
	}

	// ── Resolve paths ──

	const sandboxDest = deriveSandboxDest(ctx.cwd)

	// Detect whether the sub-path targets a single file.
	// For "up" we can stat locally. For "down" we cannot stat the remote side,
	// so we treat paths that don't end with "/" and whose last segment contains
	// a dot as files (heuristic \u2014 covers the vast majority of real filenames).
	let singleFile = false
	if (args.path) {
		if (args.direction === "up") {
			const full = join(ctx.cwd, args.path)
			singleFile = existsSync(full) && statSync(full).isFile()
		} else {
			const last = args.path.split("/").pop() ?? ""
			singleFile = !args.path.endsWith("/") && last.includes(".")
		}
	}

	// For single files rsync needs the parent directory as the source/destination
	// so that ensureTrailingSlash (inside buildRsyncArgv) and mkdir operate on
	// a real directory. We then use --include/--exclude (via fileFilter) to
	// restrict the transfer to just that one file.
	let localPath: string
	let remotePath: string
	let fileFilter: string | undefined

	if (singleFile && args.path) {
		const fileName = basename(args.path)
		localPath = join(ctx.cwd, dirname(args.path))
		remotePath = join(sandboxDest, dirname(args.path))
		fileFilter = fileName
	} else {
		localPath = args.path ? join(ctx.cwd, args.path) : ctx.cwd
		remotePath = args.path ? join(sandboxDest, args.path) : sandboxDest
	}

	// ── Rsync ──

	const dirLabel = args.direction === "up" ? "local \u2192 remote" : "remote \u2192 local"
	const dryLabel = args.dryRun ? " (dry run)" : ""
	const pathLabel = args.path ? ` [${args.path}]` : ""
	info(ctx, `Syncing ${dirLabel}${pathLabel}${dryLabel}\u2026`)

	try {
		const result = await runRsync({
			source: localPath,
			destination: remotePath,
			remoteHost: authResult.host,
			remoteUser: SANDBOX_USER,
			authToken: authResult.connectToken,
			excludeGlobs: [...BASE_EXCLUDE_GLOBS, ...args.exclude],
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
