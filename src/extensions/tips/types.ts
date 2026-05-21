export type TipScope = "contextual" | "general"

export interface Tip {
	id: string
	scope: TipScope
	/** Markdown inline-code spans in message are highlighted in the tip row. */
	message: string
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
