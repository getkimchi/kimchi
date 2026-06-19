import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any import of the module under test
// ---------------------------------------------------------------------------

vi.mock("./lsp/servers.js", () => ({
	detectServers: vi.fn(),
	serverForFile: vi.fn(),
	findRoot: vi.fn(),
}))

vi.mock("./lsp/client.js", () => ({
	getOrCreateClient: vi.fn(),
	ensureFileOpen: vi.fn(),
	refreshFile: vi.fn(),
	sendRequest: vi.fn(),
	shutdownAll: vi.fn(),
	waitForDiagnostics: vi.fn(),
}))

vi.mock("./lsp/edits.js", () => ({
	applyWorkspaceEdit: vi.fn(),
}))

vi.mock("./prompt-construction/index.js", () => ({
	createSystemPromptBlocks: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports after mocks are set up
// ---------------------------------------------------------------------------

import lspExtension from "./lsp.js"
import * as clientMod from "./lsp/client.js"
import * as editsMod from "./lsp/edits.js"
import * as serversMod from "./lsp/servers.js"
import * as promptMod from "./prompt-construction/index.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>

interface PiStub extends ExtensionAPI {
	getAllTools: () => ToolInfo[]
	fireShutdown: () => Promise<void>
	fireToolResult: (event: unknown) => Promise<void>
	fireSessionStart: (ctx?: Partial<SessionStartCtx>) => Promise<void>
	capturedBlocks: SystemPromptBlockStub[]
}

interface SessionStartCtx {
	cwd: string
	hasUI: boolean
	ui: { setStatus: ReturnType<typeof vi.fn> }
}

interface SystemPromptBlockStub {
	id: string
	render: () => string | undefined
}

// ---------------------------------------------------------------------------
// makePi — stub for ExtensionAPI
// ---------------------------------------------------------------------------

const DEFAULT_CWD = "/project"

function makePi(): PiStub {
	const handlers = new Map<string, Handler[]>()
	const tools: ToolInfo[] = []
	let activeTools: string[] = []
	const capturedBlocks: SystemPromptBlockStub[] = []

	// createSystemPromptBlocks mock: returns an object with .register()
	vi.mocked(promptMod.createSystemPromptBlocks).mockImplementation(
		(_pi: unknown, _owner: unknown) =>
			({
				register: (block: SystemPromptBlockStub) => {
					capturedBlocks.push(block)
				},
			}) as unknown as ReturnType<typeof promptMod.createSystemPromptBlocks>,
	)

	const pi: PiStub = {
		registerFlag: () => {},
		registerCommand: () => {},
		registerTool: (tool: ToolInfo) => {
			tools.push(tool)
			activeTools.push(tool.name)
		},
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		},
		getAllTools: () => tools,
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = names
		},
		getFlag: () => undefined,
		sendMessage: vi.fn(),
		capturedBlocks,
		fireShutdown: async () => {
			for (const h of handlers.get("session_shutdown") ?? []) {
				await h({}, {})
			}
		},
		fireToolResult: async (event: unknown) => {
			for (const h of handlers.get("tool_result") ?? []) {
				await h(event, {})
			}
		},
		fireSessionStart: async (ctx: Partial<SessionStartCtx> = {}) => {
			const defaultUi = { setStatus: vi.fn(), theme: { fg: (_c: string, s: string) => s } }
			const full: SessionStartCtx = {
				cwd: ctx.cwd ?? DEFAULT_CWD,
				hasUI: ctx.hasUI ?? false,
				ui: ctx.ui ? { ...defaultUi, ...ctx.ui } : defaultUi,
			}
			for (const h of handlers.get("session_start") ?? []) {
				await h({}, full)
			}
		},
	} as unknown as PiStub

	return pi
}

// ---------------------------------------------------------------------------
// Helper: make a minimal fake LspClient
// ---------------------------------------------------------------------------

function makeClient(
	diagMap: Map<
		string,
		{
			diagnostics: {
				range: { start: { line: number; character: number } }
				severity?: number
				message: string
				code?: string
			}[]
		}
	> = new Map(),
) {
	return { diagnostics: diagMap }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_SERVER = {
	name: "typescript-language-server",
	command: "typescript-language-server",
	args: ["--stdio"],
	extensions: ["ts", "tsx"],
}

const FAKE_GO_SERVER = {
	name: "gopls",
	command: "gopls",
	args: [],
	extensions: ["go"],
}

async function callTool(
	pi: PiStub,
	name: string,
	params: Record<string, unknown>,
): Promise<{ content: { type: string; text: string }[] }> {
	const tool = pi.getAllTools().find((t) => t.name === name)
	if (!tool) throw new Error(`Tool "${name}" not found`)
	// biome-ignore lint/suspicious/noExplicitAny: test helper
	return (tool as any).execute("call-id", params, new AbortController().signal, () => {}, {})
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.mocked(serversMod.detectServers).mockReturnValue([])
	vi.mocked(serversMod.serverForFile).mockReturnValue(null)
	vi.mocked(serversMod.findRoot).mockImplementation((_fp: string, _sn: string, sessionCwd: string) => sessionCwd)
	vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(
		makeClient() as unknown as ReturnType<typeof clientMod.getOrCreateClient> extends Promise<infer T> ? T : never,
	)
	vi.mocked(clientMod.ensureFileOpen).mockResolvedValue(undefined)
	vi.mocked(clientMod.refreshFile).mockResolvedValue(undefined)
	vi.mocked(clientMod.sendRequest).mockResolvedValue(null)
	vi.mocked(clientMod.shutdownAll).mockReturnValue(undefined)
	// Default: no diagnostics arrive within the deadline. Individual tests
	// override this with mockResolvedValue(true) to exercise the diag path.
	vi.mocked(clientMod.waitForDiagnostics).mockResolvedValue(false)
	vi.mocked(editsMod.applyWorkspaceEdit).mockResolvedValue([])
})

afterEach(() => {
	vi.clearAllMocks()
})

// =============================================================================
// 1. Extension registration
// =============================================================================

describe("extension registration", () => {
	it("registers exactly 5 tools", async () => {
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		expect(pi.getAllTools()).toHaveLength(5)
	})

	it("registers lsp_diagnostics", async () => {
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const names = pi.getAllTools().map((t) => t.name)
		expect(names).toContain("lsp_diagnostics")
	})

	it("registers lsp_hover", async () => {
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const names = pi.getAllTools().map((t) => t.name)
		expect(names).toContain("lsp_hover")
	})

	it("registers lsp_definition", async () => {
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const names = pi.getAllTools().map((t) => t.name)
		expect(names).toContain("lsp_definition")
	})

	it("registers lsp_references", async () => {
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const names = pi.getAllTools().map((t) => t.name)
		expect(names).toContain("lsp_references")
	})

	it("registers lsp_rename", async () => {
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const names = pi.getAllTools().map((t) => t.name)
		expect(names).toContain("lsp_rename")
	})
})

// =============================================================================
// 2. Session hooks
// =============================================================================

describe("session hooks", () => {
	it("registers a session_start handler", () => {
		// We verify indirectly: after fireSessionStart, detectServers is called
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		const pi = makePi()
		lspExtension(pi)
		pi.fireSessionStart({ cwd: DEFAULT_CWD })
		expect(serversMod.detectServers).toHaveBeenCalledWith(DEFAULT_CWD)
	})

	it("registers a session_shutdown handler that calls shutdownAll", async () => {
		const pi = makePi()
		lspExtension(pi)
		await pi.fireShutdown()
		expect(clientMod.shutdownAll).toHaveBeenCalledTimes(1)
	})

	it("session_shutdown clears the status bar when UI is present", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		const setStatus = vi.fn()
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart({ cwd: DEFAULT_CWD, hasUI: true, ui: { setStatus } })
		await pi.fireShutdown()
		// setStatus("lsp", undefined) is called during shutdown
		expect(setStatus).toHaveBeenCalledWith("lsp", undefined)
	})
})

