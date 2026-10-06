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
 *
 * Paths containing spaces (e.g. macOS screenshots: "Screenshot 2026-10-05 at
 * 14.32.10.png") arrive from terminal drag-and-drop in three shapes: quoted
 * spans, literal spaces, and shell-escaped spaces (`Screenshot\ 2026-...`).
 * All three attach: quoted spans are single tokens; a backslash-escaped
 * space stays inside the token and is unescaped for the disk check; literal
 * spaces are recovered by greedily re-joining a failed extension-bearing
 * token with the unquoted tokens before it. Every recovered candidate still
 * has to pass `readImageFileFromDisk`, so prose never attaches by accident.
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
// spaces and inline code spans attach; an unquoted span keeps `\ ` (the shell
// escape for a space that terminal drags produce) inside the token instead of
// splitting on it. The glue is deliberately space-only: a backslash before a
// newline or tab must NOT merge lines, or a trailing `\` on a pasted shell
// line-continuation would swallow the next line and break its quoted spans.
// Everything else is whitespace-split (\s covers \r, so CRLF line breaks need
// no special handling).
const TOKEN_RE = /("(?:[^"\n]+)"|'(?:[^'\n]+)'|`(?:[^`\n]+)`)|((?:\\ |\S)+)/g

// Prose punctuation clinging to the edges of a typed path in chat text.
const LEADING_JUNK_RE = /^[([{<'"`]+/
const TRAILING_JUNK_RE = /[.,;:!?)\]}>'"`]+$/

// Shell-style space escape from terminal drags of paths with spaces. Only
// unquoted tokens are unescaped: a quoted span may legitimately contain a
// literal backslash (APFS allows it in filenames) and quoted paths are exact.
const SHELL_SPACE_ESCAPE_RE = /\\( )/g

// How many preceding unquoted tokens may be joined to recover a path with
// literal (unescaped) spaces. "Screenshot 2026-10-05 at 16.51.59.png" needs
// four parts; the bound is generous headroom for longer capture names.
// Joins re-assemble with single spaces, so names containing consecutive
// spaces are not recovered — quoted or escaped shapes handle those exactly.
const MAX_JOIN_TOKENS = 8

interface Token {
	raw: string
	quoted: boolean
}

function tokenize(text: string): Token[] {
	const tokens: Token[] = []
	for (const m of text.matchAll(TOKEN_RE)) {
		if (m[1] !== undefined) tokens.push({ raw: m[1].slice(1, -1), quoted: true })
		else tokens.push({ raw: m[2], quoted: false })
	}
	return tokens
}

/**
 * Clean an unquoted token part: strip clinging prose punctuation and turn
 * shell-escaped spaces back into literal spaces. Returns the cleaned text.
 */
function cleanUnquotedPart(raw: string): string {
	return raw.replace(LEADING_JUNK_RE, "").replace(TRAILING_JUNK_RE, "").replace(SHELL_SPACE_ESCAPE_RE, "$1")
}

/**
 * Candidate path strings for the token at `index`, most precise first.
 *
 * Quoted tokens yield a single exact candidate. Unquoted tokens yield the
 * token itself first (preserving existing relative/absolute resolution), then
 * the token joined with preceding unquoted tokens, nearest first — so a path
 * whose spaces were split apart ("Screenshot 2026-10-05 at 14.32.10.png") is
 * rebuilt from the extension-bearing token outward. Joins stop at a quoted
 * span (a quoted boundary means the unquoted text is not one path) and are
 * bounded by MAX_JOIN_TOKENS.
 */
function candidatesForToken(tokens: Token[], index: number): string[] {
	const token = tokens[index]
	if (token.quoted) return [token.raw.trim()]
	const out = [cleanUnquotedPart(token.raw)]
	let joined = out[0]
	for (let j = index - 1; j >= 0 && index - j <= MAX_JOIN_TOKENS; j--) {
		if (tokens[j].quoted) break
		joined = `${cleanUnquotedPart(tokens[j].raw)} ${joined}`
		out.push(joined)
	}
	return out
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
	const tokens = tokenize(text)

	for (let i = 0; i < tokens.length; i++) {
		for (const raw of candidatesForToken(tokens, i)) {
			// URLs and file:// URIs are never local attachments.
			if (raw.includes("://")) continue
			if (!IMAGE_EXT_TO_MIME[extname(raw).toLowerCase()]) continue
			const resolvedPath = resolve(cwd, expandHome(raw))
			if (seen.has(resolvedPath)) continue
			const image = readImageFileFromDisk(resolvedPath)
			if (!image) continue
			seen.add(resolvedPath)
			matches.push({ rawPath: raw, resolvedPath, image })
			break
		}
	}
	return matches
}
