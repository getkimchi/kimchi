// Marks the time a slash-command handler runs, per session, so a surface
// that cannot show notifications (ACP plain clients) can send them as reply
// text instead.
//
// The scope is a per-session counter, not AsyncLocalStorage. A handler that
// queues a turn starts that turn inside its own async context, so async
// context would follow the turn and mirror the run's later notifications.
// A counter ends when the handler's promise settles.
//
// No imports from src/modes/: extensions open the scope and ACP reads it.

const activeScopes = new Map<string, number>()

export async function withCommandReplyScope<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
	activeScopes.set(sessionId, (activeScopes.get(sessionId) ?? 0) + 1)
	try {
		return await run()
	} finally {
		const remaining = (activeScopes.get(sessionId) ?? 1) - 1
		if (remaining > 0) activeScopes.set(sessionId, remaining)
		else activeScopes.delete(sessionId)
	}
}

export function isInCommandReplyScope(sessionId: string): boolean {
	return activeScopes.has(sessionId)
}

export function resetCommandReplyScopesForTests(): void {
	activeScopes.clear()
}
