import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { authMock, listWorkspacesMock, listSessionsMock, deleteSessionMock, pickSessionMock, runAttachSessionMock } =
	vi.hoisted(() => ({
		authMock: vi.fn(),
		listWorkspacesMock: vi.fn(),
		listSessionsMock: vi.fn(),
		deleteSessionMock: vi.fn(),
		pickSessionMock: vi.fn(),
		runAttachSessionMock: vi.fn(),
	}))

vi.mock("../../../sandbox/cloud/auth.js", () => ({ authenticateWorkspace: authMock }))
vi.mock("../../../sandbox/cloud/workspaces.js", () => ({ listWorkspaces: listWorkspacesMock }))
vi.mock("../../../sandbox/worker/client.js", () => ({
	WorkerClient: class {
		creds: { connectToken: string }
		constructor(creds: { connectToken: string }) {
			this.creds = creds
		}
	},
}))
vi.mock("../../../sandbox/worker/sessions.js", () => ({
	listSessions: listSessionsMock,
	deleteSession: deleteSessionMock,
}))
vi.mock("../ui/sessions-panel.js", () => ({ pickSession: pickSessionMock }))
vi.mock("./attach.js", () => ({ runAttachSession: runAttachSessionMock }))

import type { Workspace } from "../../../sandbox/cloud/types.js"
import type { Session } from "../../../sandbox/worker/types.js"
import type { TeleportContext } from "../types.js"
import type { SessionRow } from "../ui/sessions-table.js"
import { TeleportRefusal } from "./errors.js"
import { deriveStatus, isVisibleSession, runSessions, toRow, unreachableRow } from "./sessions.js"

const CREDS = {
	connectToken: "tok",
	expiresAt: "2030-01-01T00:00:00Z",
	wsUrl: "wss://host.example",
	host: "host.example",
}