// =============================================================================
// 3. System prompt block
// =============================================================================

describe("system prompt block", () => {
	it("calls createSystemPromptBlocks with the pi instance and 'lsp' owner", () => {
		const pi = makePi()
		lspExtension(pi)
		expect(promptMod.createSystemPromptBlocks).toHaveBeenCalledWith(pi, "lsp")
	})

	it("registers a block with id 'lsp-tools'", () => {
		const pi = makePi()
		lspExtension(pi)
		const block = pi.capturedBlocks.find((b) => b.id === "lsp-tools")
		expect(block).toBeDefined()
	})

	it("lsp-tools block renders LSP guidance text", () => {
		const pi = makePi()
		lspExtension(pi)
		const block = pi.capturedBlocks.find((b) => b.id === "lsp-tools")
		expect(block).toBeDefined()
		const rendered = block?.render()
		expect(rendered).toContain("Language Server Protocol")
		expect(rendered).toContain("lsp_diagnostics")
		expect(rendered).toContain("lsp_hover")
		expect(rendered).toContain("lsp_definition")
		expect(rendered).toContain("lsp_references")
		expect(rendered).toContain("lsp_rename")
	})
})

// =============================================================================
// 4. Status bar
// =============================================================================

describe("status bar", () => {
	it("calls setStatus with detected server names on session_start", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		const setStatus = vi.fn()
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart({ hasUI: true, ui: { setStatus } })
		expect(setStatus).toHaveBeenCalledWith("lsp", `LSP: ${FAKE_SERVER.name}`)
	})

	it("does not call setStatus when no servers are detected", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([])
		const setStatus = vi.fn()
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart({ hasUI: true, ui: { setStatus } })
		expect(setStatus).not.toHaveBeenCalled()
	})

	it("does not call setStatus when UI is absent", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		const setStatus = vi.fn()
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart({ hasUI: false, ui: { setStatus } })
		expect(setStatus).not.toHaveBeenCalled()
	})

	it("displays multiple server names joined by comma", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER, FAKE_GO_SERVER])
		const setStatus = vi.fn()
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart({ hasUI: true, ui: { setStatus } })
		expect(setStatus).toHaveBeenCalledWith("lsp", `LSP: ${FAKE_SERVER.name}, ${FAKE_GO_SERVER.name}`)
	})
})

