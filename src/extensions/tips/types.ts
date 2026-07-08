export type TipScope = "contextual" | "general"
export type TipTone = "default" | "warning" | "error"

export interface Tip {
	id: string
	scope: TipScope
	/** Markdown inline-code spans in message are highlighted in the tip row. */
	message: string
	/** Higher-priority tips are presented before lower-priority tips in the same scope. */
	priority?: number
	/** Visual treatment for non-tip warnings that reuse the tip row. */
	tone?: TipTone
	/** Defaults to true. Set false for standalone warning copy. */
	showPrefix?: boolean
}

export interface TipProvider {
	source: string
	getTips: () => readonly Tip[]
}

/**
 * Internal resolved tip shape. Providers return plain Tip objects; the registry
 * attaches source so arbitration can track ownership.
 */
export interface TipCandidate extends Tip {
	source: string
}

export function tipPriority(tip: Pick<Tip, "priority">): number {
	return typeof tip.priority === "number" ? tip.priority : 0
}
