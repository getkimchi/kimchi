export type TipProviderKind = "contextual" | "general"

export interface Tip {
	id: string
	message: string
	/** Optional command/action token. If present in message, the tip row highlights that substring. */
	command?: string
}

export interface TipProvider {
	source: string
	kind: TipProviderKind
	getTips: () => readonly Tip[]
}

/**
 * Internal resolved tip shape. Providers return plain Tip objects; the registry
 * attaches source/kind so arbitration can track ownership and contextual scope.
 */
export interface TipCandidate extends Tip {
	source: string
	kind: TipProviderKind
}