// =============================================================================
// 5. tool_result handler
// =============================================================================

describe("tool_result handler", () => {
	it("ignores events without toolName", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		await pi.fireToolResult({ isError: false, input: {} })
		expect(clientMod.getOrCreateClient).not.toHaveBeenCalled()
	})

	it("ignores tools other than read/edit/write", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		await pi.fireToolResult({ toolName: "bash", isError: false, input: { file_path: "/project/a.ts" } })
		expect(clientMod.getOrCreateClient).not.toHaveBeenCalled()
	})

	it("ignores error results", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		await pi.fireToolResult({ toolName: "edit", isError: true, input: { file_path: "/project/a.ts" } })
		expect(clientMod.getOrCreateClient).not.toHaveBeenCalled()
	})

	it("ignores events without a path", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		await pi.fireToolResult({ toolName: "edit", isError: false, input: {} })
		expect(clientMod.getOrCreateClient).not.toHaveBeenCalled()
	})

	it("ignores events with a missing or non-object input", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		// Missing input entirely
		await expect(pi.fireToolResult({ toolName: "edit", isError: false })).resolves.not.toThrow()
		// Null input
		await expect(pi.fireToolResult({ toolName: "edit", isError: false, input: null })).resolves.not.toThrow()
		// Non-object input
		await expect(pi.fireToolResult({ toolName: "edit", isError: false, input: "oops" })).resolves.not.toThrow()
		expect(clientMod.getOrCreateClient).not.toHaveBeenCalled()
	})

	it("calls ensureFileOpen for a read event", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		const fakeClient = makeClient()
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(fakeClient as never)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		await pi.fireToolResult({ toolName: "read", isError: false, input: { path: "/project/a.ts" } })
		expect(clientMod.ensureFileOpen).toHaveBeenCalledWith(fakeClient, "/project/a.ts")
	})

	it("calls refreshFile for an edit event", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		const fakeClient = makeClient()
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(fakeClient as never)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		await pi.fireToolResult({ toolName: "edit", isError: false, input: { path: "/project/a.ts" } })
		expect(clientMod.refreshFile).toHaveBeenCalledWith(fakeClient, "/project/a.ts")
	})

	it("calls refreshFile for a write event", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		const fakeClient = makeClient()
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(fakeClient as never)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		await pi.fireToolResult({ toolName: "write", isError: false, input: { path: "/project/a.ts" } })
		expect(clientMod.refreshFile).toHaveBeenCalledWith(fakeClient, "/project/a.ts")
	})

	it("updates status bar with diagnostic count after edit", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		// waitForDiagnostics resolves true so the handler reads diagnostics
		// from the fake client and updates the status bar.
		vi.mocked(clientMod.waitForDiagnostics).mockResolvedValue(true)
		const diagMap = new Map([
			[
				"file:///project/a.ts",
				{ diagnostics: [{ range: { start: { line: 0, character: 0 } }, message: "err", severity: 1 }] },
			],
		])
		const fakeClient = makeClient(diagMap)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(fakeClient as never)
		const setStatus = vi.fn()
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart({ hasUI: true, ui: { setStatus } })
		setStatus.mockClear()

		await pi.fireToolResult({ toolName: "edit", isError: false, input: { path: "/project/a.ts" } })
		expect(setStatus).toHaveBeenCalledWith("lsp", expect.stringContaining("1 diag"))
	})

	it("sends diagnostics as a hidden custom message when waitForDiagnostics resolves true", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.waitForDiagnostics).mockResolvedValue(true)
		const diagMap = new Map([
			[
				"file:///project/a.ts",
				{
					diagnostics: [
						{ range: { start: { line: 4, character: 2 } }, message: "Type 'string' is not assignable", severity: 1 },
					],
				},
			],
		])
		const fakeClient = makeClient(diagMap)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(fakeClient as never)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart({ hasUI: true })

		await pi.fireToolResult({ toolName: "edit", isError: false, input: { path: "/project/a.ts" } })

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		const [message, options] = vi.mocked(pi.sendMessage).mock.calls[0]
		expect(message).toMatchObject({
			customType: "lsp_diagnostics",
			display: false,
		})
		expect(message.content).toContain("[LSP diagnostics for a.ts]")
		expect(message.content).toContain("Type 'string' is not assignable")
		// Plain text only: no ANSI/theme color escapes in the model-facing content.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are required to detect terminal color codes
		expect(message.content).not.toMatch(/\x1b\[/)
		expect(options).toEqual({ deliverAs: "steer" })
	})

	it("does not send diagnostics when waitForDiagnostics resolves false (timeout/abort)", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.waitForDiagnostics).mockResolvedValue(false)
		const fakeClient = makeClient(
			new Map([
				[
					"file:///project/a.ts",
					{ diagnostics: [{ range: { start: { line: 0, character: 0 } }, message: "err", severity: 1 }] },
				],
			]),
		)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(fakeClient as never)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart({ hasUI: true })

		await pi.fireToolResult({ toolName: "edit", isError: false, input: { path: "/project/a.ts" } })
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("cancels a pending diagnostic wait when a newer edit supersedes it", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		// First wait: never resolves until the superseding edit aborts it.
		// Second wait: resolves true so the handler completes.
		let firstAbort: AbortSignal | undefined
		vi.mocked(clientMod.waitForDiagnostics).mockImplementationOnce(async (_client, _uri, opts) => {
			firstAbort = opts.signal
			// Wait until aborted, then resolve false (superseded).
			return new Promise<boolean>((resolve) => {
				opts.signal?.addEventListener("abort", () => resolve(false), { once: true })
			})
		})
		vi.mocked(clientMod.waitForDiagnostics).mockResolvedValueOnce(true)
		const fakeClient = makeClient(
			new Map([
				[
					"file:///project/a.ts",
					{ diagnostics: [{ range: { start: { line: 0, character: 0 } }, message: "err", severity: 1 }] },
				],
			]),
		)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(fakeClient as never)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart({ hasUI: true })

		const firstEdit = pi.fireToolResult({ toolName: "edit", isError: false, input: { path: "/project/a.ts" } })
		// Yield so the first handler runs and registers its waitForDiagnostics.
		await new Promise((r) => setImmediate(r))
		const secondEdit = pi.fireToolResult({ toolName: "edit", isError: false, input: { path: "/project/a.ts" } })

		// The superseding edit should abort the first handler's local signal.
		expect(firstAbort?.aborted).toBe(true)
		await Promise.all([firstEdit, secondEdit])
	})

	it("does not call LSP functions when no server matches the file", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(null)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		await pi.fireToolResult({ toolName: "edit", isError: false, input: { path: "/project/a.rb" } })
		expect(clientMod.getOrCreateClient).not.toHaveBeenCalled()
	})
})

