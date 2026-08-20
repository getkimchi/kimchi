import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ResourceKind } from "./types.js"

const createResourceManagerMock = vi.hoisted(() =>
	vi.fn((_tui: unknown, _theme: unknown, _done: () => void, kind?: ResourceKind) => ({ kind })),
)
const storeMocks = vi.hoisted(() => ({
	isResourceEnabled: vi.fn(),
	setResourceOverride: vi.fn(),
}))

vi.mock("./ui.js", () => ({ createResourceManager: createResourceManagerMock }))
vi.mock("./store.js", () => storeMocks)

const { default: resourcesExtension } = await import("./extension.js")

type CommandConfig = { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
type ExtensionHandler = (event: unknown, ctx: ExtensionCommandContext) => void | Promise<void>

describe("resourcesExtension", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		storeMocks.isResourceEnabled.mockReturnValue(true)
	})

	it.each([
		["hooks", "hooks"],
		["plugins", "plugins"],
	] as const)("opens the %s resource menu", async (commandName, kind) => {
		const { api, commands } = makeMockPi()
		const ctx = makeUIContext()
		resourcesExtension(api)

		await commands.get(commandName)?.handler("", ctx)

		expect(createResourceManagerMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.any(Function),
			kind,
		)
	})
})

function makeMockPi(): {
	api: ExtensionAPI
	commands: Map<string, CommandConfig>
	handlers: Map<string, ExtensionHandler>
} {
	const commands = new Map<string, CommandConfig>()
	const handlers = new Map<string, ExtensionHandler>()
	const api = {
		registerCommand: vi.fn((name: string, config: CommandConfig) => {
			commands.set(name, config)
		}),
		on: vi.fn((name: string, handler: ExtensionHandler) => {
			handlers.set(name, handler)
		}),
	} as unknown as ExtensionAPI
	return { api, commands, handlers }
}

function makeUIContext(): ExtensionCommandContext {
	return {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: vi.fn(),
			progress: vi.fn(),
			custom: vi.fn(async (render) => render({}, {}, {}, vi.fn())),
			confirm: vi.fn(),
		},
	} as unknown as ExtensionCommandContext
}
