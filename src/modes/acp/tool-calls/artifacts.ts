// Generated-artifact detection for ACP sessions.
//
// Detects user-openable files (slides, spreadsheets, PDFs, …) the agent
// produced, so clients can render an "Open <name>" action. Detection is
// conservative: only write/edit paths and bash/powershell output are
// inspected, candidates must match the extension allowlist, and live
// detection requires the file to exist. Detection never throws.
//
// Trust assumption: artifact paths are agent-controlled output; the chip
// is an explicit user action. Script-capable types (.html/.svg) open in
// the user's own environment.

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, extname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export type Artifact = {
	/** Absolute resolved path. */
	path: string
	/** Basename, for chip labels. */
	name: string
	/** file:// URI form of path. */
	uri: string
	/** Best-known MIME type from the extension allowlist; may be undefined. */
	mimeType?: string
}

/** Lowercase extension → MIME type. Fixed allowlist for v1 (not configurable). */
export const ARTIFACT_EXTENSIONS: Record<string, string> = {
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pdf": "application/pdf",
	".html": "text/html",
	".htm": "text/html",
	".csv": "text/csv",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".zip": "application/zip",
	".ics": "text/calendar",
}

// Max artifacts reported per bash result (bounds flood-prone output).
const MAX_BASH_ARTIFACTS = 8

// Max candidate tokens evaluated per result. existsSync is synchronous,
// so an unbounded match stream could stall the server's event loop.
const MAX_BASH_CANDIDATES = 256

// Replicates pi's resolveToCwd (pi-coding-agent path-utils: unicode-space
// normalization, @-prefix strip, ~ expansion) because the write tool uses
// it for args.path; callers must resolve identically. pi only exports
// "."/"./hooks", so the helper cannot be imported directly.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
export function resolveToolPath(input: string, cwd: string): string {
	let p = input.replace(UNICODE_SPACES, " ")
	if (p.startsWith("@")) p = p.slice(1)
	if (p === "~") {
		p = homedir()
	} else if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
		p = join(homedir(), p.slice(2))
	}
	if (/^file:\/\//.test(p)) p = fileURLToPath(p)
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p)
}

function artifactFromPath(rawPath: string, cwd: string, opts: { verifyExists: boolean }): Artifact | null {
	const mimeType = ARTIFACT_EXTENSIONS[extname(rawPath).toLowerCase()]
	if (mimeType === undefined) return null
	let path: string
	try {
		path = resolveToolPath(rawPath, cwd)
	} catch {
		return null
	}
	if (opts.verifyExists && !existsSync(path)) return null
	return { path, name: basename(path), uri: pathToFileURL(path).href, mimeType }
}

// Candidate path tokens in shell output, keyed on the artifact
// extensions so plain words never match. Quotes, whitespace and shell
// metachars terminate a token (paths containing spaces are not detected —
// a documented v1 trade-off). Tokens containing "://" (URLs) are rejected
// before resolution. The extension list must stay in sync with
// ARTIFACT_EXTENSIONS; artifacts.test.ts asserts this in both directions.
const PATH_TOKEN =
	/[^\s"'<>`;|&*?()[\]{}]*\.(?:pptx|xlsx|docx|pdf|html|htm|csv|png|jpg|jpeg|gif|webp|svg|md|markdown|zip|ics)(?![\w.])/gi

function textBlocks(result: unknown): string[] {
	const r = result as { content?: unknown } | null | undefined
	if (!r || !Array.isArray(r.content)) return []
	const out: string[] = []
	for (const block of r.content) {
		const b = block as { type?: unknown; text?: unknown } | null
		if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") out.push(b.text)
	}
	return out
}

function isErrorResult(result: unknown): boolean {
	return (result as { isError?: unknown } | null | undefined)?.isError === true
}

function bashArtifacts(result: unknown, cwd: string, opts: { verifyExists: boolean }): Artifact[] {
	const out: Artifact[] = []
	const seen = new Set<string>()
	const seenTokens = new Set<string>()
	let candidates = 0
	for (const text of textBlocks(result)) {
		for (const match of text.matchAll(PATH_TOKEN)) {
			if (out.length >= MAX_BASH_ARTIFACTS) return out
			// Dedupe raw tokens before the budget check so repeats cost
			// neither a budget slot nor resolution/existence syscalls.
			if (seenTokens.has(match[0])) continue
			seenTokens.add(match[0])
			if (++candidates > MAX_BASH_CANDIDATES) return out
			if (match[0].includes("://")) continue
			const artifact = artifactFromPath(match[0], cwd, opts)
			if (!artifact || seen.has(artifact.path)) continue
			seen.add(artifact.path)
			out.push(artifact)
		}
	}
	return out
}

/**
 * Detect generated artifacts from a completed tool call. `args` are the
 * tool's arguments (stashed at tool_execution_start; the end event has
 * none). Errored results produce no artifacts. Never throws.
 */
export function artifactsFromToolCall(
	toolName: string,
	args: unknown,
	result: unknown,
	cwd: string,
	opts: { verifyExists: boolean } = { verifyExists: true },
): Artifact[] {
	try {
		if (isErrorResult(result)) return []
		if (toolName === "write" || toolName === "edit") {
			const path = (args as { path?: unknown } | null | undefined)?.path
			if (typeof path !== "string") return []
			const artifact = artifactFromPath(path, cwd, opts)
			return artifact ? [artifact] : []
		}
		if (toolName === "bash" || toolName === "powershell") {
			return bashArtifacts(result, cwd, opts)
		}
		return []
	} catch {
		return []
	}
}