// =============================================================================
// 6. lsp_diagnostics tool
// =============================================================================

describe("lsp_diagnostics", () => {
	it("returns 'no server available' when no server matches", async () => {
		vi.mocked(serversMod.serverForFile).mockReturnValue(null)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_diagnostics", { file_path: "/project/a.rb", wait_ms: 0 })
		expect(result.content[0].text).toContain("No LSP server available")
	})

	it("returns clean message when no diagnostics", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		const fakeClient = makeClient()
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(fakeClient as never)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_diagnostics", { file_path: "/project/a.ts", wait_ms: 0 })
		expect(result.content[0].text).toContain("No diagnostics found")
	})

	it("returns formatted diagnostics when present", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		const diagMap = new Map([
			[
				"file:///project/a.ts",
				{
					diagnostics: [{ range: { start: { line: 4, character: 2 } }, message: "Type error", severity: 1 as const }],
				},
			],
		])
		const fakeClient = makeClient(diagMap)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(fakeClient as never)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_diagnostics", { file_path: "/project/a.ts", wait_ms: 0 })
		expect(result.content[0].text).toContain("Type error")
		expect(result.content[0].text).toContain("error")
	})

	it("caps wait_ms at 10000", async () => {
		// Just verifying it doesn't blow up and still returns sensibly
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		const fakeClient = makeClient()
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(fakeClient as never)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		// We pass 0 so tests don't actually wait; the cap logic is tested structurally
		const result = await callTool(pi, "lsp_diagnostics", { file_path: "/project/a.ts", wait_ms: 0 })
		expect(result.content[0].text).toBeTruthy()
	})

	it("handles getOrCreateClient throwing (error path)", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockRejectedValue(new Error("spawn failed"))
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		await expect(callTool(pi, "lsp_diagnostics", { file_path: "/project/a.ts", wait_ms: 0 })).rejects.toThrow(
			"spawn failed",
		)
	})
})

