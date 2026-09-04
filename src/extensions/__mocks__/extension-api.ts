import type { ExtensionAPI, ExtensionHandler } from "@earendil-works/pi-coding-agent"
import { vi } from "vitest"

type RegisteredHandler = ExtensionHandler<unknown, unknown>

export function createExtensionApi(): {
	api: ExtensionAPI
	getHandler<E, R = undefined>(event: string): ExtensionHandler<E, R>
	getHandlers<E, R = undefined>(event: string): ExtensionHandler<E, R>[]
	getRegisteredTool(name: string): Parameters<ExtensionAPI["registerTool"]>[0]
	sendMessage: ReturnType<typeof vi.fn<ExtensionAPI["sendMessage"]>>
	appendEntry: ReturnType<typeof vi.fn<ExtensionAPI["appendEntry"]>>
	setModel: ReturnType<typeof vi.fn<ExtensionAPI["setModel"]>>
	emitEvent: ReturnType<typeof vi.fn>
	getAppendedEntries<T = unknown>(type: string): T[]
} {
	const handlers = new Map<string, RegisteredHandler[]>()
	const on = vi.fn((event: string, handler: RegisteredHandler) => {
		const registered = handlers.get(event) ?? []
		registered.push(handler)
		handlers.set(event, registered)
	})
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>()
	const appendedEntries: Array<{ type: string; payload: unknown }> = []
	const appendEntry = vi.fn((type: string, payload: unknown) => {
		appendedEntries.push({ type, payload })
	})
	const setModel = vi.fn<ExtensionAPI["setModel"]>(async () => true)
	const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>()
	const registerTool = vi.fn<ExtensionAPI["registerTool"]>()
	const emitEvent = vi.fn()

	return {
		api: {
			on,
			registerCommand,
			registerTool,
			sendMessage,
			appendEntry,
			setModel,
			events: { emit: emitEvent },
		} as unknown as ExtensionAPI,
		getHandler<E, R = undefined>(event: string): ExtensionHandler<E, R> {
			const handler = handlers.get(event)?.[0]
			if (!handler) throw new Error(`Extension did not register a ${event} handler`)
			return handler as ExtensionHandler<E, R>
		},
		getHandlers<E, R = undefined>(event: string): ExtensionHandler<E, R>[] {
			return (handlers.get(event) ?? []) as ExtensionHandler<E, R>[]
		},
		getRegisteredTool(name: string): Parameters<ExtensionAPI["registerTool"]>[0] {
			const call = registerTool.mock.calls.find(([tool]) => tool.name === name)
			if (!call) throw new Error(`Tool ${name} was not registered`)
			return call[0]
		},
		sendMessage,
		setModel,
		emitEvent,
		appendEntry: appendEntry as unknown as ReturnType<typeof vi.fn<ExtensionAPI["appendEntry"]>>,
		getAppendedEntries<T = unknown>(type: string): T[] {
			return appendedEntries.filter((entry) => entry.type === type).map((entry) => entry.payload as T)
		},
	}
}
