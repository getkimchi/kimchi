import { SANDBOX_USER } from "./constants.js"
import { sumIncludeListBytes } from "./estimate-bytes.js"
import { buildChangedFilesList } from "./include-list.js"
import { formatRsyncFailure, runRsync } from "./rsync-runner.js"

/**
 * Exclude filters applied to the diff rsync after a server-side clone.
 * The clone's `.git` must never be touched, and secrets / harness state
 * should not leak to the sandbox.
 */
export const DIFF_RSYNC_EXCLUDES: readonly string[] = [".git/", ".env", ".env.*", ".envrc", ".kimchi/"]

export interface SyncLocalChangesOptions {
	/** Absolute path to the local working directory (source). */
	localPath: string
	/** Destination path on the sandbox (e.g. `/home/sandbox/<repo>/`). */
	remotePath: string
	/** Sandbox SSH host (expanded by ssh's %h in ProxyCommand). */
	remoteHost: string
	/** Bearer token surfaced to teleport-proxy via the AUTH_TOKEN env var. */
	authToken: string
	/** Whether the remote clone was freshly created (enables `--delete`). */
	freshClone: boolean
	/** Cancellation. */
	signal?: AbortSignal
	/** Non-fatal warning (e.g. rsync failure, stale remote dir). */
	onWarn?: (message: string) => void
	/** Phase callback — mirrors runRsync's onPhase. */
	onPhase?: (phase: "estimate" | "mkdir" | "rsync") => void
	/** Cumulative progress callback — mirrors runRsync's onCumulativeProgress. */
	onCumulativeProgress?: (info: { transferredBytes: number; totalBytes: number; pct: number }) => void
	/** Status message callback (e.g. "No local changes to sync", "Syncing local changes"). */
	onStatus?: (message: string) => void
}

/**
 * After a server-side clone (createSession with `details.git`), sync the
 * local working-tree diff on top of the fresh clone. Shared by
 * `/teleport --fast` and `/remote-run`.
 *
 * Computes the changed-files list (diff vs upstream + untracked, minus
 * deleted), estimates the upload size, and runs a diff rsync with
 * `--files-from`. The `.git` directory and secrets are always excluded.
 *
 * Failures are **non-fatal**: the clone is already there, just some
 * working-tree files may be stale. The caller is notified via `onWarn`.
 * An abort signal is re-thrown so the caller can unwind.
 */
export async function syncLocalChangesAfterClone(opts: SyncLocalChangesOptions): Promise<void> {
	const changedFiles = await buildChangedFilesList(opts.localPath, opts.signal).catch(() => [])
	if (changedFiles.length === 0) {
		opts.onStatus?.("No local changes to sync")
		return
	}

	const estimatedBytes = await sumIncludeListBytes(opts.localPath, changedFiles, opts.signal).catch(() => 0)

	if (!opts.freshClone) {
		opts.onWarn?.("Remote dir already existed — skipping pruning of extra remote files")
	}

	opts.onStatus?.("Syncing local changes")
	try {
		await runRsync({
			localPath: opts.localPath,
			remotePath: opts.remotePath,
			isSourceDirectory: true,
			remoteHost: opts.remoteHost,
			remoteUser: SANDBOX_USER,
			authToken: opts.authToken,
			signal: opts.signal,
			deleteExtraneous: opts.freshClone,
			excludeFilters: [...DIFF_RSYNC_EXCLUDES],
			precomputeTotal: true,
			precomputedTotalBytes: estimatedBytes,
			filesFrom: changedFiles,
			onPhase: opts.onPhase,
			onCumulativeProgress: opts.onCumulativeProgress,
		})
	} catch (err) {
		if (opts.signal?.aborted) throw err
		opts.onWarn?.(formatRsyncFailure(err))
	}
}
