import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolArgs = Record<string, unknown>

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function nowNano(): string {
	return String(Date.now() * 1_000_000)
}

// ---------------------------------------------------------------------------
// OTLP attribute builders
// ---------------------------------------------------------------------------

export function strAttr(key: string, value: string): { key: string; value: { stringValue: string } } {
	return { key, value: { stringValue: value } }
}

/** Convert mixed attrs to string|number values (booleans become "true"/"false"). */
export function toAttrs(attrs: Record<string, string | number | boolean>): Record<string, string | number> {
	const result: Record<string, string | number> = {}
	for (const [k, v] of Object.entries(attrs)) {
		result[k] = typeof v === "boolean" ? (v ? "true" : "false") : v
	}
	return result
}

// ---------------------------------------------------------------------------
// Language inference
// ---------------------------------------------------------------------------

const LANGUAGE_BY_EXT: Record<string, string> = {
	ts: "TypeScript",
	tsx: "TypeScript",
	js: "JavaScript",
	jsx: "JavaScript",
	mjs: "JavaScript",
	cjs: "JavaScript",
	py: "Python",
	go: "Go",
	rs: "Rust",
	rb: "Ruby",
	java: "Java",
	kt: "Kotlin",
	swift: "Swift",
	c: "C",
	h: "C",
	cpp: "C++",
	cc: "C++",
	cxx: "C++",
	hpp: "C++",
	cs: "C#",
	php: "PHP",
	dart: "Dart",
	md: "Markdown",
	mdx: "Markdown",
	json: "JSON",
	yaml: "YAML",
	yml: "YAML",
	toml: "TOML",
	ini: "TOML",
	xml: "HTML/XML",
	html: "HTML/XML",
	htm: "HTML/XML",
	svg: "HTML/XML",
	css: "CSS",
	scss: "CSS",
	less: "CSS",
	sql: "SQL",
	sh: "Bash",
	bash: "Bash",
	zsh: "Bash",
	txt: "Plain text",
	proto: "Protocol Buffers",
	tf: "HCL",
	dockerfile: "Dockerfile",
}

export function inferLanguage(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
	return LANGUAGE_BY_EXT[ext] ?? "unknown"
}

// ---------------------------------------------------------------------------
// Line-change counting
// ---------------------------------------------------------------------------

export function countLineChanges(oldStr: string, newStr: string): { added: number; removed: number } {
	const trimmedOld = oldStr.replace(/\n+$/, "")
	const trimmedNew = newStr.replace(/\n+$/, "")
	const oldLines = trimmedOld ? trimmedOld.split("\n").length : 0
	const newLines = trimmedNew ? trimmedNew.split("\n").length : 0
	const changed = trimmedOld !== trimmedNew
	const added = Math.max(newLines - oldLines, 0) || (changed && newLines >= oldLines ? 1 : 0)
	const removed = Math.max(oldLines - newLines, 0) || (changed && oldLines > newLines ? 1 : 0)
	return { added, removed }
}

/**
 * Compute aggregated line changes for a tool invocation.
 * For multiedit, sums changes across all edits; otherwise delegates to countLineChanges.
 */
export function computeLineChanges(_toolName: string, args: ToolArgs): { added: number; removed: number } {
	const edits = Array.isArray(args?.edits) ? (args.edits as Array<{ oldText?: string; newText?: string }>) : []
	if (edits.length > 0) {
		let added = 0
		let removed = 0
		for (const edit of edits) {
			const c = countLineChanges(String(edit.oldText ?? ""), String(edit.newText ?? ""))
			added += c.added
			removed += c.removed
		}
		return { added, removed }
	}
	return { added: 0, removed: 0 }
}

/**
 * Count lines in write content, ignoring trailing newlines.
 * Returns 0 for empty or whitespace-only content, at least 1 for non-empty writes.
 */
export function computeWriteLines(args: ToolArgs): number {
	const content = String(args?.content ?? "")
	const trimmed = content.replace(/\n+$/, "")
	return trimmed ? trimmed.split("\n").length : 0
}

// ---------------------------------------------------------------------------
// File-path utilities
// ---------------------------------------------------------------------------

/** Extract the file path from tool args (supports both `path` and `filePath` keys). */
export function extractFilePath(args: ToolArgs): string {
	return String(args?.path ?? args?.filePath ?? "")
}

/** Return a short (12-char) hex hash of a file path for privacy-safe telemetry. */
export function hashFilePath(filePath: string): string {
	return createHash("sha256").update(filePath).digest("hex").slice(0, 12)
}
