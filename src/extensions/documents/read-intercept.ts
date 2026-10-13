/**
 * Transparent `read` interception: when the model reads a document file
 * (extension whitelist → magic bytes confirm), the tool result is replaced
 * with the extracted Markdown. Documents over 20 units return the first 20
 * units with a continuation pointer; non-document `read` results are
 * untouched byte-for-byte.
 */

import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import { modelSupportsImages } from "../vision-support.js"
import { isDocumentPath } from "./detect.js"
import { MAX_UNITS_PER_CALL } from "./limits.js"
import { isDocumentError } from "./model.js"
import { loadExtracted, selectUnits } from "./read-tool.js"
import { renderDocument, renderOutline } from "./render.js"
import { maybeRenderScannedPages } from "./render-pages.js"

export function installReadInterception(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
		if (event.toolName !== "read" || event.isError) return undefined
		const path = (event.input as { path?: string } | undefined)?.path
		if (!path || !isDocumentPath(path)) return undefined
		// Only intercept when extraction succeeds in producing document text —
		// magic bytes decide. A `.txt` file that happens to be caught by the
		// extension pass fell through isDocumentPath already.
		try {
			const cwd = ctx.cwd
			const { doc, data } = await loadExtracted(path, cwd, { tool: "read" })
			// A single-unit document is fully covered by one render; a big
			// document gets the first 20 units plus a continuation pointer.
			const selection = selectUnits(doc, {})
			if (selection.error) return undefined
			const out = renderDocument(doc, { unitIndices: selection.indices, path, toolName: "read_document" })
			// Phase 1.6: image-only PDF pages ride along as image blocks when the
			// session model accepts images (text-only models keep the warning).
			const scanned = await maybeRenderScannedPages({
				data,
				doc,
				selected: selection.indices,
				supportsImages: modelSupportsImages(ctx.model),
			})
			const note = scanned.note ? `\n\nNote: ${scanned.note}.` : ""
			const marker =
				scanned.images.length > 0
					? `\n\n[page-images] ${scanned.images.length} scanned page(s) attached as images.`
					: ""
			const imageBlocks = scanned.images.map((img) => ({
				type: "image" as const,
				data: img.data,
				mimeType: img.mimeType,
			}))
			if (doc.units.length > MAX_UNITS_PER_CALL) {
				const outline = renderOutline(doc, path)
				return {
					content: [
						{
							type: "text" as const,
							text: `${out.text}${note}${marker}\n\n—\nThis document has ${doc.units.length} ${doc.unitKind}s; only the first ${MAX_UNITS_PER_CALL} are shown inline.\n\n${outline}`,
						},
						...imageBlocks,
					],
				}
			}
			return { content: [{ type: "text" as const, text: `${out.text}${note}${marker}` }, ...imageBlocks] }
		} catch (err) {
			if (isDocumentError(err)) {
				if (err.code === "not-a-document") return undefined // extension lied — plain text read
				return {
					content: [{ type: "text", text: `Could not extract ${path}: ${err.message}` }],
				}
			}
			throw err
		}
	})
}

/** Kept small and synchronous for unit tests: should a read result be
 *  intercepted at all (extension whitelist only; bytes decide later)? */
export function shouldInterceptRead(event: {
	toolName?: string
	isError?: boolean
	input?: { path?: string }
}): boolean {
	if (event.toolName !== "read" || event.isError) return false
	const path = event.input?.path
	return typeof path === "string" && isDocumentPath(path)
}
