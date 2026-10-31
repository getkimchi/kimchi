/**
 * Document intake: binary documents never reach the model as decoded UTF-8
 * garbage. Upstream `read` and the @file pipeline special-case images only —
 * every other file is decoded as UTF-8, so a PDF becomes tens of KB of
 * mojibake and `kimchi @deck.pptx …` inlines the whole file into the first
 * prompt with no size cap (measured 2026-10-30: a 924 KB PDF produced an
 * 883,221-char prompt).
 *
 * Two seams, one concern:
 *  - `read` on a binary pdf/docx/xlsx/pptx file is blocked; the reason names
 *    the bundled skill command that reads the file properly.
 *  - The `input` transform replaces an @file block that still byte-matches
 *    its file's UTF-8 decode — exactly what upstream inlined for that path —
 *    with a one-line stub. Within the size cap, user-typed look-alikes never
 *    match; over the cap, the magic + length checks alone justify the stub.
 *    The stub keeps the file name, so prompt-triggered skill auto-load still
 *    fires.
 *
 * Applies in every permission mode (yolo included): this is about correct
 * output, not permission — hence its own extension, not a branch in the
 * permissions gate. Both seams do bounded work only (an 8-byte head read;
 * stat + head read + a length precheck before any full re-read), because the
 * input path runs per prompt on untrusted text naming arbitrary paths.
 */

import { open, readFile, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { findExistingFile } from "../../fs-paths.js"
import { hasMagic, PDF_MAGIC, pathExtension, ZIP_MAGICS } from "./detect.js"
import { DOC_SKILL_EXTENSIONS, type DocCliSkill } from "./doc-cli-skills.js"
import { maxFileBytes } from "./limits.js"

/** True when `data` starts with the skill's container magic. A zip head does
 *  not prove the OOXML subtype (any .zip renamed .docx passes), but such a
 *  file is binary either way: the skill's typed "not a docx" error still
 *  beats raw bytes. */
function isBinaryOfSkill(data: Uint8Array, skill: DocCliSkill): boolean {
	return skill === "pdf" ? hasMagic(data, PDF_MAGIC) : ZIP_MAGICS.some((m) => hasMagic(data, m))
}

/** The bundled skill that reads this path's format, if any. */
export function docSkillForPath(path: string): DocCliSkill | undefined {
	return DOC_SKILL_EXTENSIONS[pathExtension(path)]
}

/** First bytes of the file; empty on any error (missing, unreadable) so the
 *  guard fails open and `read` reports the underlying error itself. */
async function readHead(absPath: string): Promise<Buffer> {
	try {
		const handle = await open(absPath, "r")
		try {
			const head = Buffer.alloc(8)
			const { bytesRead } = await handle.read(head, 0, head.length, 0)
			return head.subarray(0, bytesRead)
		} finally {
			// A close failure (NFS/EINTR-class) must not discard a successful
			// head read — that would fail the guard open on exactly the files
			// it exists to block.
			await handle.close().catch(() => {})
		}
	} catch {
		return Buffer.alloc(0)
	}
}

/** Control characters corrupt terminal and client rendering, so the displayed
 *  path folds them to spaces. A command naming a folded path then fails with
 *  a plain file-not-found — safe and self-explanatory. */
function sanitizePathText(path: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point of this sanitizer
	return path.replace(/[\x00-\x1f\x7f]+/g, " ").trim()
}

/** POSIX shell quoting so the suggested command survives copy-paste: a plain
 *  token stays bare, anything else is single-quoted (`'` becomes `'\''`).
 *  Two leading characters are re-interpreted by the shell or the CLI's flag
 *  parsing even quoted (the shell strips quotes before argv), so those names
 *  are anchored with `./` — the literal relative path the guard inspected:
 *  a leading dash would hit flag parsing, and a leading `~` that is not the
 *  user's own `~/` would tilde-expand elsewhere. The bare and quoted forms
 *  are what the permission gate's doc-cli matcher accepts. */
function shellQuote(path: string): string {
	const anchor = path.startsWith("-") || /^~(?!\/)/.test(path)
	const anchored = anchor ? `./${path}` : path
	return /^(?!-)[\w./@=:+~-]+$/.test(anchored) ? anchored : `'${anchored.replace(/'/g, "'\\''")}'`
}

/** Block reason for `read` on a binary document. */
export function readRedirectReason(displayPath: string, skill: DocCliSkill): string {
	const clean = sanitizePathText(displayPath)
	return `${clean} is a binary ${skill.toUpperCase()} file — the read tool would return raw bytes, not readable text. Read it with the bundled ${skill} skill instead: kimchi doc-cli ${skill} read ${shellQuote(clean)}`
}

/** Human-readable byte size for the stub line. */
function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
	return `${bytes} B`
}

/** Replacement body for an inlined binary-document @file block. */
export function documentStubLine(name: string, skill: DocCliSkill, bytes: number): string {
	const clean = sanitizePathText(name)
	return `[binary ${skill.toUpperCase()} file, ${formatSize(bytes)}, not inlined. Read it with: kimchi doc-cli ${skill} read ${shellQuote(clean)}]`
}

/** Remove a leading UTF-8 BOM, exactly as upstream's @file inlining does
 *  (utils/text.js; re-implemented because the deep path is outside the
 *  package's exports map, which vite/bun cannot resolve). */
