import type { ExtensionAPI, ExtensionContext, ExtensionHandler } from "@earendil-works/pi-coding-agent"
import { vi } from "vitest"

type RegisteredHandler = ExtensionHandler<unknown, unknown>

export function createExtensionApi(): {
	api: ExtensionAPI
	getHandler<E, R = undefined>(event: string): ExtensionHandler<E, R>
	getHandlers<E, R = undefined>(event: string): ExtensionHandler<E, R>[]
	/** Invoke every handler registered for `event`, awaiting each in turn; returns their results. */
	emit(event: string, payload: unknown, ctx?: ExtensionContext): Promise<unknown[]>
	sendMessage: ReturnType<typeof vi.fn<ExtensionAPI["sendMessage"]>>
	registerTool: ReturnType<typeof vi.fn<ExtensionAPI["registerTool"]>>
	registerCommand: ReturnType<typeof vi.fn<ExtensionAPI["registerCommand"]>>
	emitEvent: ReturnType<typeof vi.fn>
} {
	const handlers = new Map<string, RegisteredHandler[]>()
	const on = vi.fn((event: string, handler: RegisteredHandler) => {
		const registered = handlers.get(event) ?? []
		registered.push(handler)
		handlers.set(event, registered)
	})
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>()
	const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>()
	const registerTool = vi.fn<ExtensionAPI["registerTool"]>()
	const emitEvent = vi.fn()

	return {
		api: { on, registerCommand, registerTool, sendMessage, events: { emit: emitEvent } } as unknown as ExtensionAPI,
		getHandler<E, R = undefined>(event: string): ExtensionHandler<E, R> {
			const handler = handlers.get(event)?.[0]
			if (!handler) throw new Error(`Extension did not register a ${event} handler`)
			return handler as ExtensionHandler<E, R>
		},
		getHandlers<E, R = undefined>(event: string): ExtensionHandler<E, R>[] {
			return (handlers.get(event) ?? []) as ExtensionHandler<E, R>[]
		},
		async emit(event: string, payload: unknown, ctx?: ExtensionContext): Promise<unknown[]> {
			const results: unknown[] = []
			for (const handler of handlers.get(event) ?? []) {
				results.push(await handler(payload, ctx as ExtensionContext))
			}
			return results
		},
		sendMessage,
		registerTool,
		registerCommand,
		emitEvent,
	}
}
