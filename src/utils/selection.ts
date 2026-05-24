import { stripAnsi } from "./strip-ansi.js"

/**
 * Extract plain text from a rectangular region in an array of rendered lines.
 *
 * Handles ANSI escape sequences, flow-style selection (partial first/last row,
 * full middle rows), and swaps start/end when the user drags backwards.
 */
export function extractSelectionText(
	lines: string[],
	start: { x: number; y: number },
	end: { x: number; y: number },
): string {
	const startRow = Math.min(start.y, end.y) - 1
	const endRow = Math.max(start.y, end.y) - 1
	const startCol = start.y <= end.y ? start.x - 1 : end.x - 1
	const endCol = start.y <= end.y ? end.x - 1 : start.x - 1
	const result: string[] = []
	for (let row = startRow; row <= endRow; row++) {
		if (row < 0 || row >= lines.length) continue
		const plain = stripAnsi(lines[row])
		if (row === startRow && row === endRow) {
			// Single row — always left-to-right, regardless of drag direction.
			const left = Math.min(startCol, endCol)
			const right = Math.max(startCol, endCol)
			result.push(plain.slice(left, right + 1))
		} else if (row === startRow) {
			result.push(plain.slice(startCol))
		} else if (row === endRow) {
			result.push(plain.slice(0, endCol + 1))
		} else {
			result.push(plain)
		}
	}
	return result.join("\n")
}
