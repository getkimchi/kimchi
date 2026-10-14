import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ResourceKind } from "./types.js"

const createResourceManagerMock = vi.hoisted(() =>
	vi.fn((_tui: unknown, _theme: unknown, _done: () => void, kind?: ResourceKind) => ({ kind })),
)
const storeMocks = vi.hoisted(() => ({
	isResourceEnabled: vi.fn(),
	isResourceLocked: vi.fn(),
	setResourceOverride: vi.fn(),
	orgLockMessage: vi.fn(),
}))

vi.mock("./ui.js", () => ({ createResourceManager: createResourceManagerMock }))
vi.mock("./store.js", () => storeMocks)

const { default: resourcesExtension } = await import("./extension.js")

type CommandConfig = { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }

describe("resourcesExtension", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		storeMocks.isResourceEnabled.mockReturnValue(true)
		storeMocks.isResourceLocked.mockReturnValue(false)
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

	describe("org-lock refusals", () => {
		const LOCKED_WARNING = "tools.web_search is locked off by your organization; it cannot be enabled locally."

		// mockReturnValue implementations survive clearAllMocks, so each test in
		// this group re-pins the unlocked default; refusals override to locked.
		beforeEach(() => {
			storeMocks.isResourceLocked.mockReturnValue(false)
		})

		it.each([
			"enable tools.web_search",
			"disable tools.web_search",
			"set tools.web_search on",
		])("refuses '%s' on an org-locked resource with a warning and no write", async (args) => {
			storeMocks.isResourceLocked.mockReturnValue(true)
			storeMocks.orgLockMessage.mockImplementation(
				(id: string) => `${id} is locked off by your organization; it cannot be enabled locally.`,
			)
			const { api, commands } = makeMockPi()
			const ctx = makeUIContext()
			resourcesExtension(api)

			await commands.get("resources")?.handler(args, ctx)

			expect(ctx.ui.notify).toHaveBeenCalledWith(LOCKED_WARNING, "warning")
			// The refusal preempts the write: the store guard is never reached.
			expect(storeMocks.setResourceOverride).not.toHaveBeenCalled()
		})

		it("still toggles resources the org policy does not lock", async () => {
			const { api, commands } = makeMockPi()
			const ctx = makeUIContext()
			resourcesExtension(api)

			await commands.get("resources")?.handler("enable tools.web_search", ctx)

			expect(storeMocks.setResourceOverride).toHaveBeenCalledWith("tools.web_search", true)
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("by your organization"), "warning")
		})
	})
})

function makeMockPi(): {
	api: ExtensionAPI
	commands: Map<string, CommandConfig>
} {
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
		mode: "tui",
		ui: {
			notify: vi.fn(),
			progress: vi.fn(),
			custom: vi.fn(async (render) => render({}, {}, {}, vi.fn())),
			confirm: vi.fn(),
		},
	} as unknown as ExtensionCommandContext
}
