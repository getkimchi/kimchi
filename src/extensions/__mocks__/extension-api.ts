import type { ExtensionAPI, ExtensionHandler, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { vi } from "vitest"
import { createMiniEventBus } from "./mini-event-bus.js"

type RegisteredHandler = ExtensionHandler<unknown, unknown>

export function createExtensionApi(): {
	api: ExtensionAPI
	getHandler<E, R = undefined>(event: string): ExtensionHandler<E, R>
	getHandlers<E, R = undefined>(event: string): ExtensionHandler<E, R>[]
	getRegisteredTool(name: string): Parameters<ExtensionAPI["registerTool"]>[0]
	sendMessage: ReturnType<typeof vi.fn<ExtensionAPI["sendMessage"]>>
	appendEntry: ReturnType<typeof vi.fn<ExtensionAPI["appendEntry"]>>
	setModel: ReturnType<typeof vi.fn<ExtensionAPI["setModel"]>>
	registerEntryRenderer: ReturnType<typeof vi.fn<ExtensionAPI["registerEntryRenderer"]>>
	getEntryRenderer(customType: string): Parameters<ExtensionAPI["registerEntryRenderer"]>[1]
	emitEvent: ReturnType<typeof vi.fn>
	registerTool: ReturnType<typeof vi.fn<ExtensionAPI["registerTool"]>>
	setActiveTools: ReturnType<typeof vi.fn<ExtensionAPI["setActiveTools"]>>
	getRegisteredTools(): ToolDefinition[]
	getActiveToolNames(): string[]
	getAppendedEntries<T = unknown>(type: string): T[]
} {
	const handlers = new Map<string, RegisteredHandler[]>()
	const on = vi.fn((event: string, handler: RegisteredHandler) => {
		const registered = handlers.get(event) ?? []
		registered.push(handler)
		handlers.set(event, registered)
	})
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>()
	const registerEntryRenderer = vi.fn<ExtensionAPI["registerEntryRenderer"]>()
	const appendedEntries: Array<{ type: string; payload: unknown }> = []
	const appendEntry = vi.fn((type: string, payload: unknown) => {
		appendedEntries.push({ type, payload })
	})
	const setModel = vi.fn<ExtensionAPI["setModel"]>(async () => true)
	const registerCommand = vi.fn<ExtensionAPI["registerCommand"]>()
	const registerFlag = vi.fn<ExtensionAPI["registerFlag"]>()
	const registeredTools = new Map<string, ToolDefinition>()
	const activeToolNames = new Set<string>()
	const registerTool = vi.fn((tool: ToolDefinition) => {
		registeredTools.set(tool.name, tool)
		activeToolNames.add(tool.name)
	}) as ReturnType<typeof vi.fn<ExtensionAPI["registerTool"]>>
	const setActiveTools = vi.fn((toolNames: string[]) => {
		activeToolNames.clear()
		for (const name of toolNames) activeToolNames.add(name)
	})
	const getActiveTools = vi.fn(() => [...activeToolNames])
	const getAllTools = vi.fn(() => [...registeredTools.values()])
	const { events, emit } = createMiniEventBus()

	return {
		api: {
			on,
			registerCommand,
			registerFlag,
			registerTool,
			getAllTools,
			getActiveTools,
			setActiveTools,
			sendMessage,
			appendEntry,
			setModel,
			registerEntryRenderer,
			events,
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
		registerEntryRenderer,
		getEntryRenderer(customType: string): Parameters<ExtensionAPI["registerEntryRenderer"]>[1] {
			const call = registerEntryRenderer.mock.calls.find(([type]) => type === customType)
			if (!call) throw new Error(`No entry renderer registered for ${customType}`)
			return call[1]
		},
		emitEvent: emit,
		registerTool,
		setActiveTools,
		getRegisteredTools: () => [...registeredTools.values()],
		getActiveToolNames: () => [...activeToolNames],
		appendEntry: appendEntry as unknown as ReturnType<typeof vi.fn<ExtensionAPI["appendEntry"]>>,
		getAppendedEntries<T = unknown>(type: string): T[] {
			return appendedEntries.filter((entry) => entry.type === type).map((entry) => entry.payload as T)
		},
	}
}
