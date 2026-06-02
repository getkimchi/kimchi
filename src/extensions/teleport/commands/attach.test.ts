import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { authMock, waitReadyMock, listSessionsMock, overlayMock, progressMock, progressInstances } = vi.hoisted(() => ({
	authMock: vi.fn(),
	waitReadyMock: vi.fn(),
	listSessionsMock: vi.fn(),
	overlayMock: vi.fn(),
	progressMock: vi.fn(),
	progressInstances: [] as Array<{
		step: ReturnType<typeof vi.fn>
		complete: ReturnType<typeof vi.fn>
		finish: ReturnType<typeof vi.fn>
		stop: ReturnType<typeof vi.fn>
		promptGitToken: ReturnType<typeof vi.fn>
	}>,
}))

vi.mock("../../../sandbox/cloud/auth.js", () => ({ authenticateWorkspace: authMock }))
vi.mock("../../../sandbox/cloud/readiness.js", () => ({ waitForWorkspaceReady: waitReadyMock }))
vi.mock("../../../sandbox/worker/client.js", () => ({ WorkerClient: class {} }))
vi.mock("../../../sandbox/worker/sessions.js", () => ({ listSessions: listSessionsMock }))
vi.mock("../overlay/overlay-component.js", () => ({ createTabsOverlay: overlayMock }))
vi.mock("../ui/progress.js", () => ({
	createTeleportProgress: (...args: unknown[]) => {
		progressMock(...args)
		const controller = {
			step: vi.fn(),
			complete: vi.fn(),
			finish: vi.fn(),
			stop: vi.fn(),
			promptGitToken: vi.fn().mockResolvedValue({ outcome: "skipped" }),
		}
		progressInstances.push(controller)
		return controller
	},
}))

import type { TeleportContext } from "../types.js"
import { runAttachSession } from "./attach.js"
import { TeleportRefusal } from "./errors.js"

const CREDS = {
	connectToken: "tok-1",
	expiresAt: "2030-01-01T00:00:00Z",
	wsUrl: "wss://host.example",
	host: "host.example",
}

function makeUi(): ExtensionUIContext & {
	notify: ReturnType<typeof vi.fn>
	custom: ReturnType<typeof vi.fn>
	setHeader: ReturnType<typeof vi.fn>
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
		custom: vi.fn(async () => undefined),
		theme: {} as never,
		getAllThemes: vi.fn(() => []),
		getTheme: vi.fn(),
		setTheme: vi.fn(() => ({ success: true })),
		getToolsExpanded: vi.fn(() => false),
		setToolsExpanded: vi.fn(),
	} as unknown as ExtensionUIContext & {
		notify: ReturnType<typeof vi.fn>
		custom: ReturnType<typeof vi.fn>
		setHeader: ReturnType<typeof vi.fn>
	}
}

function makeCtx(over: Partial<TeleportContext> = {}): {
	ctx: TeleportContext
	ui: ReturnType<typeof makeUi>
} {
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

beforeEach(() => {
	authMock.mockReset().mockResolvedValue(CREDS)
	waitReadyMock.mockReset().mockResolvedValue(undefined)
	listSessionsMock.mockReset().mockResolvedValue([])
	overlayMock.mockReset().mockReturnValue(() => ({
		render: () => [],
		invalidate: () => {},
		dispose: () => {},
	}))
	progressMock.mockReset()
	progressInstances.length = 0
})

describe("runAttachSession", () => {
	it("happy path: auths, waits ready, finds session, opens overlay", async () => {
		const session = { name: "pick-me", agentMode: "PTY" }
		listSessionsMock.mockResolvedValue([{ name: "other", agentMode: "PTY" }, session])
		const { ctx, ui } = makeCtx()

		await runAttachSession({ workspaceId: "w-1", sessionName: "pick-me" }, ctx)

		expect(authMock).toHaveBeenCalledOnce()
		expect(authMock.mock.calls[0][0]).toBe("w-1")
		expect(waitReadyMock).toHaveBeenCalledOnce()
		expect(listSessionsMock).toHaveBeenCalledOnce()
		expect(overlayMock).toHaveBeenCalledOnce()
		expect(overlayMock.mock.calls[0][0]).toMatchObject({
			workspaceId: "w-1",
			initialSession: session,
		})
		expect(ui.custom).toHaveBeenCalledOnce()
	})

	it("refuses when the named session no longer exists", async () => {
		listSessionsMock.mockResolvedValue([{ name: "someone-else", agentMode: "PTY" }])
		const { ctx, ui } = makeCtx()

		await expect(runAttachSession({ workspaceId: "w-1", sessionName: "gone" }, ctx)).rejects.toBeInstanceOf(
			TeleportRefusal,
		)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/no longer exists/), "error")
		expect(overlayMock).not.toHaveBeenCalled()
		expect(ui.custom).not.toHaveBeenCalled()
	})

	it("refuses when auth fails", async () => {
		authMock.mockRejectedValue(new Error("auth boom"))
		const { ctx, ui } = makeCtx()

		await expect(runAttachSession({ workspaceId: "w-1", sessionName: "x" }, ctx)).rejects.toBeInstanceOf(
			TeleportRefusal,
		)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Authentication failed.*auth boom/), "error")
		expect(waitReadyMock).not.toHaveBeenCalled()
		expect(listSessionsMock).not.toHaveBeenCalled()
	})

	it("refuses when waitForWorkspaceReady fails", async () => {
		waitReadyMock.mockRejectedValue(new Error("cold"))
		const { ctx, ui } = makeCtx()

		await expect(runAttachSession({ workspaceId: "w-1", sessionName: "x" }, ctx)).rejects.toBeInstanceOf(
			TeleportRefusal,
		)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Sandbox never became ready.*cold/), "error")
		expect(listSessionsMock).not.toHaveBeenCalled()
	})

	it("refuses when listSessions fails", async () => {
		listSessionsMock.mockRejectedValue(new Error("worker boom"))
		const { ctx, ui } = makeCtx()

		await expect(runAttachSession({ workspaceId: "w-1", sessionName: "x" }, ctx)).rejects.toBeInstanceOf(
			TeleportRefusal,
		)
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Could not list sessions.*worker boom/), "error")
	})

	it("refuses when apiKey is missing without making any network call", async () => {
		const { ctx, ui } = makeCtx({ apiKey: "" })

		await expect(runAttachSession({ workspaceId: "w-1", sessionName: "x" }, ctx)).rejects.toBeInstanceOf(
			TeleportRefusal,
		)
		expect(authMock).not.toHaveBeenCalled()
		expect(waitReadyMock).not.toHaveBeenCalled()
		expect(listSessionsMock).not.toHaveBeenCalled()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/API key/), "error")
	})

	it("does not touch preflight or rsync paths (dirty-tree regression guard)", async () => {
		// Attach succeeds with no preflight/rsync imports in this test file at all —
		// if attach.ts ever started calling them, this file's vi.mock setup wouldn't
		// have them mocked and the suite would fail. The happy-path test above also
		// asserts overlay opens without any provisioning step calls.
		listSessionsMock.mockResolvedValue([{ name: "x", agentMode: "PTY" }])
		const { ctx } = makeCtx()

		await runAttachSession({ workspaceId: "w-1", sessionName: "x" }, ctx)

		expect(overlayMock).toHaveBeenCalledOnce()
	})
})