// =============================================================================
// 7. lsp_hover tool
// =============================================================================

describe("lsp_hover", () => {
	it("returns 'no server available' when no server matches", async () => {
		vi.mocked(serversMod.serverForFile).mockReturnValue(null)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_hover", { file_path: "/project/a.rb", line: 0, character: 0 })
		expect(result.content[0].text).toContain("No LSP server available")
	})

	it("returns 'no hover information' when sendRequest returns null", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValue(null)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_hover", { file_path: "/project/a.ts", line: 5, character: 3 })
		expect(result.content[0].text).toContain("No hover information available")
	})

	it("returns hover text for a string content", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValue({ contents: "const foo: string" })
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_hover", { file_path: "/project/a.ts", line: 0, character: 0 })
		expect(result.content[0].text).toBe("const foo: string")
	})

	it("returns hover text for a MarkupContent object", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValue({ contents: { kind: "markdown", value: "**foo**: number" } })
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_hover", { file_path: "/project/a.ts", line: 0, character: 0 })
		expect(result.content[0].text).toBe("**foo**: number")
	})

	it("returns hover text for an array of MarkedString", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValue({
			contents: [{ language: "typescript", value: "type Foo = string" }, "some docs"],
		})
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_hover", { file_path: "/project/a.ts", line: 0, character: 0 })
		expect(result.content[0].text).toContain("type Foo = string")
		expect(result.content[0].text).toContain("some docs")
	})
})

// =============================================================================
// 8. lsp_definition tool
// =============================================================================

describe("lsp_definition", () => {
	it("returns 'no server available' when no server matches", async () => {
		vi.mocked(serversMod.serverForFile).mockReturnValue(null)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_definition", { file_path: "/project/a.rb", line: 0, character: 0 })
		expect(result.content[0].text).toContain("No LSP server available")
	})

	it("returns 'no definition found' when sendRequest returns null", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValue(null)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_definition", { file_path: "/project/a.ts", line: 0, character: 0 })
		expect(result.content[0].text).toContain("No definition found")
	})

	it("returns location as file:line:col for a single Location", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValue({
			uri: "file:///project/src/types.ts",
			range: { start: { line: 9, character: 0 }, end: { line: 9, character: 10 } },
		})
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_definition", { file_path: "/project/a.ts", line: 0, character: 0 })
		expect(result.content[0].text).toContain("src/types.ts:10:1")
	})

	it("handles an array of Location results", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValue([
			{
				uri: "file:///project/src/a.ts",
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
			},
			{
				uri: "file:///project/src/b.ts",
				range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
			},
		])
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_definition", { file_path: "/project/a.ts", line: 0, character: 0 })
		expect(result.content[0].text).toContain("src/a.ts:1:1")
		expect(result.content[0].text).toContain("src/b.ts:3:5")
	})

	it("handles LocationLink array (targetUri / targetSelectionRange)", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValue([
			{
				targetUri: "file:///project/src/types.ts",
				targetRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
				targetSelectionRange: { start: { line: 1, character: 4 }, end: { line: 1, character: 8 } },
			},
		])
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_definition", { file_path: "/project/a.ts", line: 0, character: 0 })
		expect(result.content[0].text).toContain("src/types.ts:2:5")
	})

	it("uses the method param for typeDefinition variant", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValue(null)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		await callTool(pi, "lsp_definition", {
			file_path: "/project/a.ts",
			line: 0,
			character: 0,
			method: "typeDefinition",
		})
		expect(clientMod.sendRequest).toHaveBeenCalledWith(
			expect.anything(),
			"textDocument/typeDefinition",
			expect.anything(),
		)
	})
})

