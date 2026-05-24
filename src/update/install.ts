import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { backupDir } from "./paths.js"

/**
 * Run `<newPath> --version` and assert it exits 0. Catches a corrupt
 * release before the rename swaps it into place. We swallow stdout but
 * surface the exit code so any post-mortem can see what went wrong.
 */
export function smokeTestBinary(newPath: string): void {
	const result = spawnSync(newPath, ["--version"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || "").trim()
		throw new Error(`new binary failed --version smoke test: ${detail || `exit ${result.status}`}`)
	}
}

/**
 * Ad-hoc codesign the new binary on macOS so Gatekeeper doesn't kill it
 * on first launch. Bun-compiled binaries need this whenever they're moved
 * to a new path. Mirrors `scripts/build-binary.js` post-compile signing.
 *
 * No-op on non-macOS. Doesn't fail hard if `codesign` is missing — it's
 * pre-installed on every macOS shipping with Xcode CLT, but if it's
 * somehow unavailable, the user can still use the new binary by clicking
 * through the first-run Gatekeeper dialog.
 */
export function macosCodesignReSign(newPath: string): void {
	if (process.platform !== "darwin") return

	const remove = spawnSync("codesign", ["--remove-signature", newPath], {
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf-8",
	})
	if (remove.status !== 0 && (remove.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
		console.error(`kimchi update: codesign --remove-signature failed: ${remove.stderr.trim()}`)
	}

	const sign = spawnSync("codesign", ["--sign", "-", "--force", newPath], {
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf-8",
	})
	if (sign.status !== 0) {
		const detail = sign.stderr.trim() || sign.error?.message || `exit ${sign.status}`
		throw new Error(`codesign re-sign failed: ${detail}`)
	}
}

/**
 * Replace `currentPath` with `newPath` atomically. Strategy depends on OS:
 *
 * - **Linux / macOS**: POSIX rename(2) does an inode swap, not a write,
 *   so swapping the directory entry while the binary is executing is
 *   safe. The running process holds the old inode; subsequent execs pick
 *   up the new one. ETXTBSY only fires on attempts to *write to* the
 *   running binary, which we never do.
 *
 *   When source and destination are on different filesystems rename(2)
 *   returns EXDEV. In that case we copy the new binary to a temp file on
 *   the target filesystem and rename it into place — the final rename is
 *   still atomic.
 *
 * - **Windows**: cannot rename or delete a running .exe (the OS holds an
 *   exclusive lock). Strategy used by `bun upgrade` and `deno upgrade`:
 *   rename `kimchi.exe` → `kimchi.exe.old`, drop the new binary in as
 *   `kimchi.exe`, leave the .old behind for the next launch to clean up.
 *   We can't delete the old in this run because we're still it.
 *
 * Optionally backs up the old binary to ~/.cache/kimchi/backups/ before
 * the swap so a corrupt new version can be rolled back manually.
 */
export function atomicInstall(newPath: string, currentPath: string): { backupPath?: string } {
	const backupRoot = backupDir()
	mkdirSync(backupRoot, { recursive: true, mode: 0o700 })

	if (process.platform === "win32") {
		const dotOld = `${currentPath}.old`
		// If a previous update left a stale .old behind, clean it now —
		// we'll write to dotOld below and want a clean slate.
		try {
			unlinkSync(dotOld)
		} catch {
			// non-fatal — continue
		}
		renameSync(currentPath, dotOld)
		try {
			renameSync(newPath, currentPath)
		} catch (err) {
			// Roll back: put the old binary back where it was so we don't leave
			// the user without a kimchi.exe.
			try {
				renameSync(dotOld, currentPath)
			} catch {
				// already unhealthy — surface the original failure
			}
			throw err
		}
		return { backupPath: dotOld }
	}

	// POSIX: keep a copy of the current binary as a backup before the swap.
	// rename(currentPath, backup) would also work but takes the binary out
	// of place during the window — copyFileSync is fine since we have time.
	const backupPath = join(backupRoot, `kimchi.${Date.now()}`)
	try {
		copyFileSync(currentPath, backupPath)
	} catch {
		// Backup is best-effort — don't fail the update if we can't write
		// the backups dir (e.g. read-only fs).
	}

	// Atomic swap. fs.renameSync uses POSIX rename(2) under the hood.
	mkdirSync(dirname(currentPath), { recursive: true })
	try {
		renameSync(newPath, currentPath)
	} catch (err) {
		// EXDEV: source and destination are on different filesystems.
		// rename(2) cannot cross mount points. Fall back to copying the
		// new binary to a temp file on the target filesystem and then
		// atomically renaming it into place.
		if ((err as NodeJS.ErrnoException).code === "EXDEV") {
			const tempPath = `${currentPath}.new.${Date.now()}`
			const { mode } = statSync(newPath)
			copyFileSync(newPath, tempPath)
			// copyFileSync does not preserve the source mode. Restore the
			// executable bit (and any other permissions) so the renamed
			// binary remains runnable.
			chmodSync(tempPath, mode)
			try {
				renameSync(tempPath, currentPath)
			} catch (renameErr) {
				// Clean up the temp file so we don't leave litter.
				try {
					unlinkSync(tempPath)
				} catch {
					// non-fatal — continue
				}
				throw renameErr
			}
			// Clean up the original extracted binary on the source fs.
			try {
				unlinkSync(newPath)
			} catch {
				// non-fatal — the extract cleanup in applyUpdate will
				// handle the containing directory.
			}
			return { backupPath }
		}
		throw err
	}

	return { backupPath }
}

/**
 * Copy all files and directories from srcDir to dstDir, skipping entries
 * that match skipName (typically the binary name to avoid copying it twice).
 * Preserves directory structure and file permissions.
 */
export function copySupportingFiles(srcDir: string, dstDir: string, skipName?: string): void {
	const entries = readdirSync(srcDir)
	mkdirSync(dstDir, { recursive: true, mode: 0o755 })

	for (const entry of entries) {
		if (skipName && entry === skipName) {
			continue
		}
		const src = join(srcDir, entry)
		const dst = join(dstDir, entry)
		const stat = statSync(src)
		if (stat.isDirectory()) {
			copyDir(src, dst)
		} else {
			copyFile(src, dst)
		}
	}
}

/**
 * Recursively copy a directory from src to dst, preserving permissions.
 */
function copyDir(src: string, dst: string): void {
	mkdirSync(dst, { recursive: true, mode: 0o755 })
	const entries = readdirSync(src)
	for (const entry of entries) {
		const s = join(src, entry)
		const d = join(dst, entry)
		const stat = statSync(s)
		if (stat.isDirectory()) {
			copyDir(s, d)
		} else {
			copyFile(s, d)
		}
	}
}

/**
 * Copy a single file from src to dst. copyFileSync preserves the source's
 * mode bits on POSIX by default — its third argument is for COPYFILE_*
 * behavioral flags (range 0–7), not file permissions.
 */
function copyFile(src: string, dst: string): void {
	copyFileSync(src, dst)
}
