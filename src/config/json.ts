import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

/**
 * The `.jsonc` sibling tried when a `.json` path is absent. Single source of
 * truth for the fallback rule: readJson reads the sibling as a content
 * fallback, and readJsonCached stats it as the cache's alternative source.
 * If the fallback set ever changes, both paths must change together.
 */
function jsoncSibling(path: string): string | undefined {
	return path.endsWith(".json") ? `${path}c` : undefined
}

/**
 * Read a JSON file, returning {} if it does not exist. Tolerates JSONC-style
 * comments because some tools (OpenCode, get-shit-done-cc) write `.jsonc`
 * files with `//` and block comments. If `path` ends with `.json` and is
 * absent, the sibling `.jsonc` file is tried before giving up.
 *
 * Throws on parse errors so corrupt configs are visible — silent recovery
 * would let us overwrite a user's malformed file with our defaults.
 */
export function readJson(path: string): Record<string, unknown> {
	let raw: string
	try {
		raw = readFileSync(path, "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
		const sibling = jsoncSibling(path)
		if (sibling) {
			try {
				raw = readFileSync(sibling, "utf-8")
			} catch (err2) {
				if ((err2 as NodeJS.ErrnoException).code === "ENOENT") return {}
				throw err2
			}
		} else {
			return {}
		}
	}

	const stripped = stripJsoncComments(raw)
	if (stripped.trim() === "") return {}
	const parsed = JSON.parse(stripped)
	// `null` parses to null, not {}. Normalise so callers can always
	// `obj[key] = …` without a nil check.
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {}
	}
	return parsed as Record<string, unknown>
}

export async function readJsonAsync(path: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		try {
			const data = readJson(path)
			resolve(data)
		} catch (err) {
			reject(err)
		}
	})
}

// ─── Stat-gated read cache ─────────────────────────────────────────────────
//
// Hot config readers (harness settings.json, tags.json, resource overrides)
// used to re-read and re-parse the same files on every event — every bash
// tool_call, every status-line render. readJsonCached turns each of those
// into a single statSync: the parsed value is cached per resolved path and
// re-read only when the file's mtime/size signature changes (the same scheme
// settings-watcher.ts uses to gate its rebuilds). Correctness does not depend
// on write-through: any writer — including another process — changes mtime,
// so the next read re-stats and re-reads. writeJson still drops its own path
// from the cache as belt-and-braces.
//
// The returned object is SHARED between callers and must be treated as
// read-only. Read-modify-write callers use readJson directly, both to avoid
// mutating the shared value and because they are about to write anyway.

interface CachedJsonEntry {
	/** The file the value was actually read from (undefined = no file existed). */
	sourcePath: string | undefined
	/** mtime:size signature of sourcePath at read time (undefined = missing). */
	signature: string | undefined
	value: Record<string, unknown>
}

const jsonReadCache = new Map<string, CachedJsonEntry>()

/** mtime+size signature of a file, or undefined when it cannot be stat'ed.
 *  Two observations with the same signature are treated as "unchanged". */
export function fileSignature(path: string): string | undefined {
	try {
		const st = statSync(path)
		return `${st.mtimeMs}:${st.size}`
	} catch {
		return undefined
	}
}

function cachedRead(key: string, sourcePath: string, signature: string): Record<string, unknown> {
	const entry = jsonReadCache.get(key)
	if (entry && entry.sourcePath === sourcePath && entry.signature === signature) return entry.value
	const value = readJson(sourcePath)
	jsonReadCache.set(key, { sourcePath, signature, value })
	return value
}

/**
 * Read a JSON file through the stat-gated cache — same semantics and
 * tolerance as readJson (JSONC comments, `.jsonc` sibling fallback, throws on
 * malformed JSON), but the parsed value is only re-read from disk when the
 * file's mtime/size signature changes. A missing primary `.json` with an
 * existing `.jsonc` sibling caches that sibling's value; "both missing"
 * caches the {} miss, so a later stat success (file created) invalidates.
 *
 * The returned object is shared between callers — treat it as read-only.
 * Parse errors are never cached: they propagate, and the next call re-reads.
 */
export function readJsonCached(path: string): Record<string, unknown> {
	const key = resolve(path)
	const primary = fileSignature(path)
	if (primary !== undefined) return cachedRead(key, path, primary)
	// Same fallback rule as readJson — see jsoncSibling.
	const alt = jsoncSibling(path)
	if (alt) {
		const altSig = fileSignature(alt)
		if (altSig !== undefined) return cachedRead(key, alt, altSig)
	}
	const entry = jsonReadCache.get(key)
	if (entry && entry.sourcePath === undefined) return entry.value
	// Returns {} when nothing exists; may throw on real I/O errors, which we
	// deliberately do not cache.
	const value = readJson(path)
	jsonReadCache.set(key, { sourcePath: undefined, signature: undefined, value })
	return value
}

/** Drop the cached value for the (primary) path callers read through.
 *  @internal write-through + test hook. */
export function invalidateJsonCache(path: string): void {
	jsonReadCache.delete(resolve(path))
}

/** @internal Test-only: clear the entire read cache so tests get clean state. */
export function __resetJsonCacheForTest(): void {
	jsonReadCache.clear()
}

/**
 * Atomically write a JSON file with 2-space indentation. Creates parent
 * directories.
 */
export function writeJson(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true })
	const content = `${JSON.stringify(data, null, 2)}\n`
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, content, { mode: 0o600 })
	renameSync(tmp, path)
	// Belt-and-braces on top of the stat gate: our own writes never serve a
	// stale cached value even if mtime granularity were to miss the change.
	jsonReadCache.delete(resolve(path))
}

export async function writeJsonAsync(path: string, data: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			// Delegates to writeJson, so it inherits writeJson's cache
			// invalidation — no separate write-through needed here.
			writeJson(path, data)
			resolve()
		} catch (err) {
			reject(err)
		}
	})
}

/** Atomic raw write, used by the OpenClaw .env writer. */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, data, { mode: 0o600 })
	renameSync(tmp, path)
}

/**
 * Strip `//` line comments and `/* … *\/` block comments from JSON-with-comments
 * input. String literals (and their escape sequences) are left untouched, so a
 * URL inside `"https://..."` doesn't get truncated by the line-comment scanner.
 */
function stripJsoncComments(input: string): string {
	const out: string[] = []
	let inString = false
	let i = 0
	while (i < input.length) {
		const c = input[i]
		if (inString) {
			out.push(c)
			if (c === "\\" && i + 1 < input.length) {
				out.push(input[i + 1])
				i += 2
				continue
			}
			if (c === '"') inString = false
			i++
			continue
		}
		if (c === '"') {
			inString = true
			out.push(c)
			i++
			continue
		}
		if (c === "/" && i + 1 < input.length) {
			const next = input[i + 1]
			if (next === "/") {
				i += 2
				while (i < input.length && input[i] !== "\n") i++
				continue
			}
			if (next === "*") {
				i += 2
				while (i + 1 < input.length) {
					if (input[i] === "*" && input[i + 1] === "/") {
						i += 2
						break
					}
					i++
				}
				continue
			}
		}
		out.push(c)
		i++
	}
	return out.join("")
}
