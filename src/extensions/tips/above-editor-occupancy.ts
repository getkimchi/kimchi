/**
 * Tracks non-tip content in the above-editor strip so the tip row can yield
 * when todos, agents, questionnaires, or other sections are visible.
 */

const occupantCounts = new Map<string, number>()
const listeners = new Set<() => void>()

export function isAboveEditorOccupied(): boolean {
	return occupantCounts.size > 0
}

function notifyOccupancyChange(): void {
	for (const listener of listeners) {
		try {
			listener()
		} catch {
			// Listener failures must not leak slots or break acquire/release callers.
		}
	}
}

/** Claim the above-editor strip. Returns a one-shot release. */
export function acquireAboveEditorSlot(key: string): () => void {
	const wasEmpty = occupantCounts.size === 0
	const previous = occupantCounts.get(key) ?? 0
	occupantCounts.set(key, previous + 1)
	if (wasEmpty) notifyOccupancyChange()

	let released = false
	return () => {
		if (released) return
		released = true
		const current = occupantCounts.get(key) ?? 0
		if (current <= 1) {
			occupantCounts.delete(key)
			if (occupantCounts.size === 0) notifyOccupancyChange()
			return
		}
		occupantCounts.set(key, current - 1)
	}
}

export function onAboveEditorOccupancyChange(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/** Test helper — clears all occupants and listeners. */
export function __resetAboveEditorOccupancy(): void {
	occupantCounts.clear()
	listeners.clear()
}
