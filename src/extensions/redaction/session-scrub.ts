import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { redact } from "./engine.js"

interface SessionEntry {
	type?: string
	message?: {
		role?: string
		content?: unknown[]
	}
}

/**
 * Scrub secrets from a session file at rest.
 *
 * Reads the JSONL session file, parses each line, scrubs string values
 * in tool-call args and text content using the redaction engine, then
 * writes back atomically (temp file + rename).
 *
 * Never throws — returns silently on any error.
 *
 * Note: Atomicity via rename is guaranteed on POSIX systems. On Windows,
 * rename may fail if the target file is open by another process — this is
 * best-effort for cross-platform compatibility.
 *
 * @param sessionFilePath - Path to the JSONL session file.
 * @param knownSecrets - Set of known secret values to redact.
 */
export function scrubSessionFile(sessionFilePath: string, knownSecrets: Set<string>): void {
	let raw: string
	try {
		raw = readFileSync(sessionFilePath, "utf-8")
	} catch {
		return
	}

	if (!raw.trim()) return

	// Split on \r?\n to handle both LF and CRLF line endings.
	// Write back with normalized LF.
	const lines = raw.split(/\r?\n/)
	let modified = false
	const outputLines: string[] = []

	for (const line of lines) {
		if (!line.trim()) {
			outputLines.push(line)
			continue
		}

		let entry: SessionEntry
		try {
			entry = JSON.parse(line)
		} catch {
			// Malformed JSON — pass through unchanged
			outputLines.push(line)
			continue
		}

		const lineModified = scrubEntry(entry, knownSecrets)
		outputLines.push(lineModified ? JSON.stringify(entry) : line)
		if (lineModified) modified = true
	}

	if (!modified) return

	// Atomic write (POSIX): temp file + rename. Clean up temp file on failure.
	const tmpPath = `${sessionFilePath}.tmp`
	try {
		writeFileSync(tmpPath, `${outputLines.join("\n")}\n`, "utf-8")
		renameSync(tmpPath, sessionFilePath)
	} catch {
		// Best-effort cleanup of the temp file if write/rename failed.
		try {
			unlinkSync(tmpPath)
		} catch {
			// Temp file may not exist — ignore.
		}
	}
}

/**
 * Scrub a single session entry in place.
 * Returns true if any value was modified.
 */
function scrubEntry(entry: SessionEntry, knownSecrets: Set<string>): boolean {
	let modified = false

	if (!entry.message || !Array.isArray(entry.message.content)) return false

	for (const block of entry.message.content) {
		if (typeof block !== "object" || block === null) continue
		const b = block as Record<string, unknown>

		// Scrub tool-call args (assistant messages)
		if (b.type === "toolCall" && b.arguments && typeof b.arguments === "object") {
			const args = b.arguments as Record<string, unknown>
			for (const [key, value] of Object.entries(args)) {
				if (typeof value === "string") {
					const redacted = redact(value, knownSecrets)
					if (redacted !== value) {
						args[key] = redacted
						modified = true
					}
				}
			}
		}

		// Scrub text content (toolResult messages)
		if (b.type === "text" && typeof b.text === "string") {
			const redacted = redact(b.text, knownSecrets)
			if (redacted !== b.text) {
				b.text = redacted
				modified = true
			}
		}
	}

	return modified
}
