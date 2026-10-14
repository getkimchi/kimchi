// extensions/lsp/utils.ts
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { Diagnostic } from "./types.js"

// =============================================================================
// Path Normalization
// =============================================================================

/** True when the platform's default filesystem is case-insensitive, so
 *  containment checks compare case-folded paths. */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32"

/** Normalize a filesystem path for comparison: expand a leading `~`, resolve
 *  to absolute, and collapse symlinks via realpath when the path exists (the
 *  pre-realpath resolved form otherwise, so missing paths still compare).
 *
 *  Without this, a session cwd reached through a symlink (macOS `/var` →
 *  `/private/var`, symlinked repo dirs) never string-matches a tool-supplied
 *  path through the real path, and an in-workspace file gets classified as
 *  outside. */
export function normalizePath(p: string): string {
	const expanded =
		p === "~" || p.startsWith(`~${path.sep}`) || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p
	const resolved = path.resolve(expanded)
	// Realpath the nearest existing ancestor and re-append the missing tail,
	// so paths under symlinked directories canonicalize even when the file
	// itself doesn't exist yet (write flows).
	const tail: string[] = []
	let current = resolved
	while (true) {
		try {
			return tail.length === 0 ? realpathSync(current) : path.join(realpathSync(current), ...tail)
		} catch {
			const parent = path.dirname(current)
			if (parent === current) return resolved
			tail.unshift(path.basename(current))
			current = parent
		}
	}
}

/** True when filePath is the given directory or nested inside it, comparing
 *  normalized paths (symlinks resolved, case-folded on darwin/win32). Both
 *  the session-cwd containment guard in lsp.ts and clientCwd key derivation
 *  must use the same comparison so the same files land in the same buckets
 *  whichever path a caller took. */
export function isPathWithin(filePath: string, dir: string): boolean {
	let file = normalizePath(filePath)
	let root = normalizePath(dir)
	if (CASE_INSENSITIVE_FS) {
		file = file.toLowerCase()
		root = root.toLowerCase()
	}
	return file === root || file.startsWith(root + path.sep)
}

// =============================================================================
// URI Handling
// =============================================================================

export function fileToUri(filePath: string): string {
	const resolved = path.resolve(filePath)
	if (process.platform === "win32") {
		return `file:///${resolved.replace(/\\/g, "/")}`
	}
	return `file://${resolved}`
}

export function uriToFile(uri: string): string {
	if (!uri.startsWith("file://")) return uri
	let filePath = decodeURIComponent(uri.slice(7))
	if (process.platform === "win32" && filePath.startsWith("/") && /^[A-Za-z]:/.test(filePath.slice(1))) {
		filePath = filePath.slice(1)
	}
	return filePath
}

// =============================================================================
// Language Detection
// =============================================================================

const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript",
	tsx: "typescriptreact",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascriptreact",
	mjs: "javascript",
	cjs: "javascript",
	go: "go",
	rs: "rust",
	py: "python",
	rb: "ruby",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "markdown",
	sh: "shellscript",
	bash: "shellscript",
}

export function detectLanguageId(filePath: string): string {
	const ext = path.extname(filePath).slice(1).toLowerCase()
	return EXT_TO_LANG[ext] ?? "plaintext"
}

// =============================================================================
// Diagnostic Formatting
// =============================================================================

const SEVERITY_NAMES: Record<number, string> = {
	1: "error",
	2: "warning",
	3: "info",
	4: "hint",
}

export function formatDiagnostic(d: Diagnostic): string {
	const line = d.range.start.line + 1
	const col = d.range.start.character + 1
	const sev = SEVERITY_NAMES[d.severity ?? 1] ?? "error"
	const code = d.code !== undefined ? ` [${d.code}]` : ""
	return `${line}:${col} ${sev}${code}: ${d.message}`
}
