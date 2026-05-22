import type { RemoteAgentSession } from "../proxy/agent-session.js"
import type { DetachArgs } from "./args.js"
import { info, refuse, status, warn } from "./errors.js"
import { readSessionId, readSessionName } from "./session-resolve.js"
import type { TeleportContext } from "./types.js"

async function rebindAfterSwap(ctx: TeleportContext): Promise<void> {
	if (!ctx.triggerRebind) return
	try {
		await ctx.triggerRebind()
	} catch (err) {
		warn(ctx, `Session rebind failed: ${err instanceof Error ? err.message : String(err)}`)
	}
}

async function refreshUIAfterSwap(ctx: TeleportContext): Promise<void> {
	if (ctx.triggerFreshUI) {
		try {
			ctx.triggerFreshUI()
		} catch (err) {
			warn(ctx, `UI refresh failed: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	await rebindAfterSwap(ctx)
}

export async function runDetach(_args: DetachArgs, ctx: TeleportContext): Promise<void> {
	const wrapper = ctx.wrapper
	if (wrapper.isForegroundHomeBase) {
		refuse(ctx, "Not connected to a remote session.")
	}

	const remote = wrapper.foreground as unknown as RemoteAgentSession
	const sessionId = readSessionId(remote) ?? "<unknown>"
	const name = readSessionName(remote)

	// Detach immediately regardless of whether the remote agent is streaming,
	// running bash, or has pending messages. The server-side session continues
	// working independently; /attach reconnects and replays full message
	// history via getMessages(). No need to wait or abort.

	status(ctx, "Disconnecting\u2026")
	try {
		;(remote as unknown as { dispose: () => void }).dispose()
	} catch (err) {
		warn(ctx, `WS shutdown error: ${err instanceof Error ? err.message : String(err)} (continuing)`)
	}

	wrapper.detachToHomeBase()
	await refreshUIAfterSwap(ctx)

	status(ctx, undefined)
	const hint = name ? `/attach ${name}` : `/attach ${sessionId.slice(0, 8)}`
	info(ctx, `Detached from session ${sessionId}. Reattach with ${hint}.`)
}
