import { getCliModeArg } from "../../cli-args.js"

const originalArgs = process.argv.slice(2)

// ACP mode runs JSON-RPC over stdio; interactive mode runs the standard TUI
// harness. Decide once at module load, before anything else runs.
export const IS_ACP_MODE = getCliModeArg(originalArgs) === "acp"

/**
 * Process-level context about the ACP client that consumes this process.
 * The ACP server writes client info during initialize().
 */
export interface AcpClientInfo {
	name: string
	version: string
	title?: string | null
}

let acpClientInfo: AcpClientInfo | undefined

/** Set the ACP client info captured during initialize(). */
export function setAcpClientInfo(info: AcpClientInfo): void {
	acpClientInfo = info
}

/** Read the currently known ACP client info, if any. */
export function getAcpClientInfo(): AcpClientInfo | undefined {
	return acpClientInfo
}

/** Reset process-level ACP context. */
export function resetAcpClientInfo(): void {
	acpClientInfo = undefined
}