function makeUi(): ExtensionUIContext & {
	notify: ReturnType<typeof vi.fn>
	confirm: ReturnType<typeof vi.fn>
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

function ws(id: string, name: string): Workspace {
	return {
		id,
		name,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		lastActivityAt: new Date("2026-01-01T00:00:00Z"),
		status: "active",
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

beforeEach(() => {
	authMock.mockReset().mockResolvedValue(CREDS)
	listWorkspacesMock.mockReset().mockResolvedValue([])
	listSessionsMock.mockReset().mockResolvedValue([])
	deleteSessionMock.mockReset().mockResolvedValue(undefined)
	pickSessionMock.mockReset().mockResolvedValue(undefined)
	runAttachSessionMock.mockReset().mockResolvedValue(undefined)
})

describe("deriveStatus", () => {
	it("returns 'completed' when finishedAt is set", () => {
		expect(deriveStatus(session({ finishedAt: "2026-05-01T00:00:00Z" }))).toBe("completed")
	})
	it("returns 'idle' when not alive", () => {
		expect(deriveStatus(session({ alive: false }))).toBe("idle")
	})
	it("returns 'active' when alive and client connected", () => {
		expect(deriveStatus(session({ alive: true, clientConnected: true }))).toBe("active")
	})
	it("returns 'disconnected' when alive but client not connected", () => {
		expect(deriveStatus(session({ alive: true, clientConnected: false }))).toBe("disconnected")
	})
})

describe("isVisibleSession", () => {
	it("keeps a live PTY session", () => {
		expect(isVisibleSession(session({ agentMode: "PTY", finishedAt: null }))).toBe(true)
	})
	it("keeps a PTY session that's idle (alive=false) as long as it hasn't finished", () => {
		expect(isVisibleSession(session({ agentMode: "PTY", alive: false, finishedAt: null }))).toBe(true)
	})
	it("filters out a PTY session that has finished", () => {
		expect(isVisibleSession(session({ agentMode: "PTY", finishedAt: "2026-05-01T00:00:00Z" }))).toBe(false)
	})
	it("filters out ACP sessions", () => {
		expect(isVisibleSession(session({ agentMode: "ACP" }))).toBe(false)
	})
	it("filters out RPC sessions", () => {
		expect(isVisibleSession(session({ agentMode: "RPC" }))).toBe(false)
	})
})

describe("toRow / unreachableRow", () => {
	it("maps a Session into a SessionRow", () => {
		const row = toRow(ws("w-1", "alpha"), session({ name: "s-1", clientConnected: true }))
		expect(row).toMatchObject({
			workspaceId: "w-1",
			workspaceName: "alpha",
			sessionName: "s-1",
			status: "active",
			clientConnected: true,
		})
		expect(row.lastActivityAt).toBeInstanceOf(Date)
	})

	it("builds an unreachable row from a Workspace", () => {
		expect(unreachableRow(ws("w-2", "beta"))).toEqual({
			workspaceId: "w-2",
			workspaceName: "beta",
			sessionName: "",
			status: "unreachable",
			clientConnected: false,
		})
	})
})

describe("runSessions", () => {
	it("refuses when apiKey is missing", async () => {
		const { ctx, ui } = makeCtx({ apiKey: "" })
		await expect(runSessions("", ctx)).rejects.toBeInstanceOf(TeleportRefusal)
		expect(listWorkspacesMock).not.toHaveBeenCalled()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/API key/), "error")
	})

	it("refuses when listWorkspaces fails", async () => {
		listWorkspacesMock.mockRejectedValue(new Error("net boom"))
		const { ctx, ui } = makeCtx()
		await expect(runSessions("", ctx)).rejects.toBeInstanceOf(TeleportRefusal)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("net boom"), "error")
	})

	it("fans out, merges, and sorts rows by lastActivityAt desc", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha"), ws("w-2", "beta")])
		authMock.mockImplementation(async (id: string) => ({ ...CREDS, connectToken: id }))
		listSessionsMock.mockImplementation(async (client: { creds: { connectToken: string } }) => {
			const wsId = client.creds.connectToken
			if (wsId === "w-1") {
				return [
					session({ name: "old", lastActivityAt: "2026-01-01T00:00:00Z" }),
					session({ name: "newer", lastActivityAt: "2026-05-01T00:00:00Z" }),
				]
			}
			return [session({ name: "newest", lastActivityAt: "2026-06-01T00:00:00Z" })]
		})

		let captured: SessionRow[] = []
		pickSessionMock.mockImplementation(async (_ctx: unknown, rows: SessionRow[]) => {
			captured = rows
			return undefined
		})

		const { ctx } = makeCtx()
		await runSessions("", ctx)

		expect(captured.map((r) => r.sessionName)).toEqual(["newest", "newer", "old"])
		expect(captured.map((r) => r.workspaceName)).toEqual(["beta", "alpha", "alpha"])
	})

	it("filters out ACP, RPC, and completed PTY sessions from the picker rows", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		listSessionsMock.mockResolvedValue([
			session({ name: "pty-live", agentMode: "PTY" }),
			session({ name: "pty-done", agentMode: "PTY", finishedAt: "2026-05-01T00:00:00Z" }),
			session({ name: "acp-live", agentMode: "ACP" }),
			session({ name: "rpc-live", agentMode: "RPC" }),
		])

		let captured: SessionRow[] = []
		pickSessionMock.mockImplementation(async (_ctx: unknown, rows: SessionRow[]) => {
			captured = rows
			return undefined
		})

		const { ctx } = makeCtx()
		await runSessions("", ctx)

		expect(captured.map((r) => r.sessionName)).toEqual(["pty-live"])
	})

	it("renders an unreachable row when authenticateWorkspace fails for one workspace", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-bad", "broken"), ws("w-ok", "fine")])
		authMock.mockImplementation(async (id: string) => {
			if (id === "w-bad") throw new Error("auth fail")
			return CREDS
		})
		listSessionsMock.mockResolvedValue([session({ name: "s-1" })])

		let captured: SessionRow[] = []
		pickSessionMock.mockImplementation(async (_ctx: unknown, rows: SessionRow[]) => {
			captured = rows
			return undefined
		})

		const { ctx } = makeCtx()
		await runSessions("", ctx)

		const unreachable = captured.find((r) => r.status === "unreachable")
		expect(unreachable).toMatchObject({ workspaceId: "w-bad", workspaceName: "broken", sessionName: "" })
		expect(captured.some((r) => r.workspaceName === "fine" && r.sessionName === "s-1")).toBe(true)
	})

	it("renders an unreachable row when listSessions fails for one workspace", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-bad", "broken"), ws("w-ok", "fine")])
		authMock.mockImplementation(async (id: string) => ({ ...CREDS, connectToken: id }))
		listSessionsMock.mockImplementation(async (client: { creds: { connectToken: string } }) => {
			if (client.creds.connectToken === "w-bad") throw new Error("worker boom")
			return [session({ name: "s-2" })]
		})

		let captured: SessionRow[] = []
		pickSessionMock.mockImplementation(async (_ctx: unknown, rows: SessionRow[]) => {
			captured = rows
			return undefined
		})

		const { ctx } = makeCtx()
		await runSessions("", ctx)

		expect(captured.filter((r) => r.status === "unreachable")).toHaveLength(1)
		expect(captured.some((r) => r.sessionName === "s-2")).toBe(true)
	})

	it("places unreachable rows (no lastActivityAt) at the bottom of the sort", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-bad", "broken"), ws("w-ok", "fine")])
		authMock.mockImplementation(async (id: string) => {
			if (id === "w-bad") throw new Error("auth fail")
			return CREDS
		})
		listSessionsMock.mockResolvedValue([session({ name: "s-1" })])

		let captured: SessionRow[] = []
		pickSessionMock.mockImplementation(async (_ctx: unknown, rows: SessionRow[]) => {
			captured = rows
			return undefined
		})

		const { ctx } = makeCtx()
		await runSessions("", ctx)

		expect(captured.at(-1)?.status).toBe("unreachable")
	})

	it("dispatches runAttachSession on Enter", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		listSessionsMock.mockResolvedValue([session({ name: "pick-me" })])
		pickSessionMock.mockResolvedValueOnce({
			action: "open",
			row: {
				workspaceId: "w-1",
				workspaceName: "alpha",
				sessionName: "pick-me",
				status: "active",
				clientConnected: true,
			},
		})

		const { ctx } = makeCtx()
		await runSessions("", ctx)

		expect(runAttachSessionMock).toHaveBeenCalledOnce()
		expect(runAttachSessionMock.mock.calls[0][0]).toEqual({
			workspaceId: "w-1",
			sessionName: "pick-me",
			workspaceName: "alpha",
		})
		expect(runAttachSessionMock.mock.calls[0][1]).toBe(ctx)
	})

	it("deletes a session on 'd' + confirm, then re-renders the picker", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		listSessionsMock.mockResolvedValue([session({ name: "doomed" })])
		pickSessionMock.mockResolvedValueOnce({
			action: "delete",
			row: {
				workspaceId: "w-1",
				workspaceName: "alpha",
				sessionName: "doomed",
				status: "active",
				clientConnected: true,
			},
		})
		pickSessionMock.mockResolvedValueOnce(undefined)

		const { ctx, ui } = makeCtx()
		ui.confirm.mockResolvedValue(true)

		await runSessions("", ctx)

		expect(ui.confirm).toHaveBeenCalledWith("Delete session", expect.stringContaining("doomed"))
		expect(deleteSessionMock).toHaveBeenCalledOnce()
		expect(deleteSessionMock.mock.calls[0][1]).toBe("doomed")
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Deleted doomed"), "info")
		expect(pickSessionMock).toHaveBeenCalledTimes(2)
	})

	it("does not delete when the confirmation is declined; just re-renders", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		listSessionsMock.mockResolvedValue([session({ name: "spare-me" })])
		pickSessionMock.mockResolvedValueOnce({
			action: "delete",
			row: {
				workspaceId: "w-1",
				workspaceName: "alpha",
				sessionName: "spare-me",
				status: "active",
				clientConnected: true,
			},
		})
		pickSessionMock.mockResolvedValueOnce(undefined)

		const { ctx, ui } = makeCtx()
		ui.confirm.mockResolvedValue(false)

		await runSessions("", ctx)

		expect(deleteSessionMock).not.toHaveBeenCalled()
		expect(pickSessionMock).toHaveBeenCalledTimes(2)
	})

	it("warns and re-renders when deleteSession fails", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		listSessionsMock.mockResolvedValue([session({ name: "doomed" })])
		pickSessionMock.mockResolvedValueOnce({
			action: "delete",
			row: {
				workspaceId: "w-1",
				workspaceName: "alpha",
				sessionName: "doomed",
				status: "active",
				clientConnected: true,
			},
		})
		pickSessionMock.mockResolvedValueOnce(undefined)
		deleteSessionMock.mockRejectedValue(new Error("nope"))

		const { ctx, ui } = makeCtx()
		ui.confirm.mockResolvedValue(true)

		await runSessions("", ctx)

		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("nope"), "warning")
		expect(pickSessionMock).toHaveBeenCalledTimes(2)
	})

	it("returns silently when the picker is cancelled", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		pickSessionMock.mockResolvedValue(undefined)

		const { ctx, ui } = makeCtx()
		await runSessions("", ctx)

		expect(runAttachSessionMock).not.toHaveBeenCalled()
		expect(deleteSessionMock).not.toHaveBeenCalled()
		expect(ui.notify).not.toHaveBeenCalled()
	})
})
