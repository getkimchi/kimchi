import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
	authMock,
	getGitRemoteHostMock,
	readGitTokenMock,
	provisionGitCredentialMock,
	buildProxyCommandMock,
	listWorkspacesMock,
} = vi.hoisted(() => ({
	authMock: vi.fn(),
	getGitRemoteHostMock: vi.fn(),
	readGitTokenMock: vi.fn(),
	provisionGitCredentialMock: vi.fn(),
	buildProxyCommandMock: vi.fn(),
	listWorkspacesMock: vi.fn(),
}))

vi.mock("../../../sandbox/cloud/auth.js", () => ({ authenticateWorkspace: authMock }))
vi.mock("../../../sandbox/cloud/workspaces.js", () => ({ listWorkspaces: listWorkspacesMock }))
vi.mock("../../../sandbox/git-credentials.js", () => ({ getGitRemoteHost: getGitRemoteHostMock }))
vi.mock("../../../config.js", () => ({ readGitToken: readGitTokenMock }))
vi.mock("../../../sandbox/worker/client.js", () => ({ WorkerClient: class {} }))
vi.mock("../provisioning/git-provision.js", () => ({
	provisionGitCredential: provisionGitCredentialMock,
}))
vi.mock("../provisioning/proxy-command.js", () => ({ buildProxyCommand: buildProxyCommandMock }))

import { RemoteAuthError } from "../../../sandbox/cloud/types.js"
import type { TeleportContext } from "../types.js"
import { TeleportRefusal } from "./errors.js"
import { runTerminal } from "./terminal.js"

const CREDS = {
	connectToken: "tok-1",
	expiresAt: "2030-01-01T00:00:00Z",
	wsUrl: "wss://h.example",
	host: "h.example",
}

function makeUi(): ExtensionUIContext & {
	notify: ReturnType<typeof vi.fn>
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
		custom: vi.fn(async () => undefined),
		theme: {} as never,
		getAllThemes: vi.fn(() => []),
		getTheme: vi.fn(),
		setTheme: vi.fn(() => ({ success: true })),
		getToolsExpanded: vi.fn(() => false),
		setToolsExpanded: vi.fn(),
	} as unknown as ExtensionUIContext & {
		notify: ReturnType<typeof vi.fn>
		setStatus: ReturnType<typeof vi.fn>
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
	getGitRemoteHostMock.mockReset().mockResolvedValue(undefined)
	readGitTokenMock.mockReset().mockReturnValue(undefined)
	provisionGitCredentialMock.mockReset().mockResolvedValue(undefined)
	buildProxyCommandMock.mockReset().mockReturnValue("kimchi --ssh-proxy %h")
	listWorkspacesMock.mockReset().mockResolvedValue([])
})

