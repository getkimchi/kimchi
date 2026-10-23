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

/** Quote a sheet name for formulas/CLI display; Space Needs → 'Space Needs'.
 *  Names that Excel would confuse with a reference or constant (A1, R1C1,
 *  TRUE/FALSE) are also quoted. */
export function quoteSheetName(name: string): string {
	const looksLikeRefOrConst =
		/^[A-Za-z]{1,3}\d+$/.test(name) || /^[Rr]\d*[Cc]\d*$/.test(name) || /^true$|^false$/i.test(name)
	return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !looksLikeRefOrConst ? name : `'${name.replace(/'/g, "''")}'`
}

/**
 * Excel's sheet-name rules; returns an error message when `name` is
 * unacceptable, undefined when it is. Case-insensitive duplicates are the
 * caller's concern (they depend on the workbook).
 */
export function validateSheetName(name: string): string | undefined {
	if (name.trim() === "") return "sheet name is empty"
	if (name.length > 31) return `sheet name ${JSON.stringify(name)} exceeds 31 characters`
	if (/[[\]:*?/\\]/.test(name))
		return `sheet name ${JSON.stringify(name)} contains a forbidden character ([ ] : * ? / \\)`
	if (name.startsWith("'") || name.endsWith("'"))
		return `sheet name ${JSON.stringify(name)} starts or ends with an apostrophe`
	if (name.toLowerCase() === "history") return `sheet name ${JSON.stringify(name)} is reserved by Excel`
	return undefined
}

/** One sheet-name prefix match inside a formula, as raw text → unquoted name. */
interface SheetPrefixHit {
	start: number
	end: number
	name: string
	raw: string
}

const BARE_NAME = /^[A-Za-z0-9_.]+/

/**
 * Find the next sheet-name prefix (`Name!`, `'Name'!`, `Name:Other!`,
 * `'Name:Other'!`) at or after `start`. String literals are skipped;
 * external-ref prefixes (`[1]Name!`) are never reported because a `]`
 * before the name disqualifies it. `''` inside a quoted name unescapes to
 * a single `'`. The colon in a 3D span is split only in
 * `renameSheetInFormula`/`formulaReferencesSheet`, which compare both ends.
 */
function nextSheetPrefix(formula: string, start: number): SheetPrefixHit | undefined {
	let i = start
	while (i < formula.length) {
		const ch = formula[i]
		if (ch === '"') {
			// String literal: skip with `""` escaping.
			let j = i + 1
			while (j < formula.length) {
				if (formula[j] === '"') {
					if (formula[j + 1] === '"') {
						j += 2
						continue
					}
					j++
					break
				}
				j++
			}
			i = j
			continue
		}
		const prev = formula[i - 1] ?? ""
		if (ch === "'" && prev !== "!" && prev !== "]" && !/[A-Za-z0-9_.]/.test(prev)) {
			// Quoted prefix: close quote must be followed by `!`, or by a bare
			// second 3D end (`'Name One':Two!`).
			let name = ""
			let j = i + 1
			let closed = -1
			while (j < formula.length) {
				if (formula[j] === "'") {
					if (formula[j + 1] === "'") {
						name += "'"
						j += 2
						continue
					}
					closed = j
					break
				}
				name += formula[j]
				j++
			}
			if (closed >= 0) {
				if (formula[closed + 1] === "!") {
					return { start: i, end: closed + 2, name, raw: formula.slice(i, closed + 1) }
				}
				if (formula[closed + 1] === ":") {
					const second = BARE_NAME.exec(formula.slice(closed + 2))
					if (second && formula[closed + 2 + second[0].length] === "!") {
						const end = closed + 2 + second[0].length
						return { start: i, end: end + 1, name: `${name}:${second[0]}`, raw: formula.slice(i, end) }
					}
				}
			}
			i++
			continue
		}
		if (
			BARE_NAME.test(ch) &&
			prev !== "'" &&
			prev !== "!" &&
			prev !== "." &&
			prev !== "]" &&
			!/[A-Za-z0-9_&]/.test(prev)
		) {
			const span = /^([A-Za-z0-9_.]+:[A-Za-z0-9_.]+)!/.exec(formula.slice(i))
			if (span) return { start: i, end: i + span[0].length, name: span[1], raw: span[1] }
			const m = BARE_NAME.exec(formula.slice(i))
			if (m && formula[i + m[0].length] === "!") {
				return { start: i, end: i + m[0].length + 1, name: m[0], raw: m[0] }
			}
		}
		i++
	}
	return undefined
}

/**
 * Rewrite every reference-END of `oldName` sheet prefixes in ONE formula
 * (3D spans like `Data:Other!A1` match on either end), leaving string
 * literals, external refs (`[1]Data!A1`) and unrelated prefixes untouched.
 * Matching is case-insensitive; replacements are re-quoted as needed.
 */
export function renameSheetInFormula(formula: string, oldName: string, newName: string): string {
	const oldLower = oldName.toLowerCase()
	let out = ""
	let pos = 0
	for (let hit = nextSheetPrefix(formula, 0); hit; hit = nextSheetPrefix(formula, pos)) {
		out += formula.slice(pos, hit.start)
		const ends = hit.name.includes(":")
			? hit.raw.split(":").map((part, idx) => {
					// Split the quoted span's `;'-quoted name on `:` — sheet names can't
					// contain `:`, so each end is independent.
					const unquoted = hit.name.split(":")[idx]
					if (unquoted.toLowerCase() === oldLower) return quoteSheetName(newName)
					return part
				})
			: [hit.name.toLowerCase() === oldLower ? quoteSheetName(newName) : hit.raw]
		out += ends.join(":") + "!"
		pos = hit.end
	}
	out += formula.slice(pos)
	return out
}

/** True when `formula` references `name` in any sheet-name prefix position
 *  (formula cell, defined name, chart ref, conditional format, validation). */
export function formulaReferencesSheet(formula: string, name: string): boolean {
	const lower = name.toLowerCase()
	for (let hit = nextSheetPrefix(formula, 0); hit; hit = nextSheetPrefix(formula, hit.end)) {
		if (hit.name.split(":").some((end) => end.toLowerCase() === lower)) return true
	}
	return false
}

/** Split a formula token like "'Sheet 1'!B2" or "Sheet1!B2" into parts. */
export function splitSheetRef(token: string): { sheet: string | undefined; ref: string } {
	const quoted = /^'((?:[^']|'')+)'!(.+)$/.exec(token)
	if (quoted) return { sheet: quoted[1].replace(/''/g, "'"), ref: quoted[2] }
	const plain = /^([A-Za-z0-9_.]+)!(.+)$/.exec(token)
	if (plain) return { sheet: plain[1], ref: plain[2] }
	return { sheet: undefined, ref: token }
}
