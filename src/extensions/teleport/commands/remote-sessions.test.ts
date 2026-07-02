import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
	authMock,
	verifyApiKeyMock,
	listWorkspacesMock,
	deleteWorkspaceMock,
	createOrUpdateWorkspaceMock,
	listSessionsMock,
	deleteSessionMock,
	pickRemoteSessionsMock,
	runAttachSessionMock,
	runTerminalMock,
	ensureIncludeDirectiveMock,
	syncSshConfigMock,
} = vi.hoisted(() => ({
	authMock: vi.fn(),
	verifyApiKeyMock: vi.fn(),
	listWorkspacesMock: vi.fn(),
	deleteWorkspaceMock: vi.fn(),
	createOrUpdateWorkspaceMock: vi.fn(),
	listSessionsMock: vi.fn(),
	deleteSessionMock: vi.fn(),
	pickRemoteSessionsMock: vi.fn(),
	runAttachSessionMock: vi.fn(),
	runTerminalMock: vi.fn(),
	ensureIncludeDirectiveMock: vi.fn(),
	syncSshConfigMock: vi.fn(),
}))

vi.mock("../../../sandbox/cloud/auth.js", () => ({
	authenticateWorkspace: authMock,
	createOrUpdateWorkspace: createOrUpdateWorkspaceMock,
}))
vi.mock("../../../sandbox/cloud/keys.js", () => ({ verifyApiKey: verifyApiKeyMock }))
vi.mock("../../../sandbox/cloud/workspaces.js", () => ({
	listWorkspaces: listWorkspacesMock,
	deleteWorkspace: deleteWorkspaceMock,
}))
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
vi.mock("../ui/remote-sessions-panel.js", () => ({ pickRemoteSessions: pickRemoteSessionsMock }))
vi.mock("./attach.js", () => ({ runAttachSession: runAttachSessionMock }))
vi.mock("./terminal.js", () => ({ runTerminal: runTerminalMock }))
vi.mock("../ssh-config/sync.js", () => ({
	ensureIncludeDirective: ensureIncludeDirectiveMock,
	syncSshConfig: syncSshConfigMock,
}))

import type { Workspace } from "../../../sandbox/cloud/types.js"
import type { Session } from "../../../sandbox/worker/types.js"
import type { TeleportContext } from "../types.js"
import type { RemoteWorkspaceNode } from "../ui/remote-sessions-panel.js"
import { TeleportRefusal } from "./errors.js"
import { buildTree, deriveStatus, runRemoteSessions, toRow } from "./remote-sessions.js"

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

function workspaceNode(over: Partial<RemoteWorkspaceNode> = {}): RemoteWorkspaceNode {
	return {
		row: {
			id: "w-1",
			name: "alpha",
			status: "active",
			sessionCount: 1,
			...over.row,
		},
		sessions: over.sessions ?? [],
		unreachable: over.unreachable ?? false,
	}
}

beforeEach(() => {
	authMock.mockReset().mockResolvedValue(CREDS)
	verifyApiKeyMock.mockReset().mockResolvedValue("org-1")
	listWorkspacesMock.mockReset().mockResolvedValue([])
	deleteWorkspaceMock.mockReset().mockResolvedValue(undefined)
	createOrUpdateWorkspaceMock.mockReset().mockResolvedValue({ uri: "u", description: "d" })
	listSessionsMock.mockReset().mockResolvedValue([])
	deleteSessionMock.mockReset().mockResolvedValue(undefined)
	pickRemoteSessionsMock.mockReset().mockResolvedValue(undefined)
	runAttachSessionMock.mockReset().mockResolvedValue(undefined)
	runTerminalMock.mockReset().mockResolvedValue(undefined)
	ensureIncludeDirectiveMock.mockReset().mockResolvedValue(undefined)
	syncSshConfigMock.mockReset().mockResolvedValue(undefined)
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
	it("returns 'disconnected' when alive and no client", () => {
		expect(deriveStatus(session({ alive: true, clientConnected: false }))).toBe("disconnected")
	})
})

describe("toRow", () => {
	it("maps a session onto a SessionRow with workspace foreign keys", () => {
		const row = toRow(ws("w-1", "alpha"), session({ name: "s-1", clientConnected: true }))
		expect(row).toMatchObject({
			workspaceId: "w-1",
			workspaceName: "alpha",
			sessionName: "s-1",
			status: "active",
			clientConnected: true,
		})
	})
})

describe("buildTree", () => {
	it("counts visible sessions and nests them under their workspace", async () => {
		listSessionsMock.mockResolvedValue([
			session({ name: "v-1", agentMode: "PTY" }),
			session({ name: "rpc", agentMode: "RPC" }), // filtered out
		])
		const { ctx } = makeCtx()
		const nodes = await buildTree([ws("w-1", "alpha")], ctx, "proj")
		expect(nodes).toHaveLength(1)
		expect(nodes[0]?.unreachable).toBe(false)
		expect(nodes[0]?.row.sessionCount).toBe(1)
		expect(nodes[0]?.sessions.map((s) => s.sessionName)).toEqual(["v-1"])
	})

	it("marks a workspace unreachable when listing sessions fails", async () => {
		authMock.mockImplementation(async (id: string) => {
			if (id === "w-2") throw new Error("nope")
			return CREDS
		})
		const { ctx } = makeCtx()
		const nodes = await buildTree([ws("w-1", "alpha"), ws("w-2", "beta")], ctx, "proj")
		const beta = nodes.find((n) => n.row.id === "w-2")
		expect(beta?.unreachable).toBe(true)
		expect(beta?.row.sessionCount).toBe("?")
		expect(beta?.sessions).toEqual([])
	})
})

