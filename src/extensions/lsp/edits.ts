// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
// extensions/lsp/edits.ts
import * as fs from "node:fs/promises"
import path from "node:path"
import type { TextEdit, WorkspaceEdit } from "./types.js"
import { uriToFile } from "./utils.js"

export function applyTextEditsToString(content: string, edits: TextEdit[]): string {
	if (edits.length === 0) return content
	const lines = content.split("\n")

	const sorted = [...edits].sort((a, b) => {
		if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line
		return b.range.start.character - a.range.start.character
	})

	for (const edit of sorted) {
		const { start, end } = edit.range
		if (start.line === end.line) {
			const line = lines[start.line] ?? ""
			lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character)
		} else {
			const startLine = lines[start.line] ?? ""
			const endLine = lines[end.line] ?? ""
			const merged = startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character)
			lines.splice(start.line, end.line - start.line + 1, ...merged.split("\n"))
		}
	}

	return lines.join("\n")
}

async function applyTextEditsToFile(filePath: string, edits: TextEdit[]): Promise<void> {
	const content = await fs.readFile(filePath, "utf-8")
	const result = applyTextEditsToString(content, edits)
	await fs.writeFile(filePath, result, "utf-8")
}

/** Apply a workspace edit. Used for rename results only. Returns list of applied change descriptions. */
export async function applyWorkspaceEdit(edit: WorkspaceEdit, cwd: string): Promise<string[]> {
	const applied: string[] = []

	if (edit.changes) {
		for (const [uri, textEdits] of Object.entries(edit.changes)) {
			const filePath = uriToFile(uri)
			await applyTextEditsToFile(filePath, textEdits)
			applied.push(`Applied ${textEdits.length} edit(s) to ${path.relative(cwd, filePath)}`)
		}
	}

	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("textDocument" in change && "edits" in change) {
				const filePath = uriToFile(change.textDocument.uri)
				const textEdits = change.edits.filter((e): e is TextEdit => "range" in e && "newText" in e)
				await applyTextEditsToFile(filePath, textEdits)
				applied.push(`Applied ${textEdits.length} edit(s) to ${path.relative(cwd, filePath)}`)
			} else if ("kind" in change) {
				if (change.kind === "create") {
					const filePath = uriToFile(change.uri)
					await fs.writeFile(filePath, "", "utf-8")
					applied.push(`Created ${path.relative(cwd, filePath)}`)
				} else if (change.kind === "rename") {
					const oldPath = uriToFile(change.oldUri)
					const newPath = uriToFile(change.newUri)
					await fs.mkdir(path.dirname(newPath), { recursive: true })
					await fs.rename(oldPath, newPath)
					applied.push(`Renamed ${path.relative(cwd, oldPath)} → ${path.relative(cwd, newPath)}`)
				} else if (change.kind === "delete") {
					const filePath = uriToFile(change.uri)
					await fs.rm(filePath, { recursive: true })
					applied.push(`Deleted ${path.relative(cwd, filePath)}`)
				}
			}
		}
	}

	return applied
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
