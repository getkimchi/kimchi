import { isAcpSessionHost } from "../../modes/acp/state.js"

// Ferment is not fully tested over ACP yet, so an ACP client must opt in.
let fermentPermitted = false

/** ACP initialize sets this before loading any session's extensions. */
export function setFermentPermitted(permitted: boolean): void {
	fermentPermitted = permitted
}

/** Gates `/ferment`, its stub, and its plan executor. Always true outside ACP. */
export function isFermentPermitted(): boolean {
	return !isAcpSessionHost() || fermentPermitted
}
