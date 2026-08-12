import type { ExtensionAPI, ExtensionHandler } from "@earendil-works/pi-coding-agent"
import { vi } from "vitest"

type RegisteredHandler = ExtensionHandler<unknown, unknown>

export function createExtensionApi(overrides: Partial<ExtensionAPI> = {}): {
	api: ExtensionAPI
	getHandler<E, R = undefined>(event: string): ExtensionHandler<E, R>
	getHandlers<E, R = undefined>(event: string): Array<ExtensionHandler<E, R>>
	sendMessage: ReturnType<typeof vi.fn<ExtensionAPI["sendMessage"]>>
} {
	const handlers = new Map<string, RegisteredHandler[]>()
	const on = vi.fn((event: string, handler: RegisteredHandler) => {
		const registered = handlers.get(event) ?? []
		registered.push(handler)
		handlers.set(event, registered)
	})
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>()

	return {
		api: { ...overrides, on, sendMessage } as ExtensionAPI,
		getHandler<E, R = undefined>(event: string): ExtensionHandler<E, R> {
			const handler = handlers.get(event)?.[0]
			if (!handler) throw new Error(`Extension did not register a ${event} handler`)
			return handler as ExtensionHandler<E, R>
		},
		getHandlers<E, R = undefined>(event: string): Array<ExtensionHandler<E, R>> {
			return (handlers.get(event) ?? []) as Array<ExtensionHandler<E, R>>
		},
		sendMessage,
	}
}
