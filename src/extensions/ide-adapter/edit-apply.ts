/** Compute the content a `write`/`edit` tool call would produce, so the
 * ide-adapter can send it to the IDE's diff viewer *before* the tool runs.
 * Semantics mirror `getEditOperations` in `src/extensions/tool-rendering.ts`. */

export interface EditOperation {
	oldText: string
	newText: string
}

/** Normalise raw `edit` tool input into edit operations. Accepts array and
 * single-operation forms, with `old_text`/`new_text` snake_case fallbacks.
 * Filters out empty and no-op entries, matching the upstream `edit` tool. */
export function normaliseEditOperations(input: {
	oldText?: string
	old_text?: string
	newText?: string
	new_text?: string
	edits?: Array<{ oldText?: string; old_text?: string; newText?: string; new_text?: string }>
}): Array<EditOperation> {
	if (Array.isArray(input?.edits)) {
		return input.edits
			.map((edit) => ({
				oldText:
					typeof edit?.oldText === "string" ? edit.oldText : typeof edit?.old_text === "string" ? edit.old_text : "",
				newText:
					typeof edit?.newText === "string" ? edit.newText : typeof edit?.new_text === "string" ? edit.new_text : "",
			}))
			.filter((edit) => edit.oldText && edit.oldText !== edit.newText)
	}
	const oldText =
		typeof input?.oldText === "string" ? input.oldText : typeof input?.old_text === "string" ? input.old_text : ""
	const newText =
		typeof input?.newText === "string" ? input.newText : typeof input?.new_text === "string" ? input.new_text : ""
	return oldText && oldText !== newText ? [{ oldText, newText }] : []
}

/** Apply operations sequentially, replacing the first occurrence of each
 * `oldText`. Returns `null` if any `oldText` is not found — matching the
 * edit tool's all-or-nothing semantics. */
export function applyEdits(original: string, operations: Array<EditOperation>): string | null {
	let content = original
	for (const op of operations) {
		const idx = content.indexOf(op.oldText)
		if (idx === -1) return null
		content = content.slice(0, idx) + op.newText + content.slice(idx + op.oldText.length)
	}
	return content
}

/** Convenience: normalise and apply in one call. */
export function applyEditInput(original: string, input: Parameters<typeof normaliseEditOperations>[0]): string | null {
	return applyEdits(original, normaliseEditOperations(input))
}
