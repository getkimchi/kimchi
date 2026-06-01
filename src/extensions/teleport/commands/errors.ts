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

export function warn(ctx: TeleportContext, message: string) {
	ctx.ui.notify(message, "warning")
}

export function info(ctx: TeleportContext, message: string) {
	ctx.ui.notify(message, "info")
}

export function status(ctx: TeleportContext, text: string | undefined) {
	ctx.ui.setStatus(STATUS_KEY, text)
}