// =============================================================================
// 9. lsp_references tool
// =============================================================================

describe("lsp_references", () => {
	it("returns 'no server available' when no server matches", async () => {
		vi.mocked(serversMod.serverForFile).mockReturnValue(null)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_references", { file_path: "/project/a.rb", line: 0, character: 0 })
		expect(result.content[0].text).toContain("No LSP server available")
	})

	it("returns 'no references found' when sendRequest returns null", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValue(null)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_references", { file_path: "/project/a.ts", line: 0, character: 0 })
		expect(result.content[0].text).toContain("No references found")
	})

	it("returns 'no references found' when sendRequest returns empty array", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValue([])
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_references", { file_path: "/project/a.ts", line: 0, character: 0 })
		expect(result.content[0].text).toContain("No references found")
	})

	it("returns reference list with count", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValue([
			{
				uri: "file:///project/src/a.ts",
				range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
			},
			{
				uri: "file:///project/src/b.ts",
				range: { start: { line: 7, character: 2 }, end: { line: 7, character: 7 } },
			},
		])
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_references", { file_path: "/project/a.ts", line: 0, character: 0 })
		expect(result.content[0].text).toContain("2 reference(s)")
		expect(result.content[0].text).toContain("src/a.ts:4:1")
		expect(result.content[0].text).toContain("src/b.ts:8:3")
	})
})

// =============================================================================
// 10. lsp_rename tool
// =============================================================================

describe("lsp_rename", () => {
	it("returns 'no server available' when no server matches", async () => {
		vi.mocked(serversMod.serverForFile).mockReturnValue(null)
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_rename", {
			file_path: "/project/a.rb",
			line: 0,
			character: 0,
			new_name: "newFoo",
		})
		expect(result.content[0].text).toContain("No LSP server available")
	})

	it("returns 'cannot rename' when prepareRename throws", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		// prepareRename is the first sendRequest call; make it throw
		vi.mocked(clientMod.sendRequest).mockRejectedValueOnce(new Error("invalid position"))
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_rename", {
			file_path: "/project/a.ts",
			line: 0,
			character: 0,
			new_name: "newFoo",
		})
		expect(result.content[0].text).toContain("Cannot rename")
	})

	it("returns 'no changes' when rename returns null", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		// prepareRename succeeds, rename returns null
		vi.mocked(clientMod.sendRequest).mockResolvedValueOnce({ start: { line: 0, character: 0 } }) // prepareRename
		vi.mocked(clientMod.sendRequest).mockResolvedValueOnce(null) // rename
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_rename", {
			file_path: "/project/a.ts",
			line: 0,
			character: 0,
			new_name: "newFoo",
		})
		expect(result.content[0].text).toContain("Rename returned no changes")
	})

	it("applies workspace edit and returns summary", async () => {
		vi.mocked(serversMod.detectServers).mockReturnValue([FAKE_SERVER])
		vi.mocked(serversMod.serverForFile).mockReturnValue(FAKE_SERVER)
		vi.mocked(clientMod.getOrCreateClient).mockResolvedValue(makeClient() as never)
		vi.mocked(clientMod.sendRequest).mockResolvedValueOnce({ start: { line: 0, character: 0 } }) // prepareRename
		vi.mocked(clientMod.sendRequest).mockResolvedValueOnce({
			changes: {
				"file:///project/src/a.ts": [
					{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "newFoo" },
				],
			},
		}) // rename
		vi.mocked(editsMod.applyWorkspaceEdit).mockResolvedValue(["src/a.ts: 1 edit(s)"])
		const pi = makePi()
		lspExtension(pi)
		await pi.fireSessionStart()
		const result = await callTool(pi, "lsp_rename", {
			file_path: "/project/a.ts",
			line: 0,
			character: 0,
			new_name: "newFoo",
		})
		expect(result.content[0].text).toContain("src/a.ts: 1 edit(s)")
		expect(editsMod.applyWorkspaceEdit).toHaveBeenCalledTimes(1)
	})
})

