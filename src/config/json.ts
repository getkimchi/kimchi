import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

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
		if (path.endsWith(".json")) {
			try {
				raw = readFileSync(`${path}c`, "utf-8")
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
