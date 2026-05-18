// Resolves attachment paths the same way pi's @file loader does, so kimchi accepts anything pi would accept.
// Ported from pi-mono: packages/coding-agent/src/core/tools/path-utils.ts — keep in sync manually if pi's rules evolve.
// The macOS-specific variants below exist because typing a screenshot's filename rarely produces the exact bytes the filesystem stored; see findExistingFile.

import { statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"

// Non-ASCII whitespace code points the OS / clipboard / browser sometimes substitute for a plain space: NBSP (U+00A0), the U+2000–U+200A span, NNBSP (U+202F), MMSP (U+205F), and the ideographic space (U+3000). We flatten them to " " before comparing against the filesystem. Escape sequences used deliberately: literal invisibles would get silently rewritten by formatters (biome in particular reads a run of spaces as "consecutive whitespace" and collapses the character class) and tests would pass as tautologies.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
// U+202F — the space macOS puts between the time and AM/PM in default screenshot names. Users type a normal space, so we try substituting one for the other.
const NARROW_NO_BREAK_SPACE = "\u202F"
// U+2019 — the curly apostrophe macOS uses in localized screenshot names like "Capture d'écran". Users type U+0027.
const CURLY_APOSTROPHE = "\u2019"

function normalizeUnicodeSpaces(s: string): string {
	return s.replace(UNICODE_SPACES, " ")
}

// Strip one leading "@" so callers that forget the docs (or LLMs that mimic pi's @file syntax) don't silently get "@@file" passed further down.
export function stripAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath
}

// Turn a user-facing path into a plain path: drop the optional @, flatten exotic whitespace, expand `~` and `~/…`. Does NOT resolve relative paths — see resolveUserPath.
export function expandUserPath(filePath: string): string {
	const n = normalizeUnicodeSpaces(stripAtPrefix(filePath))
	if (n === "~") return homedir()
	if (n.startsWith("~/")) return homedir() + n.slice(1)
	return n
}

// Full resolution to an absolute path: expansion + cwd-join for relative inputs. Still not a filesystem check — the file may or may not exist.
export function resolveUserPath(filePath: string, cwd: string): string {
	const expanded = expandUserPath(filePath)
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

// Files only — a directory at the path is NOT a hit. This is the one intentional divergence from pi's resolveReadPath (which uses F_OK and thus accepts directories).
// Verified against pi-coding-agent@0.67.68: passing a directory in @attachments reaches detectSupportedImageMimeTypeFromFile, whose read() throws EISDIR. Rejecting dirs up front turns that into a clean pre-spawn "file not found" error.
function isFile(p: string): boolean {
	try {
		return statSync(p).isFile()
	} catch {
		return false
	}
}

// Ordered set of transforms tried against the resolved absolute path. Each row is: "if the literal string didn't match, maybe it was typed one of these ways instead". Order matters: cheaper + more common substitutions first.
// Single-axis only — variants are applied independently to the base, not cross-producted. Filenames that need multiple substitutions (e.g. NFD + curly apostrophe) must be listed as explicit combined entries (variant 5). This is a deliberate trade-off to keep the fallback ladder bounded.
//   1. identity — the path as typed
//   2. " AM." / " PM." → NNBSP variant (macOS screenshot default naming)
//   3. NFD — macOS HFS+/APFS filesystems return filenames decomposed; an NFC-normalized string from the clipboard won't byte-match
//   4. straight apostrophe → curly apostrophe
//   5. NFD + curly — the combo needed for French macOS screenshots ("Capture d'écran")
const VARIANTS: ReadonlyArray<(p: string) => string> = [
	(p) => p,
	(p) => p.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
	(p) => p.normalize("NFD"),
	(p) => p.replace(/'/g, CURLY_APOSTROPHE),
	(p) => p.normalize("NFD").replace(/'/g, CURLY_APOSTROPHE),
]

// Walk the VARIANTS list and return the absolute path of the first existing regular file, or null if none matches. Pi runs its own resolveReadPath on the argv it receives — we return the variant that already exists on disk so pi's identity attempt hits immediately instead of walking its own fallback chain.
export function findExistingFile(
	filePath: string,
	cwd: string,
	exists: (abs: string) => boolean = isFile,
): string | null {
	const base = resolveUserPath(filePath, cwd)
	for (const variant of VARIANTS) {
		const candidate = variant(base)
		if (exists(candidate)) return candidate
	}
	return null
}
