import { existsSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, normalize, win32 } from "node:path"
import { envCacheDir, readResolvedKimchiEnv } from "../env-root.js"

const APP_DIR = "kimchi"

/** The filename a packaged kimchi binary must carry, per platform. */
export function packagedBinaryName(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "kimchi.exe" : "kimchi"
}

/** True when the executable path names the packaged kimchi binary. Used by
 *  the launch path and the background-update gate alike: an install would
 *  overwrite the interpreter in `pnpm dev` or any other renamed binary.
 *  The basename is platform-aware so the check is testable from any host. */
export function isPackagedBinaryExecPath(execPath: string, platform: NodeJS.Platform = process.platform): boolean {
	const base = platform === "win32" ? win32.basename(execPath) : basename(execPath)
	return base === packagedBinaryName(platform)
}

/**
 * Cache base, honoring XDG_CACHE_HOME on Linux. Used as the parent of
 * state.json and any backup files.
 */
export function cacheDir(): string {
	const xdg = process.env.XDG_CACHE_HOME
	if (xdg && xdg.length > 0) return xdg
	return join(homedir(), ".cache")
}

/**
 * The kimchi cache tree for the active harness environment: the legacy
 * default keeps ~/.cache/kimchi, env trees under envs/ keep theirs under
 * ~/.cache/kimchi/envs/<name>/ (see src/env-root.ts). Falls back to the
 * legacy location when entry.ts hasn't resolved an env (standalone imports,
 * tests) so path shapes are unchanged outside the harness startup flow.
 */
function kimchiCacheDir(): string {
	try {
		return envCacheDir(readResolvedKimchiEnv())
	} catch {
		return join(cacheDir(), APP_DIR)
	}
}

/** State file path: <env cache>/state.json. Holds only the per-repo check
 *  cache; update diagnostics keep their own files below so the cache's
 *  unlock-and-save races can't clobber them. */
export function statePath(): string {
	return join(kimchiCacheDir(), "state.json")
}

/** The update result file: <env cache>/update-result.json. */
export function updateResultPath(): string {
	return join(kimchiCacheDir(), "update-result.json")
}

/** The last-installed tag file: <env cache>/last-installed.json. */
export function lastInstalledPath(): string {
	return join(kimchiCacheDir(), "last-installed.json")
}

/** Backups dir: ~/.cache/kimchi/backups/. Created on demand by the installer. */
export function backupDir(): string {
	return join(kimchiCacheDir(), "backups")
}

/**
 * The per-env binary path: `<envRoot>/bin/kimchi` for envs that own their
 * state tree under envs/, where the binary's sibling share files
 * (`<envRoot>/share/kimchi`) follow the standard layout. Undefined for the
 * legacy default env (which keeps updating the global executable in place)
 * and when no env has been resolved (standalone imports, tests).
 */
export function envBinaryPath(): string | undefined {
	let resolved: ReturnType<typeof readResolvedKimchiEnv>
	try {
		resolved = readResolvedKimchiEnv()
	} catch {
		return undefined
	}
	if (resolved.legacyDefault) return undefined
	return join(resolved.root, "bin", packagedBinaryName())
}

/**
 * Where an update installs the binary: an explicit override, else the active
 * env's own binary (non-legacy envs), else the running executable in place
 * (today's behavior — the legacy default and standalone use).
 */
export function installTargetPath(executablePath?: string): string {
	return executablePath ?? envBinaryPath() ?? resolveExecutablePath()
}

/**
 * Re-exec decision, pure: the binary to delegate to when the active env owns
 * a kimchi binary that is not the one already running. Undefined when there
 * is no env binary, it does not exist, or the running process IS it (same
 * file, symlinks resolved — this is the loop guard). A missing/broken execPath
 * also yields undefined: never delegate from an unidentifiable process.
 */
