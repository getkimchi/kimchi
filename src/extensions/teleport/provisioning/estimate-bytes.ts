import type { Dirent } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join, posix } from "node:path"
import { Semaphore } from "./concurrency.js"

// FS-op concurrency caps. The walker shares one semaphore across the whole
// recursive tree so total in-flight readdir+stat calls stay bounded no matter
// how wide the directory fans out. The flat-list stat batch is gated
// separately at a higher limit because each op is independent and cheaper.
const WALK_FS_CONCURRENCY = 50
const STAT_LIST_CONCURRENCY = 100

/**
 * Directories pruned at readdir time when estimating upload bytes. These
 * are the directory entries in BASE_EXCLUDE_GLOBS — the cheap blanket
 * coverage for huge generic dirs that rsync's exclude file will also skip.
 * Exported and re-used by rsync-runner so the two stay aligned.
 */
export const PRUNE_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	"dist",
	"build",
	".next",
	"target",
	"__pycache__",
	".venv",
	"venv",
	".kimchi",
])

/**
 * Local-only estimate of the bytes rsync will see (and thus the cumulative
 * progress denominator). Walks `localPath` recursively, summing sizes of
 * regular files, applying two layers of exclusion that together mirror what
 * rsync's exclude file does:
 *
 *  1. Hardcoded `PRUNE_DIRS` skip at the readdir level — fast blanket
 *     coverage for `node_modules` and friends.
 *  2. Per-file lookup in `ignoredPaths` — typically the output of
 *     `git ls-files --cached --others --ignored --exclude-standard`, so
 *     the user's project-specific `.gitignore` is honored without paying
 *     for an rsync dry-run over the WSS tunnel.
 *
 * Symlinks are skipped (rsync preserves them as symlinks without
 * transferring content).
 *
 * Per-entry errors (file deleted between readdir and stat, permission
 * denied) are swallowed; the walk never throws mid-stream. The caller's
 * existing fallback (no cumulative progress, real rsync still runs)
 * handles the rare top-level failure.
 */
export async function estimateUploadBytes(
	localPath: string,
	ignoredPaths: ReadonlySet<string>,
	signal?: AbortSignal,
): Promise<number> {
	let total = 0
	const sem = new Semaphore(WALK_FS_CONCURRENCY)

	async function walk(absDir: string, relDir: string): Promise<void> {
		if (signal?.aborted) throw new Error("aborted")
		let entries: Dirent[]
		try {
			entries = await sem.run(() => readdir(absDir, { withFileTypes: true }))
		} catch {
			return
		}
		await Promise.all(
			entries.map(async (entry) => {
				if (signal?.aborted) return
				const name = entry.name
				const relPath = relDir.length === 0 ? name : posix.join(relDir, name)
				if (entry.isDirectory()) {
					if (PRUNE_DIRS.has(name)) return
					await walk(join(absDir, name), relPath)
					return
				}
				if (entry.isSymbolicLink()) return
				if (!entry.isFile()) return
				if (ignoredPaths.has(relPath)) return
				try {
					const st = await sem.run(() => stat(join(absDir, name)))
					if (st.isFile()) total += st.size
				} catch {
					// File disappeared between readdir and stat, or permission denied.
				}
			}),
		)
	}

	await walk(localPath, "")
	return total
}

/**
 * Sum the on-disk sizes of every file in an explicit include list.
 * Used by `runTeleport` to compute the cumulative-progress denominator
 * when running rsync in `--files-from` mode — much cheaper than the
 * tree walker above because we already know the exact set of files
 * (no `readdir`, no PRUNE_DIRS dance, no gitignored-Set lookup). Per-
 * entry errors (file vanished, permission denied, symlink to nowhere)
 * are swallowed so the sum still completes for the rest of the list.
 */
export async function sumIncludeListBytes(
	localPath: string,
	list: readonly string[],
	signal?: AbortSignal,
): Promise<number> {
	if (signal?.aborted) throw new Error("aborted")
	const sem = new Semaphore(STAT_LIST_CONCURRENCY)
	const sizes = await Promise.all(
		list.map(async (rel) => {
			if (signal?.aborted) return 0
			try {
				const st = await sem.run(() => stat(join(localPath, rel)))
				return st.isFile() ? st.size : 0
			} catch {
				return 0
			}
		}),
	)
	return sizes.reduce((a, b) => a + b, 0)
}
