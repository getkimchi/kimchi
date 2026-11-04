// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

/**
 * Locate a binary by name. PATH first, then a few well-known fallback dirs
 * so tools installed outside the user's PATH (npm global, nvm, ~/.local,
 * ~/.{name}/bin) are still discovered. Returns undefined if nothing
 * resolves — callers that need a binary (the launchers) translate
 * undefined into a user-friendly "not installed" message themselves.
 */
export function findBinary(name: string): string | undefined {
	const fromPath = lookPath(name)
	if (fromPath) return fromPath

	const home = safeHomedir()
	if (!home) return undefined

	const candidates: string[] = [join(home, `.${name}`, "bin", name), join(home, ".local", "bin", name)]

	const nvmDir = join(home, ".nvm", "versions", "node")
	try {
		const entries = readdirSync(nvmDir)
		// Walk newest first so the most recent node version wins.
		for (let i = entries.length - 1; i >= 0; i--) {
			candidates.push(join(nvmDir, entries[i], "bin", name))
		}
	} catch {
		// nvm not installed
	}

	for (const candidate of candidates) {
		if (isExecutableFile(candidate)) return candidate
	}
	return undefined
}

/**
 * Return a function that probes for `name` on PATH. Used by tool
 * registrations as the `isInstalled` callback.
 */
export function detectBinaryFactory(name: string): () => boolean {
	return () => findBinary(name) !== undefined
}

function lookPath(name: string): string | undefined {
	const pathEnv = process.env.PATH ?? ""
	if (!pathEnv) return undefined
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""]
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue
		for (const ext of exts) {
			const candidate = join(dir, name + ext)
			if (isExecutableFile(candidate)) return candidate
		}
	}
	return undefined
}

function isExecutableFile(path: string): boolean {
	try {
		const st = statSync(path)
		if (st.isDirectory()) return false
		// On Windows, mode bits are not reliable — existence is enough.
		if (process.platform === "win32") return true
		return (st.mode & 0o111) !== 0
	} catch {
		return false
	}
}

function safeHomedir(): string | undefined {
	try {
		return homedir()
	} catch {
		return undefined
	}
}

/** True when the directory `path` exists. Useful for directory-shaped probes (e.g. ~/.openclaw, /Applications/Cursor.app). */
export function dirExists(path: string): boolean {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
}

/** True when `path` exists at all (file, dir, symlink, etc.). */
export function pathExists(path: string): boolean {
	return existsSync(path)
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
