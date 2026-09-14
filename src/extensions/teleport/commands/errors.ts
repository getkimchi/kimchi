import { RemoteQuotaError } from "../../../sandbox/cloud/types.js"
import { STATUS_KEY, type TeleportContext } from "../types.js"

export class TeleportRefusal extends Error {
	constructor(message: string) {
		super(message)
		this.name = "TeleportRefusal"
	}
}

export function refuse(ctx: TeleportContext, message: string): never {
	ctx.ui.setStatus(STATUS_KEY, undefined)
	ctx.ui.notify(message, "error")
	throw new TeleportRefusal(message)
}

/**
 * Message shown when authenticateWorkspace() throws. Quota errors already
 * carry final user-facing text ("Unable to provision workspace: …") and are
 * passed through verbatim; anything else keeps the historical
 * "Authentication failed: …" framing.
 */
export function authFailureMessage(err: unknown): string {
	if (err instanceof RemoteQuotaError) return err.message
	return `Authentication failed: ${err instanceof Error ? err.message : String(err)}`
}

export function warn(ctx: TeleportContext, message: string) {
	ctx.ui.notify(message, "warning")
}

export function info(ctx: TeleportContext, message: string) {
	ctx.ui.notify(message, "info")
}

export function status(ctx: TeleportContext, text: string | undefined) {
	ctx.ui.setStatus(STATUS_KEY, text)
}
