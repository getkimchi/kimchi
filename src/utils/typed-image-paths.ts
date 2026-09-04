import { homedir } from "node:os"
import { extname, resolve } from "node:path"
import { IMAGE_EXT_TO_MIME, readImageFileFromDisk } from "./image-utils.js"

/**
 * Extract image file paths the user typed directly into the prompt editor.
 *
 * Pasted images are attached to the user turn by the clipboard-image
 * extension, but a typed path ("/Users/jose/Downloads/A-Cat.jpg") arrives as
 * plain text. This module finds those typed paths so the same extension can
 * attach them as images, giving typed paths paste parity. It is deliberately
 * conservative: a token only becomes a match when `readImageFileFromDisk`
 * accepts it (exists, readable, supported extension, within the size cap) —
 * prose tokens that merely look like paths are silently ignored.
 */

export interface TypedImagePathMatch {
	/** Candidate path as written (quotes and prose punctuation stripped). */
	rawPath: string
	/** Absolute path after `~` expansion and cwd resolution. */
	resolvedPath: string
	/** Guard result from readImageFileFromDisk — the file is read exactly once here. */
	image: { bytes: Uint8Array; mimeType: string }
}

// Quoted spans (double, single, backtick) are single tokens so paths with
// spaces and inline code spans attach; everything else is whitespace-split
// (\s covers \r, so CRLF line breaks need no special handling).
const TOKEN_RE = /"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|(\S+)/g

// Prose punctuation clinging to the edges of a typed path in chat text.
const LEADING_JUNK_RE = /^[([{<'"`]+/
const TRAILING_JUNK_RE = /[.,;:!?)\]}>'"`]+$/

interface Token {
	raw: string
	quoted: boolean
}

function tokenize(text: string): Token[] {
	const tokens: Token[] = []
	for (const m of text.matchAll(TOKEN_RE)) {
		const quoted = m[1] ?? m[2] ?? m[3]
		if (quoted !== undefined) tokens.push({ raw: quoted, quoted: true })
		else if (m[4] !== undefined) tokens.push({ raw: m[4], quoted: false })
	}
	return tokens
}

/**
 * Reduce a token to a viable local image path candidate, or null. No disk
 * access here — the regex/extension filters exist only to keep the subsequent
 * filesystem guard (readImageFileFromDisk) rare and predictable.
 */
function toCandidate(token: Token): string | null {
	const raw = token.quoted ? token.raw.trim() : token.raw.replace(LEADING_JUNK_RE, "").replace(TRAILING_JUNK_RE, "")
	if (!raw) return null
	// URLs and file:// URIs are never local attachments.
	if (raw.includes("://")) return null
	if (!IMAGE_EXT_TO_MIME[extname(raw).toLowerCase()]) return null
	return raw
}

function expandHome(raw: string): string {
	if (raw === "~") return process.env.HOME || homedir()
	if (raw.startsWith("~/")) return `${process.env.HOME || homedir()}${raw.slice(1)}`
	return raw
}

/**
 * Scan `text` for typed local image paths. Returns matches in first-appearance
 * order, deduped by resolved absolute path. Missing/unreadable files are
 * skipped silently — callers leave the text untouched so the model can still
 * fall back to the `read` tool, which reports errors loudly.
 */
export function extractTypedImagePaths(text: string, cwd: string): TypedImagePathMatch[] {
	const seen = new Set<string>()
	const matches: TypedImagePathMatch[] = []
	for (const token of tokenize(text)) {
		const raw = toCandidate(token)
		if (!raw) continue
		const resolvedPath = resolve(cwd, expandHome(raw))
		if (seen.has(resolvedPath)) continue
		const image = readImageFileFromDisk(resolvedPath)
		if (!image) continue
		seen.add(resolvedPath)
		matches.push({ rawPath: raw, resolvedPath, image })
	}
	return matches
}
