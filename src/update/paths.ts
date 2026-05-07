import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, normalize } from "node:path"

const APP_DIR = "kimchi"

/**
 * Cache base, honoring XDG_CACHE_HOME on Linux. Used as the parent of
 * state.json and any backup files.
 */
export function cacheDir(): string {
	const xdg = process.env.XDG_CACHE_HOME
	if (xdg && xdg.length > 0) return xdg
	return join(homedir(), ".cache")
}

/** State file path: ~/.cache/kimchi/state.json (or under $XDG_CACHE_HOME). */
export function statePath(): string {
	return join(cacheDir(), APP_DIR, "state.json")
}

/** Backups dir: ~/.cache/kimchi/backups/. Created on demand by the installer. */
export function backupDir(): string {
	return join(cacheDir(), APP_DIR, "backups")
}

/**
 * The real path of the running kimchi binary, with symlinks resolved. We
 * follow symlinks so writing to the result lands on the actual file
 * (Homebrew, manual installs, etc. all symlink kimchi from /usr/local/bin).
 */
export function resolveExecutablePath(): string {
	// process.execPath is the running binary in a Bun-compiled `kimchi` —
	// for `bun run` it points at the bun interpreter, but the self-update
	// path is only meant to run from the compiled binary, so this is fine.
	return realpathSync(process.execPath)
}

/**
 * Return every plausible Homebrew prefix we should consider, in order:
 *  1. $HOMEBREW_PREFIX (user override or set by `brew shellenv`)
 *  2. Apple-Silicon default: /opt/homebrew
 *  3. Intel-macOS / Linux default: /usr/local
 */
function homebrewPrefixes(): string[] {
	const prefixes: string[] = []
	const env = process.env.HOMEBREW_PREFIX
	if (env && env.length > 0) prefixes.push(normalize(env))
	// Always include the two well-known defaults so detection works even when
	// the user hasn't sourced `brew shellenv` in the current shell.
	for (const p of ["/opt/homebrew", "/usr/local"]) {
		if (!prefixes.includes(p)) prefixes.push(p)
	}
	return prefixes
}

/**
 * Return true when the running binary is managed by Homebrew.
 *
 * Detection strategy (in order):
 *
 * 1. **Cellar path** – the real path of the binary (symlinks resolved)
 *    starts with `<prefix>/Cellar/`. This is the most reliable signal:
 *    Homebrew stores versioned copies there and symlinks them into
 *    `<prefix>/bin`.
 *
 * 2. **Bin-dir symlink** – the *unresolved* `process.execPath` lives inside
 *    `<prefix>/bin/` and resolving it leads somewhere inside that prefix.
 *    This catches the common `<prefix>/bin/kimchi → <prefix>/Cellar/…/kimchi`
 *    layout without requiring a Cellar sub-path check.
 *
 * Returns false on non-macOS/non-Linux platforms and when the Cellar
 * directory doesn't exist (rules out a bare `/opt/homebrew` prefix that
 * was never a real Homebrew installation).
 */
export function isHomebrewInstall(): boolean {
	if (process.platform === "win32") return false

	let realExec: string
	try {
		realExec = realpathSync(process.execPath)
	} catch {
		return false
	}

	for (const prefix of homebrewPrefixes()) {
		const cellar = join(prefix, "Cellar")
		// Only treat this prefix as a real Homebrew installation if the Cellar
		// directory actually exists on disk.
		if (!existsSync(cellar)) continue

		// Resolve the cellar and prefix paths themselves so that macOS's
		// /var → /private/var symlink (and similar) doesn't cause a
		// startsWith mismatch against the already-resolved realExec.
		let realCellar: string
		let realPrefix: string
		try {
			realCellar = realpathSync(cellar)
			realPrefix = realpathSync(prefix)
		} catch {
			continue
		}

		// Check 1: real path is inside the Cellar.
		if (realExec.startsWith(`${realCellar}${sep}`)) return true

		// Check 2: unresolved execPath is a symlink inside <prefix>/bin/ that
		// ultimately resolves to somewhere under the same prefix.
		const binDir = join(prefix, "bin")
		if (process.execPath.startsWith(`${binDir}${sep}`) && realExec.startsWith(`${realPrefix}${sep}`)) {
			return true
		}
	}
	return false
}

// platform-aware path separator constant (avoids importing `sep` from path
// in the fragment above while keeping things readable).
const sep = "/"

/**
 * Data directory for supporting files (share/kimchi contents), honoring
 * XDG_DATA_HOME on Linux. Falls back to ~/.local/share/kimchi.
 */
export function resolveDataDir(): string {
	const xdg = process.env.XDG_DATA_HOME
	if (xdg && xdg.length > 0) return join(xdg, APP_DIR)
	return join(homedir(), ".local", "share", APP_DIR)
}
