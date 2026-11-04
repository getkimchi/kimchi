// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
export class ExpandState {
	private toolCallOrder: string[] = []
	private expandedToolIds = new Set<string>()

	registerToolCall(id: string) {
		if (!this.toolCallOrder.includes(id)) {
			this.toolCallOrder.push(id)
		}
	}

	isToolExpanded(id: string): boolean {
		return this.expandedToolIds.has(id)
	}

	expandNext(): boolean {
		for (let i = this.toolCallOrder.length - 1; i >= 0; i--) {
			if (!this.expandedToolIds.has(this.toolCallOrder[i])) {
				this.expandedToolIds.add(this.toolCallOrder[i])
				return true
			}
		}
		return false
	}

	collapseAll() {
		this.expandedToolIds.clear()
	}

	reset() {
		this.toolCallOrder.length = 0
		this.expandedToolIds.clear()
	}
}

const instance = new ExpandState()

export const registerToolCall = instance.registerToolCall.bind(instance)
export const isToolExpanded = instance.isToolExpanded.bind(instance)
export const expandNext = instance.expandNext.bind(instance)
export const collapseAll = instance.collapseAll.bind(instance)
export const resetState = instance.reset.bind(instance)
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
