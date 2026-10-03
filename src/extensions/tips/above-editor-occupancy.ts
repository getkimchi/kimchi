/**
 * Tracks non-tip content in the above-editor strip so the tip row can yield
 * when todos, agents, questionnaires, or other sections are visible.
 */

const occupantCounts = new Map<string, number>()
let onChange: (() => void) | undefined

export function isAboveEditorOccupied(): boolean {
	return occupantCounts.size > 0
}

/** Claim the above-editor strip. Returns a one-shot release. */
export function acquireAboveEditorSlot(key: string): () => void {
	const previous = occupantCounts.get(key) ?? 0
	occupantCounts.set(key, previous + 1)
	if (previous === 0) onChange?.()

	let released = false
	return () => {
		if (released) return
		released = true
		const current = occupantCounts.get(key) ?? 0
		if (current <= 1) {
			occupantCounts.delete(key)
			onChange?.()
			return
		}
		occupantCounts.set(key, current - 1)
	}
}

export function onAboveEditorOccupancyChange(listener: () => void): () => void {
	onChange = listener
	return () => {
		if (onChange === listener) onChange = undefined
	}
}

/** Test helper — clears all occupants and the change listener. */
export function __resetAboveEditorOccupancy(): void {
	occupantCounts.clear()
	onChange = undefined
}
