import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const openMock = vi.hoisted(() => vi.fn<(_url: string) => Promise<void>>())
const getVersionMock = vi.hoisted(() => vi.fn(() => "9.9.9-test"))

vi.mock("open", () => ({ default: openMock }))
vi.mock("../utils.js", () => ({ getVersion: getVersionMock }))

const { default: reportBugExtension } = await import("./report-bug.js")

type CommandConfig = { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }

function makeMockPi(): { api: ExtensionAPI; commands: Map<string, CommandConfig> } {
	const commands = new Map<string, CommandConfig>()
	const api: ExtensionAPI = {
		registerCommand: vi.fn((name: string, config: CommandConfig) => {
			commands.set(name, config)
		}),
		registerTool: vi.fn(),
		on: vi.fn(),
		getRegisteredTools: vi.fn(),
		removeTool: vi.fn(),
		getApiKey: vi.fn(),
		addMessage: vi.fn(),
		getModel: vi.fn(),
		setModel: vi.fn(),
		getSelectedModels: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: vi.fn(),
		setFlag: vi.fn(),
		getContextualInfo: vi.fn(),
		registerMCPClient: vi.fn(),
		getMcpClient: vi.fn(),
		getMcpClients: vi.fn(),
		removeMcpClient: vi.fn(),
		sendSystemPrompt: vi.fn(),
		getSystemPrompt: vi.fn(),
		setSystemPrompt: vi.fn(),
		getSetting: vi.fn(),
		setSetting: vi.fn(),
		enableDisableTool: vi.fn(),
		getToolEnabledStatus: vi.fn(),
		validateTool: vi.fn(),
		customInstruction: vi.fn(),
		sendThinking: vi.fn(),
		getLastUserMessage: vi.fn(),
		enableSkill: vi.fn(),
		disableSkill: vi.fn(),
		getSkills: vi.fn(),
		toggleSkill: vi.fn(),
		translate: vi.fn(),
		importFromUrl: vi.fn(),
	} as unknown as ExtensionAPI
	return { api, commands }
}

function makeUIContext(): ExtensionCommandContext {
	return {
		hasUI: true,
		ui: { notify: vi.fn(), progress: vi.fn(), custom: vi.fn() },
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
	} as any
}

function makeHeadlessContext(): ExtensionCommandContext {
	return {
		hasUI: false,
		ui: { notify: vi.fn(), progress: vi.fn(), custom: vi.fn() },
		// biome-ignore lint/suspicious/noExplicitAny: minimal mock
	} as any
}

describe("reportBugExtension", () => {
	beforeEach(() => {
		openMock.mockClear()
		getVersionMock.mockClear()
		getVersionMock.mockReturnValue("9.9.9-test")
		vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("registers the 'reportbug' command", () => {
		const { api, commands } = makeMockPi()
		reportBugExtension(api)
		expect(commands.has("reportbug")).toBe(true)
		expect(commands.get("reportbug")?.description).toBe("Report a bug in kimchi — opens GitHub issue form")
	})

	it("builds URL with required params when called without args (UI mode)", async () => {
		const { api, commands } = makeMockPi()
		reportBugExtension(api)

		const command = commands.get("reportbug")
		if (command === undefined) {
			throw new Error("reportbug command not registered")
		}
		const handler = command.handler
		const ctx = makeUIContext()
		openMock.mockResolvedValue(undefined)

		await handler("", ctx)

		expect(openMock).toHaveBeenCalledTimes(1)
		const url = openMock.mock.calls[0][0] as string
		expect(url).toMatch(/^https:\/\/github\.com\/getkimchi\/kimchi\/issues\/new\?/)
		expect(url).toContain("template=bug_report.yml")
		expect(url).toContain("labels=bug")
		expect(url).toContain("version=9.9.9-test")
		expect(url).not.toContain("title=")
		expect(url).not.toContain("description=")
	})

	it("encodes user args into title and description (UI mode)", async () => {
		const { api, commands } = makeMockPi()
		reportBugExtension(api)

		const command = commands.get("reportbug")
		if (command === undefined) {
			throw new Error("reportbug command not registered")
		}
		const handler = command.handler
		const ctx = makeUIContext()
		openMock.mockResolvedValue(undefined)

		await handler("Something is broken", ctx)

		expect(openMock).toHaveBeenCalledTimes(1)
		const url = openMock.mock.calls[0][0] as string
		expect(url).toContain("title=Something+is+broken")
		expect(url).toContain("description=Something+is+broken")
	})

	it("escapes special characters in args correctly", async () => {
		const { api, commands } = makeMockPi()
		reportBugExtension(api)

		const command = commands.get("reportbug")
		if (command === undefined) {
			throw new Error("reportbug command not registered")
		}
		const handler = command.handler
		const ctx = makeUIContext()
		openMock.mockResolvedValue(undefined)

		await handler("crash & burn: 100%", ctx)

		const url = openMock.mock.calls[0][0] as string
		// URLSearchParams encodes & as %26, % as %25, space as +.
		expect(url).toContain("title=crash+%26+burn%3A+100%25")
	})

	it("falls back to console.log in headless mode without opening browser", async () => {
		const { api, commands } = makeMockPi()
		reportBugExtension(api)

		const command = commands.get("reportbug")
		if (command === undefined) {
			throw new Error("reportbug command not registered")
		}
		const handler = command.handler
		const ctx = makeHeadlessContext()

		await handler("headless test", ctx)

		expect(openMock).not.toHaveBeenCalled()
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("https://github.com/getkimchi/kimchi/issues/new"))
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("headless+test"))
	})

	it("shows error notification and prints URL when open() throws (UI mode)", async () => {
		const { api, commands } = makeMockPi()
		reportBugExtension(api)

		const command = commands.get("reportbug")
		if (command === undefined) {
			throw new Error("reportbug command not registered")
		}
		const handler = command.handler
		const ctx = makeUIContext()
		openMock.mockRejectedValue(new Error("No browser found"))

		await handler("fail case", ctx)

		expect(openMock).toHaveBeenCalledTimes(1)
		const notify = (ctx.ui as unknown as { notify: ReturnType<typeof vi.fn> }).notify
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Failed to open browser"), "error")
	})
})
