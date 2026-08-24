import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ResourceKind } from "./types.js"

const createResourceManagerMock = vi.hoisted(() =>
	vi.fn((_tui: unknown, _theme: unknown, _done: () => void, kind?: ResourceKind) => ({ kind })),
)
const rtkInstallMocks = vi.hoisted(() => ({
	ensureRtkPath: vi.fn(),
	installRtk: vi.fn(),
	isRtkCommandAvailable: vi.fn(),
	isRtkInstalled: vi.fn(),
	markRtkAutoInstallChecked: vi.fn(),
	shouldCheckRtkAutoInstall: vi.fn(),
}))
const storeMocks = vi.hoisted(() => ({
	isResourceEnabled: vi.fn(),
	setResourceOverride: vi.fn(),
}))

vi.mock("./ui.js", () => ({ createResourceManager: createResourceManagerMock }))
vi.mock("./rtk-install.js", () => rtkInstallMocks)
vi.mock("./store.js", () => storeMocks)

const { default: resourcesExtension } = await import("./extension.js")

type CommandConfig = { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
type ExtensionHandler = (event: unknown, ctx: ExtensionCommandContext) => void | Promise<void>

const originalRtkAutoInstall = process.env.KIMCHI_RTK_AUTO_INSTALL

describe("resourcesExtension", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		storeMocks.isResourceEnabled.mockReturnValue(true)
		rtkInstallMocks.isRtkInstalled.mockReturnValue(false)
		rtkInstallMocks.isRtkCommandAvailable.mockReturnValue(false)
		rtkInstallMocks.shouldCheckRtkAutoInstall.mockReturnValue(true)
		rtkInstallMocks.installRtk.mockResolvedValue({
			version: "v1.0.0",
			binaryPath: "/tmp/rtk",
			linkPath: "/tmp/bin/rtk",
		})
		process.env.KIMCHI_RTK_AUTO_INSTALL = undefined
	})

	afterEach(() => {
		if (originalRtkAutoInstall === undefined) {
			process.env.KIMCHI_RTK_AUTO_INSTALL = undefined
		} else {
			process.env.KIMCHI_RTK_AUTO_INSTALL = originalRtkAutoInstall
		}
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

	it("does not touch a session-start context after async RTK install work completes", async () => {
		const install = deferred<{ version: string; binaryPath: string; linkPath: string }>()
		rtkInstallMocks.installRtk.mockReturnValue(install.promise)
		const { api, handlers } = makeMockPi()
		const { ctx, notify, makeStale } = makeStaleableUIContext()
		resourcesExtension(api)

		handlers.get("session_start")?.({}, ctx)
		makeStale()
		install.resolve({ version: "v1.0.0", binaryPath: "/tmp/rtk", linkPath: "/tmp/bin/rtk" })
		await vi.waitFor(() => expect(rtkInstallMocks.markRtkAutoInstallChecked).toHaveBeenCalledTimes(1))

		expect(notify).toHaveBeenCalledWith("RTK ready at /tmp/bin/rtk", "info")
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

function makeStaleableUIContext(): {
	ctx: ExtensionCommandContext
	notify: ReturnType<typeof vi.fn>
	makeStale: () => void
} {
	let stale = false
	const notify = vi.fn()
	const ui = { notify }
	const ctx = {
		get hasUI() {
			if (stale) throw new Error("stale extension ctx")
			return true
		},
		get ui() {
			if (stale) throw new Error("stale extension ctx")
			return ui
		},
	} as unknown as ExtensionCommandContext
	return {
		ctx,
		notify,
		makeStale: () => {
			stale = true
		},
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}
