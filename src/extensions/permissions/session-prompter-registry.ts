import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { ToolPermissionPrompter } from "./prompter.js"

/**
 * A session host's permission interaction. Resolution is deliberately lazy:
 * a worker can acquire direct interaction after its initial registration,
 * without rebinding the session or moving an in-flight request.
 */
export interface SessionPermissionPrompterSource {
	canPromptDirectly(ctx: ExtensionContext): boolean
	resolve(ctx: ExtensionContext): ToolPermissionPrompter | undefined
}

const sources = new Map<string, SessionPermissionPrompterSource[]>()

function latest(sessionId: string): SessionPermissionPrompterSource | undefined {
	const values = sources.get(sessionId)
	return values?.[values.length - 1]
}

/** Register a session's interaction without making the host's transport part
 * of the generic permission policy. Registrations stack for session reattach;
 * removing an older registration must not evict its live successor. */
export function registerSessionPermissionPrompter(
	sessionId: string,
	source: SessionPermissionPrompterSource,
): () => void {
	const values = sources.get(sessionId) ?? []
	values.push(source)
	sources.set(sessionId, values)
	let cleaned = false
	return () => {
		if (cleaned) return
		cleaned = true
		const index = values.lastIndexOf(source)
		if (index === -1) return
		values.splice(index, 1)
		if (values.length === 0) sources.delete(sessionId)
	}
}

export function canPromptThroughSession(ctx: ExtensionContext): boolean {
	return latest(ctx.sessionManager.getSessionId())?.canPromptDirectly(ctx) === true
}

export function resolveSessionPermissionPrompter(ctx: ExtensionContext): ToolPermissionPrompter | undefined {
	return latest(ctx.sessionManager.getSessionId())?.resolve(ctx)
}

/** Test-only lifecycle reset. Production cleanup is registration-scoped. */
export function resetSessionPermissionPromptersForTests(): void {
	sources.clear()
}
