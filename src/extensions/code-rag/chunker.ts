/**
 * Line-window chunking for the code-rag extension.
 *
 * Deliberately simple for the PoC: fixed windows with overlap, no AST
 * awareness. The file path + line range is prepended to the embedded text
 * (not stored in the chunk) so path/name tokens participate in similarity.
 */

export interface CodeChunk {
	file: string
	startLine: number
	endLine: number
	text: string
}

const CHUNK_LINES = 64
const OVERLAP_LINES = 12
/** Guard against pathological lines (minified bundles that slipped the
 *  filename filters, embedded data). Applies per chunk, after joining. */
const MAX_CHUNK_CHARS = 6000

export function chunkFile(relPath: string, content: string): CodeChunk[] {
	const lines = content.split("\n")
	const chunks: CodeChunk[] = []
	const stride = CHUNK_LINES - OVERLAP_LINES
	for (let start = 0; start < lines.length; start += stride) {
		const end = Math.min(start + CHUNK_LINES, lines.length)
		const text = lines.slice(start, end).join("\n")
		if (text.trim().length > 0) {
			chunks.push({
				file: relPath,
				startLine: start + 1,
				endLine: end,
				text: text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) : text,
			})
		}
		if (end >= lines.length) break
	}
	return chunks
}

export function embeddingInputForChunk(chunk: CodeChunk): string {
	return `File: ${chunk.file} (lines ${chunk.startLine}-${chunk.endLine})\n${chunk.text}`
}
