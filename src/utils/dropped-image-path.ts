import { homedir } from "node:os"
import { extname, resolve } from "node:path"
import { IMAGE_EXT_TO_MIME, readImageFileFromDisk } from "./image-utils.js"

/**
 * Recognize a file drop in the prompt editor.
 *
 * Terminals deliver drag-and-drop of a file as a bracketed paste containing
 * the file path — plain (`/tmp/cat.png`), quoted (`"/tmp/my cat.png"`), or
 * shell-escaped (`/tmp/my\ cat.png`, iTerm2 default). This module classifies
 * such a paste payload as a single local image file so the caller can replace
 * the raw path display with an inline `[Image #N]` marker. It is deliberately
 * strict: only a single-token, single-line payload qualifies, and the file
 * must actually be a readable image (same guard as typed paths) — anything
 * else returns null and the paste falls through to normal text insertion.
 */

export interface DroppedImageMatch {
	/** Absolute path after `~` expansion and cwd resolution. */
	resolvedPath: string
	image: { bytes: Uint8Array; mimeType: string }
}

// A fully quoted span — double, single, or backtick. Content must contain no
// newline; inner text is used verbatim (quotes make spaces legal).
const QUOTED_RE = /^(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`)$/s

function expandHome(raw: string): string {
	if (raw === "~") return process.env.HOME || homedir()
	if (raw.startsWith("~/")) return `${process.env.HOME || homedir()}${raw.slice(1)}`
	return raw
}

/**
 * Unescape shell-style escapes (`\ `, `\(`, `\'`, …) and reject unescaped
 * whitespace. Only backslash before a NON-alphanumeric is consumed, so
 * Windows-style paths (`C:\dir\img.png`, backslash before alphanumeric) keep
 * their separators intact. Returns null when the payload is not a single
 * whitespace-free token (after unescaping).
 */
function unescapeShellPath(raw: string): string | null {
	let out = ""
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i]
		if (c === "\\" && i + 1 < raw.length) {
			const next = raw[i + 1]
			if (/[a-zA-Z0-9]/.test(next)) {
				// Keep both characters — likely a Windows path separator.
				out += c + next
			} else {
				out += next
			}
			i++
			continue
		}
		// Unescaped whitespace means multiple tokens — not a single drop.
		if (/\s/.test(c)) return null
		out += c
	}
	return out
}

/**
 * Classify a bracketed-paste payload as a dropped local image file.
 * Multi-line or multi-token payloads, URLs, non-image extensions, and
 * unreadable/oversized files all return null.
 */
export function droppedImagePathCandidate(pastedText: string, cwd = process.cwd()): DroppedImageMatch | null {
	const trimmed = pastedText.trim()
	if (!trimmed || trimmed.includes("\n")) return null

	const quoted = trimmed.match(QUOTED_RE)
	let candidate: string | null
	if (quoted) {
		// Quoted drops may contain spaces — the inner text is the path verbatim.
		candidate = (quoted[1] ?? quoted[2] ?? quoted[3]).trim()
	} else {
		candidate = unescapeShellPath(trimmed)
	}
	if (!candidate || candidate.includes("://")) return null
	if (!IMAGE_EXT_TO_MIME[extname(candidate).toLowerCase()]) return null

	const resolvedPath = resolve(cwd, expandHome(candidate))
	const image = readImageFileFromDisk(resolvedPath)
	return image ? { resolvedPath, image } : null
}
