import { spawn, spawnSync } from "node:child_process"
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
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

/**
 * The release carries the work-reporting plugins for official Claude Code
 * and Codex in share/kimchi/bridge (scripts/bundle-bridge.sh), and
 * install.sh adds them to the clients it finds. Their code runs on this
 * binary. After an update that brings new plugin code, rerun the bundled
 * installer for the added clients: it relinks the code, and registers the
 * plugins again only when their hooks changed. Detached, like the memory
 * capture worker: registering takes seconds, and a failure keeps the old
 * code receipt, so the next update retries.
 */
export function defaultBridgePrefix(): string {
	return process.env.KIMCHI_BRIDGE_PREFIX || join(homedir(), ".local", "share", "kimchi-bridge")
}

/** Where refreshBridge streams the installer child's output. */
export function bridgeRefreshLogPath(prefix = defaultBridgePrefix()): string {
	return join(prefix, "refresh.log")
}

/**
 * The release carries the work-reporting plugins for official Claude Code
 * and Codex in share/kimchi/bridge (scripts/bundle-bridge.sh), and
 * install.sh adds them to the clients it finds. Their code runs on this
 * binary. After an update that brings new plugin code, rerun the bundled
 * installer for the added clients: it relinks the code, and registers the
 * plugins again only when their hooks changed. Detached, like the memory
 * capture worker: registering takes seconds, and a failure keeps the old
 * code receipt, so the next update retries. The child's output is streamed
 * to refresh.log so a failure is never silent (see reportBridgeRefresh).
 */
export function refreshBridge(
	shareDir: string,
	kimchiBin: string,
	prefix = defaultBridgePrefix(),
): string[] {
	const read = (path: string) => {
		try {
			return readFileSync(path, "utf8").trim()
		} catch {
			return undefined
		}
	}
	const bundled = read(join(shareDir, "bridge", "VERSION"))
	// Clients without a receipt were never added, or were removed with kimchi-bridge uninstall.
	const clients = ["claude", "codex"].filter((client) => read(join(prefix, "installed", client)) !== undefined)
	if (!bundled || clients.length === 0 || read(join(prefix, "installed", "code")) === bundled) return []
	// One client at a time: the installer holds a lock for its whole run. $0 is the installer.
	mkdirSync(prefix, { recursive: true })
	const logPath = bridgeRefreshLogPath(prefix)
	const logFd = openSync(logPath, "a")
	let logClosed = false
	const closeLog = () => {
		if (logClosed) return
		logClosed = true
		try {
			closeSync(logFd)
		} catch (err) {
			console.error("kimchi update: failed to close bridge refresh log:", (err as Error).message)
		}
	}
	const child = spawn(
		"/bin/sh",
		[
			"-c",
			'for client in "$@"; do bash "$0" update "$client"; done',
			join(shareDir, "bridge", "install.sh"),
			...clients,
		],
		// stdout/stderr go to refresh.log so failures are diagnosable; the fd
		// is closed by the child's error/exit handler.
		{ detached: true, stdio: ["ignore", logFd, logFd], env: { ...process.env, KIMCHI_BIN: kimchiBin } },
	)
	child.on("error", (err) => {
		console.error("kimchi update: work-reporting plugin update failed to start:", err.message)
		closeLog()
	})
	child.on("exit", () => closeLog())
	child.unref()
	return clients
}

/**
 * Set expectations and surface a refresh that did not finish. Reports the
 * clients being updated, polls briefly for the installed/code marker to
 * reach the bundled version (the installer writes it last), and warns when
 * the marker is still stale afterwards — pointing at refresh.log. Never
 * throws: a slow or failed plugin refresh must not break the update itself
 * (the next update retries, per refreshBridge's design).
 */
export async function reportBridgeRefresh(
	shareDir: string,
	clients: string[],
	prefix = defaultBridgePrefix(),
	timeoutMs = 10_000,
): Promise<void> {
	const read = (path: string) => {
		try {
			return readFileSync(path, "utf8").trim()
		} catch {
			return undefined
		}
	}
	if (clients.length === 0) {
		// First contact: the update ships the bridge to a machine that never
		// opted in. Tell the user once and point at the explicit opt-in; a
		// one-time marker keeps the notice off later updates.
		const bundled = read(join(shareDir, "bridge", "VERSION"))
		if (bundled) {
			const marker = join(prefix, ".bridge-notice-shown")
			if (!existsSync(marker)) {
				console.log(
					"kimchi: this update includes work reporting for Claude Code and Codex — install it and route " +
						"inference with `kimchi bridge setup`; undo anytime with `kimchi bridge remove`.",
				)
				try {
					mkdirSync(prefix, { recursive: true })
					writeFileSync(marker, "1\n", { flag: "wx" })
				} catch {
					// Best effort: another run may have written the marker first.
				}
			}
		}
		return
	}
	console.log(`kimchi update: updating work reporting for: ${clients.join(", ")}`)
	const bundled = read(join(shareDir, "bridge", "VERSION"))
	if (!bundled) return
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (read(join(prefix, "installed", "code")) === bundled) return
		await new Promise((resolve) => setTimeout(resolve, 300))
	}
	const current = read(join(prefix, "installed", "code")) ?? "none"
	console.error(
		`kimchi update: work reporting plugin update did not complete (bridge ${bundled}, receipts on ${current}) — rerun "kimchi update"; details: ${bridgeRefreshLogPath(prefix)}`,
	)
}
