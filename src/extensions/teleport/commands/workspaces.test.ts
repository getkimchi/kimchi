import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
	verifyApiKeyMock,
	listWorkspacesMock,
	deleteWorkspaceMock,
	authMock,
	createOrUpdateWorkspaceMock,
	listSessionsMock,
	pickWorkspaceMock,
	runTerminalMock,
} = vi.hoisted(() => ({
	verifyApiKeyMock: vi.fn(),
	listWorkspacesMock: vi.fn(),
	deleteWorkspaceMock: vi.fn(),
	authMock: vi.fn(),
	createOrUpdateWorkspaceMock: vi.fn(),
	listSessionsMock: vi.fn(),
	pickWorkspaceMock: vi.fn(),
	runTerminalMock: vi.fn(),
}))

vi.mock("../../../sandbox/cloud/keys.js", () => ({ verifyApiKey: verifyApiKeyMock }))
vi.mock("../../../sandbox/cloud/workspaces.js", () => ({
	listWorkspaces: listWorkspacesMock,
	deleteWorkspace: deleteWorkspaceMock,
}))
vi.mock("../../../sandbox/cloud/auth.js", () => ({
	authenticateWorkspace: authMock,
	createOrUpdateWorkspace: createOrUpdateWorkspaceMock,
}))
vi.mock("../../../sandbox/worker/client.js", () => ({
	WorkerClient: class {
		creds: { connectToken: string }
		constructor(creds: { connectToken: string }) {
			this.creds = creds
		}
	},
}))
vi.mock("../../../sandbox/worker/sessions.js", () => ({ listSessions: listSessionsMock }))
vi.mock("../ui/workspaces-panel.js", () => ({ pickWorkspace: pickWorkspaceMock }))
vi.mock("./terminal.js", () => ({ runTerminal: runTerminalMock }))

import type { Workspace } from "../../../sandbox/cloud/types.js"
import type { Session } from "../../../sandbox/worker/types.js"
import type { TeleportContext } from "../types.js"
import type { WorkspaceRow } from "../ui/workspaces-table.js"
import { TeleportRefusal } from "./errors.js"
import { collectRows, runWorkspaces } from "./workspaces.js"

const CREDS = {
	connectToken: "tok",
	expiresAt: "2030-01-01T00:00:00Z",
	wsUrl: "wss://host.example",
	host: "host.example",
}

function makeUi(): ExtensionUIContext & {
	notify: ReturnType<typeof vi.fn>
	confirm: ReturnType<typeof vi.fn>
	input: ReturnType<typeof vi.fn>
	setStatus: ReturnType<typeof vi.fn>
} {
	return {
		notify: vi.fn(),
		setStatus: vi.fn(),
		setHeader: vi.fn(),
		setWidget: vi.fn(),
		setTitle: vi.fn(),
		setEditorText: vi.fn(),
		setWorkingMessage: vi.fn(),
		setWorkingVisible: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		setFooter: vi.fn(),
		setEditorComponent: vi.fn(),
		getEditorComponent: vi.fn(),
		getEditorText: vi.fn(),
		pasteToEditor: vi.fn(),
		select: vi.fn(),
		confirm: vi.fn(),
		input: vi.fn(),
		editor: vi.fn(),
		onTerminalInput: vi.fn(() => vi.fn()),
		addAutocompleteProvider: vi.fn(),
		custom: vi.fn(),
		theme: {} as never,
		getAllThemes: vi.fn(() => []),
		getTheme: vi.fn(),
		setTheme: vi.fn(() => ({ success: true })),
		getToolsExpanded: vi.fn(() => false),
		setToolsExpanded: vi.fn(),
	} as unknown as ExtensionUIContext & {
		notify: ReturnType<typeof vi.fn>
		confirm: ReturnType<typeof vi.fn>
		input: ReturnType<typeof vi.fn>
		setStatus: ReturnType<typeof vi.fn>
	}
}