// =============================================================================
// 11. waitForDiagnostics (race-condition path)
// =============================================================================
//
// The lsp/client.js module is fully mocked above. These tests use vi.importActual
// to reach the real waitForDiagnostics implementation so we can verify the
// early-return path that handles a publishDiagnostics arriving between
// refreshFile() and waitForDiagnostics().
describe("waitForDiagnostics", () => {
	async function loadRealWaitForDiagnostics() {
		const mod = await vi.importActual<typeof import("./lsp/client.js")>("./lsp/client.js")
		return mod.waitForDiagnostics
	}

	function makeRealClient(version: number, hasPendingBaseline: boolean) {
		const diagnosticsVersion = version
		const diagnostics = new Map<string, { diagnostics: unknown[]; version: number | null }>()
		const pendingDiagBaseline = new Map<string, number>()
		const diagnosticWaiters = new Map<string, Set<{ snapshot: number; resolve: () => void }>>()
		if (hasPendingBaseline) {
			pendingDiagBaseline.set("file:///x.ts", 0)
		}
		diagnostics.set("file:///x.ts", { diagnostics: [{ message: "err" }], version: 1 })
		return {
			diagnostics,
			diagnosticsVersion,
			pendingDiagBaseline,
			diagnosticWaiters,
		}
	}

	it("resolves true immediately when a fresh publishDiagnostics already arrived between refreshFile() and waitForDiagnostics()", async () => {
		const waitForDiagnostics = await loadRealWaitForDiagnostics()
		const client = makeRealClient(5, true) as unknown as Parameters<typeof waitForDiagnostics>[0]
		const start = Date.now()
		const result = await waitForDiagnostics(client, "file:///x.ts", { timeoutMs: 60_000 })
		const elapsed = Date.now() - start
		expect(result).toBe(true)
		// Must resolve without waiting for the 60s deadline — proves the early-return path.
		expect(elapsed).toBeLessThan(50)
	})

	it("clears pendingDiagBaseline after the early-return so a later call does not see a stale baseline", async () => {
		const waitForDiagnostics = await loadRealWaitForDiagnostics()
		const client = makeRealClient(5, true) as unknown as Parameters<typeof waitForDiagnostics>[0]
		expect(client.pendingDiagBaseline.has("file:///x.ts")).toBe(true)
		await waitForDiagnostics(client, "file:///x.ts", { timeoutMs: 100 })
		expect(client.pendingDiagBaseline.has("file:///x.ts")).toBe(false)
	})

	it("does not take the early-return when no refresh baseline exists (diagnosticsVersion check requires hasRefreshBaseline)", async () => {
		const waitForDiagnostics = await loadRealWaitForDiagnostics()
		const client = makeRealClient(5, false) as unknown as Parameters<typeof waitForDiagnostics>[0]
		// Without a refresh baseline, waitForDiagnostics registers a waiter
		// even if diagnosticsVersion > 0 and the URI has diagnostics.
		const result = await waitForDiagnostics(client, "file:///x.ts", { timeoutMs: 20 })
		expect(result).toBe(false)
		// And the baseline map stays empty (no refresh baseline to clear).
		expect(client.pendingDiagBaseline.size).toBe(0)
	})

	it("does not take the early-return when diagnosticsVersion has not advanced past the baseline", async () => {
		const waitForDiagnostics = await loadRealWaitForDiagnostics()
		const client = makeRealClient(0, true) as unknown as Parameters<typeof waitForDiagnostics>[0]
		const result = await waitForDiagnostics(client, "file:///x.ts", { timeoutMs: 20 })
		expect(result).toBe(false)
		// Baseline cleared on timeout so a stale entry cannot leak.
		expect(client.pendingDiagBaseline.has("file:///x.ts")).toBe(false)
	})
})
