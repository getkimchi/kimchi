import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

type TodoCommandMutationHandler = <T>(ctx: ExtensionCommandContext, mutation: () => T) => Promise<T>

const handlers = new Map<string, TodoCommandMutationHandler>()

export function registerTodoCommandMutationHandler(sessionId: string, handler: TodoCommandMutationHandler): () => void {
	handlers.set(sessionId, handler)
	return () => {
		if (handlers.get(sessionId) === handler) handlers.delete(sessionId)
	}
}

export async function runTodoCommandMutation<T>(ctx: ExtensionCommandContext, mutation: () => T): Promise<T> {
	const handler = handlers.get(ctx.sessionManager.getSessionId())
	return handler ? handler(ctx, mutation) : mutation()
}
