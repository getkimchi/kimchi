/**
 * A1-style cell/sheet reference helpers shared by the XLSX extractor,
 * writer, editor and formula lint. All indices are 1-based like the UI.
 */

/** Column letters ("A", "B", …, "Z", "AA", …) for a 1-based column index. */
export function columnLetter(index: number): string {
	let n = index
	let s = ""
	while (n > 0) {
		const m = (n - 1) % 26
		s = String.fromCharCode(65 + m) + s
		n = Math.floor((n - m - 1) / 26)
	}
	return s
}

/** 1-based column index of letters, or undefined when invalid. */
export function columnIndex(letters: string): number | undefined {
	if (!/^[A-Za-z]{1,3}$/.test(letters)) return undefined
	let n = 0
	for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64)
	return n
}

export interface CellRef {
	row: number
	column: number
}

/** Parse "B12" (or "$B$12") into a 1-based ref, or undefined. */
export function parseCellRef(ref: string): CellRef | undefined {
	const m = /^\$?([A-Za-z]{1,3})\$?([0-9]+)$/.exec(ref.trim())
	if (!m) return undefined
	const column = columnIndex(m[1])
	const row = Number(m[2])
	if (!column || row < 1) return undefined
	return { row, column }
}

/** "R3C2" → "B3". */
export function formatCellRef(ref: CellRef): string {
	return `${columnLetter(ref.column)}${ref.row}`
}

/** A 1-based coordinate range ("A1" or "A1:B5"). */
export interface RangeRef {
	start: CellRef
	end: CellRef
}

export function parseRangeRef(ref: string): RangeRef | undefined {
	const [a, b] = ref.split(":")
	const start = parseCellRef(a)
	const end = b === undefined ? start : parseCellRef(b)
	if (!start || !end) return undefined
	if (end.row < start.row || end.column < start.column) return undefined
	return { start, end }
}

/** Quote a sheet name for formulas/CLI display; Space Needs → 'Space Needs'. */
export function quoteSheetName(name: string): string {
	return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`
}

/** Split a formula token like "'Sheet 1'!B2" or "Sheet1!B2" into parts. */
export function splitSheetRef(token: string): { sheet: string | undefined; ref: string } {
	const quoted = /^'((?:[^']|'')+)'!(.+)$/.exec(token)
	if (quoted) return { sheet: quoted[1].replace(/''/g, "'"), ref: quoted[2] }
	const plain = /^([A-Za-z0-9_.]+)!(.+)$/.exec(token)
	if (plain) return { sheet: plain[1], ref: plain[2] }
	return { sheet: undefined, ref: token }
}
