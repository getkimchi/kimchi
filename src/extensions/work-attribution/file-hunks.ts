import { diffArrays } from "diff"

export const MAX_HUNK_BYTES = 256 * 1024
interface Hunk {
	oldStart: number
	newStart: number
	removed: string
	added: string
}

function hunks(before: string, after: string): Hunk[] | undefined {
	const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
	const changes = diffArrays(lines(before), lines(after), { timeout: 25, maxEditLength: 2048 })
	if (!changes) return
	const result: Hunk[] = []
	let oldStart = 0
	let newStart = 0
	let current: Hunk | undefined
	for (const change of changes) {
		const text = change.value.join("")
		if (!change.added && !change.removed) {
			if (current) result.push(current)
			current = undefined
			oldStart += text.length
			newStart += text.length
		} else {
			current ??= { oldStart, newStart, removed: "", added: "" }
			if (change.removed) {
				current.removed += text
				oldStart += text.length
			} else {
				current.added += text
				newStart += text.length
			}
		}
	}
	if (current) result.push(current)
	return result
}

/** One unchanged line on either side, or the file boundary, must identify one location. */
function locate(source: string, start: number, length: number, target: string, checkBudget: () => void) {
	const end = start + length
	const windowStart = start < 2 ? 0 : source.lastIndexOf("\n", start - 2) + 1
	const nextNewline = source.indexOf("\n", end)
	const windowEnd = nextNewline < 0 ? source.length : nextNewline + 1
	const window = source.slice(windowStart, windowEnd)
	if (!window) return
	function unique(text: string): number | undefined {
		let found: number | undefined
		for (let offset = text.indexOf(window); offset >= 0; offset = text.indexOf(window, offset + 1)) {
			checkBudget()
			if (offset > 0 && text[offset - 1] !== "\n") continue
			if (start === 0 && offset !== 0) continue
			if (end === source.length && offset + window.length !== text.length) continue
			if (!window.endsWith("\n") && offset + window.length !== text.length) continue
			if (found !== undefined) return
			found = offset
		}
		return found
	}
	if (unique(source) !== windowStart) return
	const position = unique(target)
	return position === undefined ? undefined : position + start - windowStart
}

/** All net native changes must survive as distinct committed hunks; partial matches prove nothing. */
export function matchesFileHunks(
	before: string,
	after: string,
	parent: string,
	committed: string,
	checkBudget: () => void,
): boolean {
	if ([before, after, parent, committed].some((text) => Buffer.byteLength(text) > MAX_HUNK_BYTES)) return false
	checkBudget()
	const native = hunks(before, after)
	checkBudget()
	const changes = hunks(parent, committed)
	if (!native?.length || native.length > 64 || !changes) return false
	return native.every((hunk) => {
		checkBudget()
		const oldStart = locate(before, hunk.oldStart, hunk.removed.length, parent, checkBudget)
		const newStart = locate(after, hunk.newStart, hunk.added.length, committed, checkBudget)
		return (
			oldStart !== undefined &&
			newStart !== undefined &&
			changes.some(
				(change) =>
					change.oldStart === oldStart &&
					change.newStart === newStart &&
					change.removed === hunk.removed &&
					change.added === hunk.added,
			)
		)
	})
}
