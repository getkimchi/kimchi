import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join, posix } from "node:path"
import { authenticateWorkspace } from "../../../sandbox/cloud/auth.js"
import type { WorkspaceCredentials } from "../../../sandbox/cloud/types.js"
import { rsyncInstallHint, whichRsync } from "../preflight/rsync.js"
import { SANDBOX_HOME, SANDBOX_USER } from "../provisioning/constants.js"
import { RsyncError, runRsync } from "../provisioning/rsync-runner.js"
import type { TeleportContext } from "../types.js"
import { SyncProgressRow } from "../ui/sync-progress-row.js"
import { type SyncArgs, parseSyncArgs } from "./args.js"
import { info, refuse } from "./errors.js"
import { resolveWorkspaceRef } from "./workspace-ref.js"

export async function runSync(rawArgs: string, ctx: TeleportContext): Promise<void> {
	let args: SyncArgs
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

	const progress = createInlineProgress(ctx)
	try {
		progress.setPhase("Resolving workspace…")
		const workspace = await resolveWorkspaceRef(ctx, args.workspace, {
			onEmpty: {
				kind: "refuse",
				message: `No workspace matching "${args.workspace}". Try /workspaces to see the available ones.`,
			},
		})

		let resolved: ResolvedPaths
		try {
			resolved = resolveSyncPaths(ctx.cwd, args)
		} catch (err) {
			refuse(ctx, err instanceof Error ? err.message : String(err))
		}

		progress.setPhase("Authenticating…")
		let creds: WorkspaceCredentials
		try {
			creds = await authenticateWorkspace(workspace.id, ctx.apiKey, workspace.name ?? (basename(ctx.cwd) || "kimchi"), {
				endpoint: ctx.endpoint,
			})
		} catch (err) {
			refuse(ctx, `Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
		}

		try {
			const result = await runRsync({
				localPath: resolved.localPath,
				remotePath: resolved.remotePath,
				direction: args.direction,
				isSourceDirectory: resolved.isSourceDirectory,
				remoteHost: creds.host,
				remoteUser: SANDBOX_USER,
				authToken: creds.connectToken,
				excludeGlobs: args.exclude,
				includeIgnored: args.includeIgnored,
				deleteExtraneous: args.delete,
				dryRun: args.dryRun,
				signal: ctx.signal,
				onPhase: (phase) => {
					progress.setPhase(phase === "mkdir" ? "Preparing destination…" : `Syncing ${args.direction}…`)
				},
				onProgress: (pct, bytes) => progress.setRsyncTick(pct, bytes),
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
		}
	} finally {
		progress.stop()
	}
}

const SYNC_WIDGET_KEY = "kimchi-sync-progress"
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPIN_MS = 100

interface InlineProgress {
	setPhase(text: string): void
	setRsyncTick(pct: number, bytes: number): void
	stop(): void
}

/**
 * Mount a single-line progress widget above the editor for the duration of
 * `/sync`. The setInterval keeps the spinner ticking even during sub-steps
 * that don't emit rsync progress (workspace listing, auth, ssh mkdir).
 * `setRsyncTick` only stashes the latest pct/bytes — the next spinner tick
 * picks them up, so we don't fight rsync's per-file flurry of updates.
 */
function createInlineProgress(ctx: TeleportContext): InlineProgress {
	let phase = ""
	let suffix = ""
	let frame = 0
	let stopped = false
	let tui: { requestRender(force?: boolean): void } | undefined

	const getState = () => ({ spinnerFrame: SPIN_FRAMES[frame], phase, suffix })

	ctx.ui.setWidget(
		SYNC_WIDGET_KEY,
		(t, theme) => {
			tui = t
			return new SyncProgressRow(getState, theme)
		},
		{ placement: "aboveEditor" },
	)

	const id = setInterval(() => {
		if (stopped) return
		frame = (frame + 1) % SPIN_FRAMES.length
		tui?.requestRender()
	}, SPIN_MS)

	return {
		setPhase(text) {
			if (stopped) return
			phase = text
			suffix = ""
			tui?.requestRender()
		},
		setRsyncTick(pct, bytes) {
			if (stopped) return
			suffix = ` ${formatBytes(bytes)} (${pct}%)`
		},
		stop() {
			if (stopped) return
			stopped = true
			clearInterval(id)
			ctx.ui.setWidget(SYNC_WIDGET_KEY, undefined, { placement: "aboveEditor" })
		},
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export interface ResolvedPaths {
	/** Always the local path — source for `up`, target for `down`. */
	localPath: string
	/** Always the remote path — target for `up`, source for `down`. */
	remotePath: string
	/** Whether the *source* of the transfer is a directory. */
	isSourceDirectory: boolean
}

/**
 * Resolve the user-supplied `--source` and `--target` into absolute local
 * and remote paths, and decide whether the source is a directory.
 *
 * For `up` the source can be stat'ed locally; for `down` we cannot reach
 * the remote, so directory-ness is signalled by a trailing slash on the
 * source argument.
 */
export function resolveSyncPaths(cwd: string, args: SyncArgs): ResolvedPaths {
	if (args.direction === "up") {
		const localPath = expandLocal(args.source, cwd)
		const remotePath = expandRemote(args.target)
		if (!existsSync(localPath)) {
			throw new Error(`Local source does not exist: ${args.source}`)
		}
		return {
			localPath,
			remotePath,
			isSourceDirectory: statSync(localPath).isDirectory(),
		}
	}
	const remotePath = expandRemote(args.source)
	const localPath = expandLocal(args.target, cwd)
	return {
		localPath,
		remotePath,
		isSourceDirectory: args.source.endsWith("/"),
	}
}

function expandLocal(p: string, cwd: string): string {
	if (p === "~" || p.startsWith("~/")) {
		return join(homedir(), p.slice(1))
	}
	if (isAbsolute(p)) return p
	return join(cwd, p)
}

function expandRemote(p: string): string {
	if (p === "~" || p.startsWith("~/")) {
		return posix.join(SANDBOX_HOME, p.slice(1) || ".")
	}
	if (p.startsWith("/")) return p
	return posix.join(SANDBOX_HOME, p)
}