describe("runTerminal", () => {
	it("builds the expected ssh argv and env, returning on exit 0", async () => {
		const { ctx } = makeCtx()
		const runChild = vi.fn().mockResolvedValue(0)

		await runTerminal("33333333-3333-4333-8333-333333333333", ctx, { _runChildWithTTYHandoff: runChild })

		expect(authMock).toHaveBeenCalledOnce()
		expect(authMock.mock.calls[0][0]).toBe("33333333-3333-4333-8333-333333333333")
		expect(runChild).toHaveBeenCalledOnce()
		const call = runChild.mock.calls[0][0]
		expect(call.cmd).toBe("ssh")
		expect(call.args).toEqual([
			"-o",
			"ProxyCommand=kimchi --ssh-proxy %h",
			"-o",
			"StrictHostKeyChecking=no",
			"-o",
			"UserKnownHostsFile=/dev/null",
			"-o",
			"LogLevel=ERROR",
			"sandbox@h.example",
		])
		expect(call.env.AUTH_TOKEN).toBe("tok-1")
	})

	it("refuses with the empty-workspaces message when no arg and the account has no workspaces", async () => {
		listWorkspacesMock.mockResolvedValue([])
		const { ctx, ui } = makeCtx()
		const runChild = vi.fn().mockResolvedValue(0)

		await expect(runTerminal("", ctx, { _runChildWithTTYHandoff: runChild })).rejects.toBeInstanceOf(TeleportRefusal)
		expect(authMock).not.toHaveBeenCalled()
		expect(runChild).not.toHaveBeenCalled()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/no workspaces available/), "error")
	})

	it("refuses with a clear message on RemoteAuthError", async () => {
		authMock.mockRejectedValueOnce(new RemoteAuthError("bad key", 401))
		const { ctx, ui } = makeCtx()
		const runChild = vi.fn().mockResolvedValue(0)

		await expect(
			runTerminal("33333333-3333-4333-8333-333333333333", ctx, { _runChildWithTTYHandoff: runChild }),
		).rejects.toBeInstanceOf(TeleportRefusal)
		expect(runChild).not.toHaveBeenCalled()
		expect(ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Authentication failed for 33333333-3333-4333-8333-333333333333"),
			"error",
		)
	})

	it("propagates git credentials on every invocation", async () => {
		getGitRemoteHostMock.mockResolvedValue("github.com")
		readGitTokenMock.mockReturnValue("ghp_cached")
		const { ctx } = makeCtx()
		const runChild = vi.fn().mockResolvedValue(0)

		await runTerminal("33333333-3333-4333-8333-333333333333", ctx, { _runChildWithTTYHandoff: runChild })

		expect(provisionGitCredentialMock).toHaveBeenCalledOnce()
		expect(provisionGitCredentialMock.mock.calls[0][1]).toMatchObject({
			gitHost: "github.com",
			gitToken: "ghp_cached",
		})

		await runTerminal("33333333-3333-4333-8333-333333333333", ctx, { _runChildWithTTYHandoff: runChild })
		expect(provisionGitCredentialMock).toHaveBeenCalledTimes(2)
	})

	it("warns and proceeds when credential propagation fails", async () => {
		getGitRemoteHostMock.mockResolvedValue("github.com")
		readGitTokenMock.mockReturnValue("ghp_cached")
		provisionGitCredentialMock.mockRejectedValueOnce(new Error("cred boom"))
		const { ctx, ui } = makeCtx()
		const runChild = vi.fn().mockResolvedValue(0)

		await runTerminal("33333333-3333-4333-8333-333333333333", ctx, { _runChildWithTTYHandoff: runChild })

		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("cred boom"), "warning")
		expect(runChild).toHaveBeenCalledOnce()
	})

	it("warns when ssh exits non-zero but does not throw", async () => {
		const { ctx, ui } = makeCtx()
		const runChild = vi.fn().mockResolvedValue(42)

		await runTerminal("33333333-3333-4333-8333-333333333333", ctx, { _runChildWithTTYHandoff: runChild })

		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("42"), "warning")
	})

	it("does not warn for the benign interactive-exit codes 130 (SIGINT) and 143 (SIGTERM)", async () => {
		for (const code of [130, 143]) {
			const { ctx, ui } = makeCtx()
			const runChild = vi.fn().mockResolvedValue(code)

			await runTerminal("33333333-3333-4333-8333-333333333333", ctx, { _runChildWithTTYHandoff: runChild })

			expect(ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("exited with code"), "warning")
		}
	})

	it("refuses when extra positional args are given", async () => {
		const { ctx, ui } = makeCtx()
		const runChild = vi.fn().mockResolvedValue(0)

		await expect(runTerminal("a b", ctx, { _runChildWithTTYHandoff: runChild })).rejects.toBeInstanceOf(TeleportRefusal)
		expect(authMock).not.toHaveBeenCalled()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Usage: \/terminal/), "error")
	})

	it("refuses when no API key is configured", async () => {
		const { ctx, ui } = makeCtx({ apiKey: "" })
		const runChild = vi.fn().mockResolvedValue(0)

		await expect(
			runTerminal("33333333-3333-4333-8333-333333333333", ctx, { _runChildWithTTYHandoff: runChild }),
		).rejects.toBeInstanceOf(TeleportRefusal)
		expect(authMock).not.toHaveBeenCalled()
		expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/API key/), "error")
	})
})