function makeCtx(over: Partial<TeleportContext> = {}): { ctx: TeleportContext; ui: ReturnType<typeof makeUi> } {
	const ui = makeUi()
	const ctx: TeleportContext = {
		apiKey: "test-key",
		endpoint: "https://api.example.com",
		cwd: "/work/proj",
		ui,
		signal: undefined,
		...over,
	}
	return { ctx, ui }
}

function ws(id: string, name: string, over: Partial<Workspace> = {}): Workspace {
	return {
		id,
		name,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		lastActivityAt: new Date("2026-01-01T00:00:00Z"),
		status: "active",
		...over,
	}
}

function session(over: Partial<Session> = {}): Session {
	return {
		name: "s1",
		agentMode: "PTY",
		alive: true,
		agentRunning: false,
		clientConnected: false,
		connectedThroughBridge: false,
		startedAt: null,
		finishedAt: null,
		lastActivityAt: "2026-05-01T00:00:00Z",
		...over,
	}
}

function row(id: string, sessionCount: number | "?" = 0): WorkspaceRow {
	return {
		id,
		name: `name-${id}`,
		status: "active",
		createdAt: new Date("2026-01-01T00:00:00Z"),
		lastActivityAt: new Date("2026-01-01T00:00:00Z"),
		host: "host.example",
		sessionCount,
	}
}

beforeEach(() => {
	verifyApiKeyMock.mockReset()
	listWorkspacesMock.mockReset()
	deleteWorkspaceMock.mockReset()
	authMock.mockReset()
	createOrUpdateWorkspaceMock.mockReset()
	listSessionsMock.mockReset()
	pickWorkspaceMock.mockReset()
	runTerminalMock.mockReset()
})

describe("collectRows", () => {
	it("populates sessionCount from listSessions for each workspace", async () => {
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValueOnce([session(), session(), session()]).mockResolvedValueOnce([session()])
		const { ctx } = makeCtx()

		const rows = await collectRows([ws("w-1", "alpha"), ws("w-2", "beta")], ctx, "proj")

		const counts = Object.fromEntries(rows.map((r) => [r.id, r.sessionCount]))
		expect(counts).toEqual({ "w-1": 3, "w-2": 1 })
	})

	it("marks sessionCount '?' when the worker call rejects", async () => {
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValueOnce([session(), session()]).mockRejectedValueOnce(new Error("unreachable"))
		const { ctx } = makeCtx()

		const rows = await collectRows([ws("w-1", "alpha"), ws("w-2", "beta")], ctx, "proj")

		const counts = Object.fromEntries(rows.map((r) => [r.id, r.sessionCount]))
		expect(counts).toEqual({ "w-1": 2, "w-2": "?" })
	})

	it("excludes ACP, RPC, and completed PTY sessions from sessionCount", async () => {
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValueOnce([
			session({ name: "pty-live", agentMode: "PTY" }),
			session({ name: "pty-also-live", agentMode: "PTY" }),
			session({ name: "pty-done", agentMode: "PTY", finishedAt: "2026-05-01T00:00:00Z" }),
			session({ name: "acp-live", agentMode: "ACP" }),
			session({ name: "rpc-live", agentMode: "RPC" }),
		])
		const { ctx } = makeCtx()

		const rows = await collectRows([ws("w-1", "alpha")], ctx, "proj")

		expect(rows[0]?.sessionCount).toBe(2)
	})

	it("sorts rows by lastActivityAt descending", async () => {
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValue([])
		const { ctx } = makeCtx()

		const older = ws("w-old", "older", { lastActivityAt: new Date("2026-01-01T00:00:00Z") })
		const newer = ws("w-new", "newer", { lastActivityAt: new Date("2026-06-01T00:00:00Z") })

		const rows = await collectRows([older, newer], ctx, "proj")
		expect(rows.map((r) => r.id)).toEqual(["w-new", "w-old"])
	})
})

