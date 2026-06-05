import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { ResourceKind } from "./types.js"

const createResourceManagerMock = vi.hoisted(() =>
	vi.fn((_tui: unknown, _theme: unknown, _done: () => void, kind?: ResourceKind) => ({ kind })),
)

vi.mock("./ui.js", () => ({ createResourceManager: createResourceManagerMock }))

const { default: resourcesExtension } = await import("./extension.js")

type CommandConfig = { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }

describe("resourcesExtension", () => {
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

function makeMockPi(): { api: ExtensionAPI; commands: Map<string, CommandConfig> } {
	const commands = new Map<string, CommandConfig>()
	const api = {
		registerCommand: vi.fn((name: string, config: CommandConfig) => {
			commands.set(name, config)
		}),
		on: vi.fn(),
	} as unknown as ExtensionAPI
	return { api, commands }
}

function makeUIContext(): ExtensionCommandContext {
	return {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			progress: vi.fn(),
			custom: vi.fn(async (render) => render({}, {}, {}, vi.fn())),
			confirm: vi.fn(),
		},
	} as unknown as ExtensionCommandContext
}
