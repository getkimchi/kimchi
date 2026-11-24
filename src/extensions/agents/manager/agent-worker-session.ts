import type { AgentSession } from "@earendil-works/pi-coding-agent"

export type AgentWorkerSessionBindings = Partial<
	Pick<Parameters<AgentSession["bindExtensions"]>[0], "mode" | "uiContext">
>

export interface AgentWorkerSession {
	bindings: AgentWorkerSessionBindings
	cleanup: () => void
}

export type AgentWorkerSessionAdapter = (childSessionId: string, parentSessionId: string) => AgentWorkerSession

const adapters: Array<{ parentSessionId: string; create: AgentWorkerSessionAdapter }> = []

/** Let a session host contribute UI bindings for its workers without the
 * runner importing the host domain. The returned cleanup ends host ownership;
 * worker registration cleanup belongs to the resulting AgentWorkerSession. */
export function registerAgentWorkerSessionAdapter(
	parentSessionId: string,
	create: AgentWorkerSessionAdapter,
): () => void {
	const registration = { parentSessionId, create }
	adapters.push(registration)
	let cleaned = false
	return () => {
		if (cleaned) return
		cleaned = true
		const index = adapters.indexOf(registration)
		if (index >= 0) adapters.splice(index, 1)
	}
}

/** Select the owner's latest adapter and otherwise keep a worker headless. */
export function prepareAgentWorkerSession(childSessionId: string, parentSessionId: string): AgentWorkerSession {
	const adapter = adapters.findLast((candidate) => candidate.parentSessionId === parentSessionId)
	if (!adapter) return { bindings: {}, cleanup: () => {} }
	const session = adapter.create(childSessionId, parentSessionId)
	let cleaned = false
	return {
		bindings: session.bindings,
		cleanup: () => {
			if (cleaned) return
			cleaned = true
			session.cleanup()
		},
	}
}

/** Test-only lifecycle reset. Production cleanup is registration-scoped. */
export function resetAgentWorkerSessionAdaptersForTests(): void {
	adapters.length = 0
}