describe("runWorkspaces", () => {
	it("refuses early when no API key is configured", async () => {
		const { ctx } = makeCtx({ apiKey: "" as unknown as string })
		await expect(runWorkspaces("", ctx)).rejects.toBeInstanceOf(TeleportRefusal)
		expect(verifyApiKeyMock).not.toHaveBeenCalled()
	})

	it("refuses when verifyApiKey fails", async () => {
		verifyApiKeyMock.mockRejectedValue(new Error("bad key"))
		const { ctx } = makeCtx()
		await expect(runWorkspaces("", ctx)).rejects.toBeInstanceOf(TeleportRefusal)
		expect(listWorkspacesMock).not.toHaveBeenCalled()
	})

	it("refuses when listWorkspaces fails on first attempt", async () => {
		verifyApiKeyMock.mockResolvedValue("org-1")
		listWorkspacesMock.mockRejectedValue(new Error("network"))
		const { ctx } = makeCtx()
		await expect(runWorkspaces("", ctx)).rejects.toBeInstanceOf(TeleportRefusal)
		expect(pickWorkspaceMock).not.toHaveBeenCalled()
	})

	it("returns immediately when the picker is dismissed (Esc)", async () => {
		verifyApiKeyMock.mockResolvedValue("org-1")
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValue([])
		pickWorkspaceMock.mockResolvedValue(undefined)
		const { ctx } = makeCtx()

		await runWorkspaces("", ctx)
		expect(runTerminalMock).not.toHaveBeenCalled()
		expect(deleteWorkspaceMock).not.toHaveBeenCalled()
	})

	it("invokes runTerminal on the picked workspace id when action is 'select'", async () => {
		verifyApiKeyMock.mockResolvedValue("org-1")
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValue([])
		pickWorkspaceMock.mockResolvedValue({ action: "select", row: row("w-1") })
		const { ctx } = makeCtx()

		await runWorkspaces("", ctx)
		expect(runTerminalMock).toHaveBeenCalledWith("w-1", ctx)
	})

	it("deletes the workspace via cloud API when confirmed", async () => {
		verifyApiKeyMock.mockResolvedValue("org-42")
		listWorkspacesMock.mockResolvedValueOnce([ws("w-1", "alpha")]).mockResolvedValueOnce([])
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValue([])
		// First call: pick delete; second call: pick Esc to exit the loop.
		pickWorkspaceMock.mockResolvedValueOnce({ action: "delete", row: row("w-1", 2) }).mockResolvedValueOnce(undefined)
		const { ctx, ui } = makeCtx()
		ui.confirm.mockResolvedValue(true)

		await runWorkspaces("", ctx)

		expect(ui.confirm).toHaveBeenCalledWith("Delete workspace", expect.stringContaining("name-w-1"))
		expect(ui.confirm).toHaveBeenCalledWith("Delete workspace", expect.stringContaining("2 sessions"))
		expect(deleteWorkspaceMock).toHaveBeenCalledWith("org-42", "w-1", "test-key", {
			endpoint: "https://api.example.com",
		})
		// loop re-fetches after the delete
		expect(listWorkspacesMock).toHaveBeenCalledTimes(2)
	})

	it("loops back without deleting when the user declines the confirm", async () => {
		verifyApiKeyMock.mockResolvedValue("org-1")
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValue([])
		pickWorkspaceMock.mockResolvedValueOnce({ action: "delete", row: row("w-1", 0) }).mockResolvedValueOnce(undefined)
		const { ctx, ui } = makeCtx()
		ui.confirm.mockResolvedValue(false)

		await runWorkspaces("", ctx)

		expect(deleteWorkspaceMock).not.toHaveBeenCalled()
		// picker invoked twice: first for the delete attempt, then for the Esc that exits
		expect(pickWorkspaceMock).toHaveBeenCalledTimes(2)
	})

	it("warns and continues when deleteWorkspace throws", async () => {
		verifyApiKeyMock.mockResolvedValue("org-1")
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValue([])
		pickWorkspaceMock.mockResolvedValueOnce({ action: "delete", row: row("w-1", 0) }).mockResolvedValueOnce(undefined)
		const { ctx, ui } = makeCtx()
		ui.confirm.mockResolvedValue(true)
		deleteWorkspaceMock.mockRejectedValue(new Error("boom"))

		await runWorkspaces("", ctx)

		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Could not delete workspace"), "warning")
		// loop still re-runs after the warn
		expect(pickWorkspaceMock).toHaveBeenCalledTimes(2)
	})

	it("renames the workspace via createOrUpdateWorkspace when the user types a new name", async () => {
		verifyApiKeyMock.mockResolvedValue("org-42")
		listWorkspacesMock.mockResolvedValueOnce([ws("w-1", "alpha")]).mockResolvedValueOnce([])
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValue([])
		// First call: pick rename; second call: pick Esc to exit the loop.
		pickWorkspaceMock.mockResolvedValueOnce({ action: "rename", row: row("w-1") }).mockResolvedValueOnce(undefined)
		const { ctx, ui } = makeCtx()
		ui.input.mockResolvedValue("renamed-box")
		createOrUpdateWorkspaceMock.mockResolvedValue({ uri: "wss://x", description: "renamed-box" })

		await runWorkspaces("", ctx)

		expect(ui.input).toHaveBeenCalledWith("Rename workspace", "name-w-1")
		expect(createOrUpdateWorkspaceMock).toHaveBeenCalledWith("org-42", "w-1", "test-key", "renamed-box", {
			endpoint: "https://api.example.com",
		})
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Renamed to renamed-box"), "info")
		// loop re-fetched after the rename
		expect(listWorkspacesMock).toHaveBeenCalledTimes(2)
	})

	it("trims whitespace and ignores an empty rename", async () => {
		verifyApiKeyMock.mockResolvedValue("org-1")
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValue([])
		pickWorkspaceMock.mockResolvedValueOnce({ action: "rename", row: row("w-1") }).mockResolvedValueOnce(undefined)
		const { ctx, ui } = makeCtx()
		ui.input.mockResolvedValue("   ")

		await runWorkspaces("", ctx)

		expect(createOrUpdateWorkspaceMock).not.toHaveBeenCalled()
	})

	it("ignores a no-op rename when the new name equals the existing one", async () => {
		verifyApiKeyMock.mockResolvedValue("org-1")
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValue([])
		pickWorkspaceMock.mockResolvedValueOnce({ action: "rename", row: row("w-1") }).mockResolvedValueOnce(undefined)
		const { ctx, ui } = makeCtx()
		ui.input.mockResolvedValue("name-w-1")

		await runWorkspaces("", ctx)

		expect(createOrUpdateWorkspaceMock).not.toHaveBeenCalled()
	})

	it("warns and continues when createOrUpdateWorkspace throws on rename", async () => {
		verifyApiKeyMock.mockResolvedValue("org-1")
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValue([])
		pickWorkspaceMock.mockResolvedValueOnce({ action: "rename", row: row("w-1") }).mockResolvedValueOnce(undefined)
		const { ctx, ui } = makeCtx()
		ui.input.mockResolvedValue("new-name")
		createOrUpdateWorkspaceMock.mockRejectedValue(new Error("boom"))

		await runWorkspaces("", ctx)

		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Could not rename workspace"), "warning")
		expect(pickWorkspaceMock).toHaveBeenCalledTimes(2)
	})

	it("includes the unknown-count suffix in the prompt when sessionCount is '?'", async () => {
		verifyApiKeyMock.mockResolvedValue("org-1")
		listWorkspacesMock.mockResolvedValueOnce([ws("w-1", "alpha")]).mockResolvedValueOnce([])
		authMock.mockResolvedValue(CREDS)
		listSessionsMock.mockResolvedValue([])
		pickWorkspaceMock.mockResolvedValueOnce({ action: "delete", row: row("w-1", "?") }).mockResolvedValueOnce(undefined)
		const { ctx, ui } = makeCtx()
		ui.confirm.mockResolvedValue(true)

		await runWorkspaces("", ctx)

		expect(ui.confirm).toHaveBeenCalledWith("Delete workspace", expect.stringContaining("session count unknown"))
	})
})
