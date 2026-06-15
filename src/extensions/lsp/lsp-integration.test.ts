/**
 * Integration tests for the LSP extension (src/extensions/lsp.ts).
 *
 * Covers:
 *   - Step 2: System prompt block text content
 *   - Step 3: Status bar set/clear lifecycle
 *   - Step 4: tool_result handler routes "read" to ensureFileOpen
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mocks for LSP client functions and server helpers
// ---------------------------------------------------------------------------

const mockEnsureFileOpen = vi.fn().mockResolvedValue(undefined)
const mockRefreshFile = vi.fn().mockResolvedValue(undefined)
const mockGetOrCreateClient = vi.fn()
const mockShutdownAll = vi.fn()
const mockDetectServers = vi.fn()
const mockServerForFile = vi.fn()
const mockApplyWorkspaceEdit = vi.fn()
const mockCreateSystemPromptBlocks = vi.fn()
const mockRegister = vi.fn()

vi.mock("../lsp/client.js", () => ({
	ensureFileOpen: mockEnsureFileOpen,
	refreshFile: mockRefreshFile,
	getOrCreateClient: mockGetOrCreateClient,
	shutdownAll: mockShutdownAll,
	sendRequest: vi.fn(),
}))

vi.mock("../lsp/edits.js", () => ({
	applyWorkspaceEdit: mockApplyWorkspaceEdit,
}))

vi.mock("../lsp/servers.js", () => ({
	detectServers: mockDetectServers,
	findRoot: vi.fn((f: string) => f),
	serverForFile: mockServerForFile,
}))

vi.mock("../prompt-construction/index.js", () => ({
	createSystemPromptBlocks: mockCreateSystemPromptBlocks,
}))

// ---------------------------------------------------------------------------
// Minimal pi fake
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown, ctx: unknown) => Promise<void> | void

function makePiFake() {
	const handlers: Record<string, EventHandler[]> = {}
	const pi = {
		on(eventName: string, handler: EventHandler) {
			handlers[eventName] ??= []
			handlers[eventName].push(handler)
		},
		registerTool: vi.fn(),
		async emit(eventName: string, event: unknown, ctx: unknown) {
			for (const h of handlers[eventName] ?? []) {
				await h(event, ctx)
			}
		},
	}
	return pi
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(name: string) {
	return { name, extensions: [".ts"] }
}

function makeFakeClient(diagMap: Map<string, { diagnostics: unknown[] }>) {
	return { diagnostics: diagMap }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LSP extension — system prompt block", () => {
	it("registers a system prompt block with id 'lsp-tools' under owner 'lsp'", async () => {
		mockCreateSystemPromptBlocks.mockReturnValue({ register: mockRegister })
		mockDetectServers.mockReturnValue([])

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		expect(mockCreateSystemPromptBlocks).toHaveBeenCalledWith(pi, "lsp")
		expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ id: "lsp-tools" }))
	})

	it("rendered prompt block mentions all five LSP tools", async () => {
		let capturedBlock: { id: string; render: () => string } | undefined
		mockCreateSystemPromptBlocks.mockReturnValue({
			register: (block: { id: string; render: () => string }) => {
				capturedBlock = block
			},
		})
		mockDetectServers.mockReturnValue([])

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		expect(capturedBlock).toBeDefined()
		const text = (capturedBlock as NonNullable<typeof capturedBlock>).render()
		expect(text).toContain("lsp_diagnostics")
		expect(text).toContain("lsp_hover")
		expect(text).toContain("lsp_definition")
		expect(text).toContain("lsp_references")
		expect(text).toContain("lsp_rename")
	})
})

describe("LSP extension — status bar (Step 3)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockCreateSystemPromptBlocks.mockReturnValue({ register: vi.fn() })
	})

	it("sets status bar with server names on session_start when servers detected", async () => {
		const servers = [makeServer("typescript-language-server"), makeServer("gopls")]
		mockDetectServers.mockReturnValue(servers)

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		const setStatus = vi.fn()
		const ctx = {
			cwd: "/repo",
			hasUI: true,
			ui: { setStatus },
		}

		await pi.emit("session_start", {}, ctx)

		expect(setStatus).toHaveBeenCalledWith("lsp", "LSP: typescript-language-server, gopls")
	})

	it("does not set status bar when no UI available", async () => {
		mockDetectServers.mockReturnValue([makeServer("gopls")])

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		const setStatus = vi.fn()
		const ctx = {
			cwd: "/repo",
			hasUI: false,
			ui: { setStatus },
		}

		await pi.emit("session_start", {}, ctx)

		expect(setStatus).not.toHaveBeenCalled()
	})

	it("does not set status bar when no servers detected", async () => {
		mockDetectServers.mockReturnValue([])

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		const setStatus = vi.fn()
		const ctx = {
			cwd: "/repo",
			hasUI: true,
			ui: { setStatus },
		}

		await pi.emit("session_start", {}, ctx)

		expect(setStatus).not.toHaveBeenCalled()
	})

	it("clears status bar with undefined on session_shutdown", async () => {
		mockDetectServers.mockReturnValue([makeServer("gopls")])

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		const setStatus = vi.fn()
		const ctx = {
			cwd: "/repo",
			hasUI: true,
			ui: { setStatus },
		}

		await pi.emit("session_start", {}, ctx)
		setStatus.mockClear()

		await pi.emit("session_shutdown", {}, {})

		expect(setStatus).toHaveBeenCalledWith("lsp", undefined)
	})

	it("updates status bar with diagnostic count after a write tool result", async () => {
		const server = makeServer("gopls")
		mockDetectServers.mockReturnValue([server])
		mockServerForFile.mockReturnValue(server)

		// Client with 3 diagnostics across two files
		const diagMap = new Map([
			["file:///repo/a.go", { diagnostics: [{}, {}] }],
			["file:///repo/b.go", { diagnostics: [{}] }],
		])
		const fakeClient = makeFakeClient(diagMap)
		mockGetOrCreateClient.mockResolvedValue(fakeClient)
		mockRefreshFile.mockResolvedValue(undefined)

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		const setStatus = vi.fn()
		const startCtx = { cwd: "/repo", hasUI: true, ui: { setStatus } }
		await pi.emit("session_start", {}, startCtx)
		setStatus.mockClear()

		const toolResultEvent = {
			toolName: "write",
			isError: false,
			input: { path: "/repo/a.go" },
		}
		await pi.emit("tool_result", toolResultEvent, {})

		expect(setStatus).toHaveBeenCalledWith("lsp", "LSP: gopls (3 diags)")
	})

	it("omits diagnostic count when zero diagnostics", async () => {
		const server = makeServer("gopls")
		mockDetectServers.mockReturnValue([server])
		mockServerForFile.mockReturnValue(server)

		const fakeClient = makeFakeClient(new Map())
		mockGetOrCreateClient.mockResolvedValue(fakeClient)
		mockRefreshFile.mockResolvedValue(undefined)

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		const setStatus = vi.fn()
		const startCtx = { cwd: "/repo", hasUI: true, ui: { setStatus } }
		await pi.emit("session_start", {}, startCtx)
		setStatus.mockClear()

		const toolResultEvent = {
			toolName: "edit",
			isError: false,
			input: { file_path: "/repo/main.go" },
		}
		await pi.emit("tool_result", toolResultEvent, {})

		expect(setStatus).toHaveBeenCalledWith("lsp", "LSP: gopls")
	})

	it("uses singular 'diag' for exactly one diagnostic", async () => {
		const server = makeServer("typescript-language-server")
		mockDetectServers.mockReturnValue([server])
		mockServerForFile.mockReturnValue(server)

		const diagMap = new Map([["file:///repo/src/index.ts", { diagnostics: [{}] }]])
		const fakeClient = makeFakeClient(diagMap)
		mockGetOrCreateClient.mockResolvedValue(fakeClient)
		mockRefreshFile.mockResolvedValue(undefined)

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		const setStatus = vi.fn()
		const startCtx = { cwd: "/repo", hasUI: true, ui: { setStatus } }
		await pi.emit("session_start", {}, startCtx)
		setStatus.mockClear()

		const toolResultEvent = {
			toolName: "edit",
			isError: false,
			input: { file_path: "/repo/src/index.ts" },
		}
		await pi.emit("tool_result", toolResultEvent, {})

		expect(setStatus).toHaveBeenCalledWith("lsp", "LSP: typescript-language-server (1 diag)")
	})
})

describe("LSP extension — read tool hook (Step 4)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockCreateSystemPromptBlocks.mockReturnValue({ register: vi.fn() })
	})

	it("calls ensureFileOpen (not refreshFile) for read tool events", async () => {
		const server = makeServer("typescript-language-server")
		mockDetectServers.mockReturnValue([server])
		mockServerForFile.mockReturnValue(server)

		const fakeClient = makeFakeClient(new Map())
		mockGetOrCreateClient.mockResolvedValue(fakeClient)

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		const ctx = { cwd: "/repo", hasUI: false, ui: { setStatus: vi.fn() } }
		await pi.emit("session_start", {}, ctx)

		const toolResultEvent = {
			toolName: "read",
			isError: false,
			input: { file_path: "/repo/src/index.ts" },
		}
		await pi.emit("tool_result", toolResultEvent, {})

		expect(mockEnsureFileOpen).toHaveBeenCalledWith(fakeClient, "/repo/src/index.ts")
		expect(mockRefreshFile).not.toHaveBeenCalled()
	})

	it("uses input.path when input.file_path is absent for read events", async () => {
		const server = makeServer("gopls")
		mockDetectServers.mockReturnValue([server])
		mockServerForFile.mockReturnValue(server)

		const fakeClient = makeFakeClient(new Map())
		mockGetOrCreateClient.mockResolvedValue(fakeClient)

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		const ctx = { cwd: "/repo", hasUI: false, ui: { setStatus: vi.fn() } }
		await pi.emit("session_start", {}, ctx)

		const toolResultEvent = {
			toolName: "read",
			isError: false,
			input: { path: "/repo/main.go" },
		}
		await pi.emit("tool_result", toolResultEvent, {})

		expect(mockEnsureFileOpen).toHaveBeenCalledWith(fakeClient, "/repo/main.go")
	})

	it("skips read events that have errors", async () => {
		const server = makeServer("gopls")
		mockDetectServers.mockReturnValue([server])
		mockServerForFile.mockReturnValue(server)

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		const ctx = { cwd: "/repo", hasUI: false, ui: { setStatus: vi.fn() } }
		await pi.emit("session_start", {}, ctx)

		const toolResultEvent = {
			toolName: "read",
			isError: true,
			input: { file_path: "/repo/src/index.ts" },
		}
		await pi.emit("tool_result", toolResultEvent, {})

		expect(mockEnsureFileOpen).not.toHaveBeenCalled()
		expect(mockGetOrCreateClient).not.toHaveBeenCalled()
	})

	it("skips read events when no server handles the file", async () => {
		const server = makeServer("gopls")
		mockDetectServers.mockReturnValue([server])
		mockServerForFile.mockReturnValue(null) // no server for this file

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		const ctx = { cwd: "/repo", hasUI: false, ui: { setStatus: vi.fn() } }
		await pi.emit("session_start", {}, ctx)

		const toolResultEvent = {
			toolName: "read",
			isError: false,
			input: { file_path: "/repo/README.md" },
		}
		await pi.emit("tool_result", toolResultEvent, {})

		expect(mockEnsureFileOpen).not.toHaveBeenCalled()
	})

	it("does not update status bar after a read tool event", async () => {
		const server = makeServer("gopls")
		mockDetectServers.mockReturnValue([server])
		mockServerForFile.mockReturnValue(server)

		const fakeClient = makeFakeClient(new Map([["file:///repo/main.go", { diagnostics: [{}] }]]))
		mockGetOrCreateClient.mockResolvedValue(fakeClient)

		const { default: lspExtension } = await import("../lsp.js")
		const pi = makePiFake()
		lspExtension(pi as never)

		const setStatus = vi.fn()
		const ctx = { cwd: "/repo", hasUI: true, ui: { setStatus } }
		await pi.emit("session_start", {}, ctx)
		setStatus.mockClear() // clear the session_start call

		const toolResultEvent = {
			toolName: "read",
			isError: false,
			input: { file_path: "/repo/main.go" },
		}
		await pi.emit("tool_result", toolResultEvent, {})

		// ensureFileOpen was called, but no status bar update for reads
		expect(mockEnsureFileOpen).toHaveBeenCalled()
		expect(setStatus).not.toHaveBeenCalled()
	})
})