function stripUtf8Bom(content: string): string {
	return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}

/** An upstream @file block opener: `<file name="ABS">\n` (the name is
 *  client-controlled text; the span between opener and a `\n</file>\n`
 *  terminator is verified by byte-match, so a document whose own decode
 *  contains that terminator is found by retrying the next one — see
 *  stubDocumentFileBlocks). */
const FILE_OPEN_RE = /<file name="([^"]+)">\n/g
const FILE_TERMINATOR = "\n</file>\n"
/** How many `\n</file>\n` terminators to try per opener: the first is the
 *  normal case; the retries cover documents whose decoded content itself
 *  contains the terminator (rare — it is ASCII text inside binary). Bounded
 *  so a hostile prompt cannot make the scan quadratic. */
const MAX_TERMINATOR_TRIES = 4

function fileBlockStub(name: string, skill: DocCliSkill, bytes: number): string {
	return `<file name="${name}">\n${documentStubLine(name, skill, bytes)}\n</file>\n`
}

/** Rewrite every @file block that still byte-matches its file's UTF-8 decode
 *  into a stub. Returns undefined when nothing changed. Identical duplicate
 *  blocks (the same @file attached twice) verify once. `cwd` anchors relative
 *  block names — upstream always writes absolute paths, but a hand-typed
 *  look-alike may not, and the ACP server's process cwd is unrelated to any
 *  session. */
export async function stubDocumentFileBlocks(text: string, cwd: string): Promise<string | undefined> {
	if (!text.includes('<file name="')) return undefined
	let out = ""
	let copied = 0
	let changed = false
	const cache = new Map<string, Promise<string | undefined>>()
	for (const opener of text.matchAll(FILE_OPEN_RE)) {
		const name = opener[1]
		const contentStart = (opener.index ?? 0) + opener[0].length
		// Try successive terminators: a binary document's own decode can
		// contain `\n</file>\n`, making the true span longer than the first
		// terminator. Each candidate is byte-verified, so a wrong span never
		// rewrites — the retries only rescue the genuine one.
		let from = contentStart
		for (let tries = 0; tries < MAX_TERMINATOR_TRIES; tries++) {
			const termAt = text.indexOf(FILE_TERMINATOR, from)
			if (termAt === -1) break
			const spanEnd = termAt + FILE_TERMINATOR.length
			const key = `${name}\u0000${spanEnd}`
			let stub = cache.get(key)
			if (stub === undefined) {
				stub = stubbedFileBlock(name, text.slice(contentStart, termAt), cwd)
				cache.set(key, stub)
			}
			const resolved = await stub
			if (resolved !== undefined) {
				const at = opener.index ?? 0
				out += text.slice(copied, at) + resolved
				copied = spanEnd
				changed = true
				break
			}
			from = termAt + 1
		}
	}
	return changed ? out + text.slice(copied) : undefined
}

async function stubbedFileBlock(name: string, content: string, cwd: string): Promise<string | undefined> {
	const skill = docSkillForPath(name)
	if (skill === undefined) return undefined
	const abs = isAbsolute(name) ? name : resolve(cwd, name)
	let size: number
	try {
		size = (await stat(abs)).size
	} catch {
		return undefined
	}
	if (!isBinaryOfSkill(await readHead(abs), skill)) return undefined
	// Length precheck (necessary condition only: a lossy UTF-8 decode can
	// only grow — invalid bytes re-encode as 3-byte U+FFFD — and upstream
	// strips a leading BOM, worth up to 3 bytes): a block body too short to
	// be this file's decode cannot be upstream's inlining of this path — skip
	// the full read entirely. This is the common look-alike case, and it is
	// what bounds the work when the input itself carries a huge inlined
	// document.
	if (Buffer.byteLength(content) + 3 < size) return undefined
	// Over the size cap, trust the magic and length checks: decoding a huge
	// file just to verify it is the resource cost this guard exists to avoid.
	if (size > maxFileBytes()) return fileBlockStub(name, skill, size)
	let bytes: Buffer
	try {
		bytes = await readFile(abs)
	} catch {
		return undefined
	}
	// Byte-match: the block carries exactly what upstream's UTF-8 decode of
	// this file produced. A file that changed since, or a user-typed
	// look-alike, does not match and is left untouched.
	if (content !== stripUtf8Bom(bytes.toString("utf-8"))) return undefined
	return fileBlockStub(name, skill, size)
}

export default function documentIntakeExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName.toLowerCase() !== "read") return
		const input = event.input as Record<string, unknown>
		const displayPath = typeof input.path === "string" ? input.path : ""
		if (displayPath === "") return
		const skill = docSkillForPath(displayPath)
		if (skill === undefined) return
		const resolvedPath = findExistingFile(displayPath, ctx.cwd)
		if (resolvedPath === null) return
		if (!isBinaryOfSkill(await readHead(resolvedPath), skill)) return
		return { block: true, reason: readRedirectReason(displayPath, skill) }
	})

	pi.on("input", async (event, ctx) => {
		// Extension-sourced input (subagent task briefs, sent messages) is
		// harness-built, not the @file pipeline.
		if (event.source === "extension") return
		const text = await stubDocumentFileBlocks(event.text, ctx.cwd)
		if (text === undefined) return
		return { action: "transform" as const, text }
	})
}