describe("runRemoteSessions", () => {
	it("refuses without an API key", async () => {
		const { ctx } = makeCtx({ apiKey: undefined })
		await expect(runRemoteSessions("", ctx)).rejects.toBeInstanceOf(TeleportRefusal)
	})

	it("refuses when API key verification fails", async () => {
		verifyApiKeyMock.mockRejectedValue(new Error("bad key"))
		const { ctx } = makeCtx()
		await expect(runRemoteSessions("", ctx)).rejects.toBeInstanceOf(TeleportRefusal)
	})

	it("syncs ssh config and returns when the picker is dismissed", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		pickRemoteSessionsMock.mockResolvedValue(undefined)
		const { ctx } = makeCtx()
		await runRemoteSessions("", ctx)
		expect(ensureIncludeDirectiveMock).toHaveBeenCalled()
		expect(syncSshConfigMock).toHaveBeenCalled()
	})

	it("opens the SSH terminal on action='open-terminal' and returns", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		pickRemoteSessionsMock.mockResolvedValue({ action: "open-terminal", node: workspaceNode() })
		const { ctx } = makeCtx()
		await runRemoteSessions("", ctx)
		expect(runTerminalMock).toHaveBeenCalledWith("w-1", ctx)
		expect(pickRemoteSessionsMock).toHaveBeenCalledTimes(1)
	})

	it("attaches the kimchi PTY on action='open-session' and returns", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		pickRemoteSessionsMock.mockResolvedValue({
			action: "open-session",
			node: { workspaceId: "w-1", workspaceName: "alpha", sessionName: "s-1", status: "active", clientConnected: true },
		})
		const { ctx } = makeCtx()
		await runRemoteSessions("", ctx)
		expect(runAttachSessionMock).toHaveBeenCalledWith(
			{ workspaceId: "w-1", sessionName: "s-1", workspaceName: "alpha" },
			ctx,
		)
	})

	it("renames a workspace then re-shows the picker", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		pickRemoteSessionsMock
			.mockResolvedValueOnce({ action: "rename-workspace", node: workspaceNode() })
			.mockResolvedValueOnce(undefined)
		const { ctx, ui } = makeCtx()
		ui.input.mockResolvedValue("renamed")
		await runRemoteSessions("", ctx)
		expect(createOrUpdateWorkspaceMock).toHaveBeenCalledWith("org-1", "w-1", "test-key", "renamed", {
			endpoint: "https://api.example.com",
		})
		expect(pickRemoteSessionsMock).toHaveBeenCalledTimes(2)
	})

	it("deletes a workspace after confirmation then re-shows the picker", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		pickRemoteSessionsMock
			.mockResolvedValueOnce({
				action: "delete-workspace",
				node: workspaceNode({ row: { id: "w-1", name: "alpha", status: "active", sessionCount: 0 } }),
			})
			.mockResolvedValueOnce(undefined)
		const { ctx, ui } = makeCtx()
		ui.confirm.mockResolvedValue(true)
		await runRemoteSessions("", ctx)
		expect(deleteWorkspaceMock).toHaveBeenCalledWith("org-1", "w-1", "test-key", {
			endpoint: "https://api.example.com",
		})
		expect(pickRemoteSessionsMock).toHaveBeenCalledTimes(2)
	})

	it("does not delete a workspace when confirmation is declined", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		pickRemoteSessionsMock
			.mockResolvedValueOnce({
				action: "delete-workspace",
				node: workspaceNode({ row: { id: "w-1", name: "alpha", status: "active", sessionCount: 0 } }),
			})
			.mockResolvedValueOnce(undefined)
		const { ctx, ui } = makeCtx()
		ui.confirm.mockResolvedValue(false)
		await runRemoteSessions("", ctx)
		expect(deleteWorkspaceMock).not.toHaveBeenCalled()
	})

	it("deletes a session after confirmation then re-shows the picker", async () => {
		listWorkspacesMock.mockResolvedValue([ws("w-1", "alpha")])
		pickRemoteSessionsMock
			.mockResolvedValueOnce({
				action: "delete-session",
				node: {
					workspaceId: "w-1",
					workspaceName: "alpha",
					sessionName: "s-1",
					status: "active",
					clientConnected: true,
				},
			})
			.mockResolvedValueOnce(undefined)
		const { ctx, ui } = makeCtx()
		ui.confirm.mockResolvedValue(true)
		await runRemoteSessions("", ctx)
		expect(deleteSessionMock).toHaveBeenCalledWith(expect.anything(), "s-1", undefined)
		expect(pickRemoteSessionsMock).toHaveBeenCalledTimes(2)
	})
})