export function reExecTarget(execPath: string, envBinary: string | undefined): string | undefined {
	if (!envBinary) return undefined
	let realEnvBinary: string
	try {
		realEnvBinary = realpathSync(envBinary)
	} catch {
		return undefined
	}
	// Trust model: the env tree is user-writable state (the bash tool, skills,
	// and MCP filesystem tools all write into it), so a compromised session
	// could plant a binary at <envRoot>/bin/kimchi that every later
	// `kimchi --env <name>` would silently execute. Delegate only to a binary
	// owned by this user and not group/world-writable — a plant by another
	// local user fails closed to the running (globally installed) binary.
	// Same-user writes are equivalent-privilege to replacing ~/.local/bin/kimchi
	// itself, so no stronger integrity check is claimed. Documented in
	// docs/environments.md.
	try {
		const st = statSync(realEnvBinary)
		const uid = process.getuid?.()
		if (uid !== undefined && st.uid !== uid) return undefined
		if (st.mode & 0o022) return undefined
	} catch {
		return undefined
	}
	let realExec: string
	try {
		realExec = realpathSync(execPath)
	} catch {
		return undefined
	}
	// Return the RESOLVED path — spawn exactly what was stat'ed, so a
	// symlink swap between the guard checks and the exec cannot redirect.
	return realExec === realEnvBinary ? undefined : realEnvBinary
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
 * Detection: the real path of the binary (symlinks resolved) lives inside
 * `<prefix>/Cellar/` for some known Homebrew prefix. Homebrew always
 * stores versioned copies in Cellar and symlinks `<prefix>/bin/<name>` to
 * them, so following the symlink with `realpathSync` and checking for a
 * Cellar sub-path is both necessary and sufficient.
 *
 * Returns false on Windows and when no Cellar directory exists under any
 * candidate prefix (rules out a bare `/opt/homebrew` or `/usr/local`
 * prefix that was never a real Homebrew installation).
 */
export function isHomebrewInstall(): boolean {
	return homebrewKeg() !== undefined
}

/**
 * A path to the running binary that survives upgrades, for links such as the
 * work-reporting plugins' runtime. `brew upgrade` removes the old Cellar
 * version, so a link to the real path breaks; `<prefix>/opt/<formula>` always
 * names the installed version. Other installs replace the binary in place.
 */
export function stableExecutablePath(): string {
	const keg = homebrewKeg()
	if (!keg) return process.execPath
	// <Cellar>/<formula>/<version>/<path inside the keg>
	const [formula, , ...inside] = keg.realExec.slice(keg.cellar.length + 1).split(sep)
	const opt = join(keg.prefix, "opt", formula, ...inside)
	return existsSync(opt) ? opt : process.execPath
}

type HomebrewKeg = { prefix: string; cellar: string; realExec: string }

let cachedHomebrewKeg: HomebrewKeg | undefined
let homebrewKegCachePopulated = false

/** The executable and Homebrew layout are process-lifetime facts. Cache both
 *  outcomes, including probe failures, rather than repeatedly blocking on
 *  realpath; only tests replace these facts and use the reset hook below. */
function homebrewKeg(): HomebrewKeg | undefined {
	if (homebrewKegCachePopulated) return cachedHomebrewKeg
	const keg = probeHomebrewKeg()
	cachedHomebrewKeg = keg
	homebrewKegCachePopulated = true
	return keg
}

/** Reset the process-lifetime probe result after replacing the test process layout. */
export function resetHomebrewKegCacheForTests(): void {
	cachedHomebrewKeg = undefined
	homebrewKegCachePopulated = false
}

function probeHomebrewKeg(): HomebrewKeg | undefined {
	if (process.platform === "win32") return undefined

	let realExec: string
	try {
		realExec = realpathSync(process.execPath)
	} catch {
		return undefined
	}

	for (const prefix of homebrewPrefixes()) {
		const cellar = join(prefix, "Cellar")
		if (!existsSync(cellar)) continue

		// Resolve the cellar path itself so that macOS's /var → /private/var
		// symlink (and similar) doesn't cause a startsWith mismatch against
		// the already-resolved realExec.
		let realCellar: string
		try {
			realCellar = realpathSync(cellar)
		} catch {
			continue
		}

		if (realExec.startsWith(`${realCellar}${sep}`)) return { prefix, cellar: realCellar, realExec }
	}
	return undefined
}

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
