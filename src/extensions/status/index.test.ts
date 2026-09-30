import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Model } from "@earendil-works/pi-ai"
import type { McpStatusSnapshot } from "pi-mcp-adapter"
import { MCP_STATUS_EVENT } from "pi-mcp-adapter"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getMe } from "../../api/me.js"
import { getOrganization, verifyApiKey } from "../../api/organizations.js"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { clearAutoRoutingState, setAutoRoutingState } from "../auto-model/state.js"
import statusExtension, {
	buildStatusRows,
	gatherStatusRows,
	resolveLoginMethod,
	summarizeMcpSnapshot,
} from "./index.js"

const configState = vi.hoisted(() => ({ apiKey: undefined as string | undefined }))

vi.mock("../../config.js", () => ({
	loadConfig: () => ({ apiKey: configState.apiKey }),
	getEnvironmentApiKey: () => undefined,
	getApiKeySource: () => "config",
}))
// Deterministic, empty auth store for the gatherStatusRows path.
vi.mock("../login/flow.js", () => ({ getKimchiAuthPath: () => "/does/not/exist/auth.json" }))
vi.mock("../../api/me.js", () => ({ getMe: vi.fn() }))
vi.mock("../../api/organizations.js", () => ({ getOrganization: vi.fn(), verifyApiKey: vi.fn() }))
vi.mock("../../utils.js", () => ({ getVersion: () => "9.9.9-test" }))

function model(id: string): Model<string> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "kimchi-dev",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	}
}

function baseDeps(overrides: Partial<Parameters<typeof buildStatusRows>[0]> = {}) {
	return {
		version: "1.2.3",
		loginMethod: "Kimchi account",
		organization: undefined,
		email: "you@example.com",
		sessionName: "my-session",
		sessionId: "b3611b12-9c93-4b2a-92d8-29c866db68b8",
		cwd: "/tmp/project",
		modelRef: "kimchi-dev/kimi-k3",
		isAuto: false,
		mcp: { connected: 3, disabled: 10, failed: 1 },
		...overrides,
	}
}

describe("buildStatusRows", () => {
	it("renders the confirmed layout: version → login → blank → session block", () => {
		expect(buildStatusRows(baseDeps())).toEqual([
			"Version:        1.2.3",
			"Login method:   Kimchi account",
			"Email:          you@example.com",
			"",
			"Session name:   my-session",
			"Session ID:     b3611b12-9c93-4b2a-92d8-29c866db68b8",
			"cwd:            /tmp/project",
			"Model:          kimchi-dev/kimi-k3",
			"MCP servers:    3 connected, 10 disabled, 1 failed · /mcp",
		])
	})

	it("omits the Email row when no email is available", () => {
		const rows = buildStatusRows(baseDeps({ email: undefined }))
		expect(rows.some((r) => r.startsWith("Email:"))).toBe(false)
		expect(rows[1]).toBe("Login method:   Kimchi account")
		expect(rows[2]).toBe("")
	})

	it("renders the Organization row between login method and email when present", () => {
		const rows = buildStatusRows(
			baseDeps({ organization: { id: "516442fe-054a-49e2-ac2d-9dc9b104c3d2", name: "CAST AI" } }),
		)
		expect(rows.slice(0, 4)).toEqual([
			"Version:        1.2.3",
			"Login method:   Kimchi account",
			"Organization:   CAST AI (516442fe-054a-49e2-ac2d-9dc9b104c3d2)",
			"Email:          you@example.com",
		])
	})

	it("omits the Organization row when unknown", () => {
		const rows = buildStatusRows(baseDeps({ organization: undefined }))
		expect(rows.some((r) => r.startsWith("Organization:"))).toBe(false)
	})

	it("shows the /name hint for unnamed sessions", () => {
		const rows = buildStatusRows(baseDeps({ sessionName: undefined }))
		expect(rows.find((r) => r.startsWith("Session name:"))).toBe("Session name:   (unnamed — use /name to add a name)")
	})

	it("appends (auto) only for auto-routed models", () => {
		expect(
			buildStatusRows(baseDeps({ modelRef: "kimchi-dev/auto", isAuto: true })).find((r) => r.startsWith("Model:")),
		).toBe("Model:          kimchi-dev/auto (auto)")
	})

	it("shows the concrete routed model id in place of (auto) once a pick lands", () => {
		expect(
			buildStatusRows(baseDeps({ modelRef: "kimchi-dev/auto", isAuto: true, resolvedModelId: "kimi-k3" })).find((r) =>
				r.startsWith("Model:"),
			),
		).toBe("Model:          kimchi-dev/auto (kimi-k3)")
	})

	it("marks MCP as unavailable when no snapshot has been received", () => {
		const rows = buildStatusRows(baseDeps({ mcp: undefined }))
		expect(rows.find((r) => r.startsWith("MCP servers:"))).toBe("MCP servers:    unavailable · /mcp")
	})
})

describe("gatherStatusRows", () => {
	afterEach(() => clearAutoRoutingState("test-session"))

	function autoSessionContext() {
		return createContext({
			model: model("auto"),
			sessionManager: { getSessionName: () => "my-session" },
		})
	}

	it("shows the concrete model auto resolved to for this session", () => {
		setAutoRoutingState("test-session", { status: "resolved", model: model("kimi-k3"), requestedId: "auto" })

		const rows = gatherStatusRows(autoSessionContext())

		expect(rows.find((r) => r.startsWith("Model:"))).toBe("Model:          kimchi-dev/auto (kimi-k3)")
	})

	it("falls back to (auto) while no concrete pick has resolved", () => {
		const rows = gatherStatusRows(autoSessionContext())

		expect(rows.find((r) => r.startsWith("Model:"))).toBe("Model:          kimchi-dev/auto (auto)")
	})

	it("falls back to (auto) when the resolved pick was for a different virtual model", () => {
		setAutoRoutingState("test-session", { status: "resolved", model: model("kimi-k3"), requestedId: "auto-beta" })

		const rows = gatherStatusRows(autoSessionContext())

		expect(rows.find((r) => r.startsWith("Model:"))).toBe("Model:          kimchi-dev/auto (auto)")
	})
})

describe("summarizeMcpSnapshot", () => {
	type ServerStatus = McpStatusSnapshot["servers"][number]["status"]

	function snapshot(statuses: Array<{ status: ServerStatus; disabled?: boolean }>): McpStatusSnapshot {
		return {
			version: 1,
			servers: statuses.map((s, i) => ({
				name: `server-${i}`,
				status: s.status,
				toolCount: 0,
				directToolCount: 0,
				disabled: s.disabled ?? false,
				listenState: "active" as const,
			})),
			totalTools: 0,
			totalResources: 0,
			connectedCount: 0,
			disabledCount: 0,
		}
	}

	it("counts connected/cached as connected, disabled as disabled, and the failed set as failed", () => {
		expect(
			summarizeMcpSnapshot(
				snapshot([
					{ status: "connected" },
					{ status: "cached" },
					{ status: "failed" },
					{ status: "needs-auth" },
					{ status: "not-connected" },
					{ status: "disabled" },
				]),
			),
		).toEqual({ connected: 2, disabled: 1, failed: 3 })
	})

	it("treats a server with the disabled flag as disabled even if status says connected", () => {
		expect(summarizeMcpSnapshot(snapshot([{ status: "connected", disabled: true }]))).toEqual({
			connected: 0,
			disabled: 1,
			failed: 0,
		})
	})

	it.each([
		{ status: "failed" as const },
		{ status: "needs-auth" as const },
		{ status: "not-connected" as const },
	])("classifies $status in the failed bucket", ({ status }) => {
		expect(summarizeMcpSnapshot(snapshot([{ status }]))).toEqual({ connected: 0, disabled: 0, failed: 1 })
	})
})

describe("resolveLoginMethod", () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "status-test-"))
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})
	const authPath = () => join(dir, "auth.json")

	it("reports an env override when KIMCHI_API_KEY differs from the saved config key (env takes precedence)", () => {
		expect(
			resolveLoginMethod({ envApiKey: "k", configApiKey: "c", apiKeySource: "environment", authPath: authPath() }),
		).toBe("Kimchi API key (KIMCHI_API_KEY environment, overrides saved key)")
	})

	it("reports a Kimchi account when the env key matches the saved config key", () => {
		expect(
			resolveLoginMethod({ envApiKey: "k", configApiKey: "k", apiKeySource: "environment", authPath: authPath() }),
		).toBe("Kimchi account")
	})

	it("reports the environment API key when KIMCHI_API_KEY is the only credential", () => {
		expect(
			resolveLoginMethod({
				envApiKey: "k",
				configApiKey: undefined,
				apiKeySource: "environment",
				authPath: authPath(),
			}),
		).toBe("Kimchi API key (KIMCHI_API_KEY environment)")
	})

	it("reports a Kimchi account when the saved config key exists and no env override", () => {
		expect(
			resolveLoginMethod({ envApiKey: undefined, configApiKey: "c", apiKeySource: "config", authPath: authPath() }),
		).toBe("Kimchi account")
	})

	it("lists third-party providers when no Kimchi credential exists", () => {
		writeFileSync(
			authPath(),
			JSON.stringify({
				"kimchi-dev": { type: "api_key", key: "x" },
				anthropic: { type: "oauth", access: "y" },
			}),
		)
		expect(
			resolveLoginMethod({
				envApiKey: undefined,
				configApiKey: undefined,
				apiKeySource: "config",
				authPath: authPath(),
			}),
		).toBe("Third-party provider (anthropic)")
	})

	it("reports Not logged in when nothing is configured", () => {
		expect(
			resolveLoginMethod({
				envApiKey: undefined,
				configApiKey: undefined,
				apiKeySource: "config",
				authPath: authPath(),
			}),
		).toBe("Not logged in")
	})

	it("falls back gracefully when auth.json is corrupt", () => {
		writeFileSync(authPath(), "{ not json")
		expect(
			resolveLoginMethod({
				envApiKey: undefined,
				configApiKey: undefined,
				apiKeySource: "config",
				authPath: authPath(),
			}),
		).toBe("Not logged in")
	})
})

function setup() {
	const { api, getRegisteredCommand, getHandler, emitEvent } = createExtensionApi()
	statusExtension(api)
	const ctx = createCommandContext()
	ctx.cwd = "/tmp/project"
	ctx.sessionManager.getSessionName = () => undefined
	const command = getRegisteredCommand("status")
	return {
		ctx,
		emitEvent,
		startSession: () => getHandler("session_start")({ type: "session_start", reason: "startup" }, ctx),
		runStatus: async () => {
			await command.handler("", ctx)
			const lastCall = vi.mocked(ctx.ui.notify).mock.lastCall
			return lastCall ? lastCall[0].split("\n") : []
		},
	}
}

function mockIdentity() {
	vi.mocked(getMe).mockResolvedValue({ id: "user-1", email: "you@example.com" })
	vi.mocked(verifyApiKey).mockResolvedValue({ organizationId: "org-1" })
	vi.mocked(getOrganization).mockResolvedValue({ id: "org-1", name: "CAST AI" })
}

describe("status command handler", () => {
	beforeEach(() => {
		configState.apiKey = undefined
		vi.mocked(getMe).mockReset()
		vi.mocked(verifyApiKey).mockReset()
		vi.mocked(getOrganization).mockReset()
	})

	it("notifies the exact layout block in RPC mode", async () => {
		const { ctx, runStatus } = setup()
		ctx.mode = "rpc"

		const rows = await runStatus()

		expect(ctx.ui.custom).not.toHaveBeenCalled()
		// No key in config and an empty auth store → "Not logged in"; no
		// identity fetched; no MCP snapshot received.
		expect(rows).toEqual([
			"Version:        9.9.9-test",
			"Login method:   Not logged in",
			"",
			"Session name:   (unnamed — use /name to add a name)",
			"Session ID:     test-session",
			"cwd:            /tmp/project",
			"Model:          (no model selected)",
			"MCP servers:    unavailable · /mcp",
		])
	})

	it("opens the panel via custom UI in TUI mode", async () => {
		const { ctx, runStatus } = setup()

		await runStatus()

		expect(ctx.ui.custom).toHaveBeenCalledOnce()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("does nothing when there is no UI", async () => {
		const { ctx, runStatus } = setup()
		ctx.mode = "print"
		ctx.hasUI = false

		await runStatus()

		expect(ctx.ui.custom).not.toHaveBeenCalled()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("shows email and organization fetched on session start", async () => {
		configState.apiKey = "key-1"
		mockIdentity()
		const { ctx, startSession, runStatus } = setup()
		ctx.mode = "rpc"

		await startSession()

		await vi.waitFor(async () => {
			expect((await runStatus()).slice(0, 4)).toEqual([
				"Version:        9.9.9-test",
				"Login method:   Kimchi account",
				"Organization:   CAST AI (org-1)",
				"Email:          you@example.com",
			])
		})
		expect(getMe).toHaveBeenCalledOnce()
		expect(getOrganization).toHaveBeenCalledWith("key-1", "org-1")
	})

	it("fetches identity for a key that appears after session start", async () => {
		mockIdentity()
		const { ctx, startSession, runStatus } = setup()
		ctx.mode = "rpc"
		await startSession()
		expect(getMe).not.toHaveBeenCalled()

		configState.apiKey = "key-after-login"
		await runStatus()

		expect(getMe).toHaveBeenCalledWith("key-after-login")
		await vi.waitFor(async () => {
			expect(await runStatus()).toContain("Email:          you@example.com")
		})
	})

	it("refetches identity when the key changes", async () => {
		configState.apiKey = "key-1"
		mockIdentity()
		const { startSession } = setup()
		await startSession()
		await startSession()
		expect(getMe).toHaveBeenCalledOnce()

		configState.apiKey = "key-2"
		await startSession()

		expect(getMe).toHaveBeenCalledTimes(2)
		expect(getMe).toHaveBeenLastCalledWith("key-2")
	})

	it("starts each extension instance without cached identity", async () => {
		configState.apiKey = "key-1"
		mockIdentity()
		const first = setup()
		first.ctx.mode = "rpc"
		await first.startSession()
		await vi.waitFor(async () => {
			expect(await first.runStatus()).toContain("Email:          you@example.com")
		})

		vi.mocked(getMe).mockReturnValue(new Promise(() => {}))
		const second = setup()
		second.ctx.mode = "rpc"

		const rows = await second.runStatus()

		expect(rows.some((r) => r.startsWith("Email:"))).toBe(false)
		expect(rows.some((r) => r.startsWith("Organization:"))).toBe(false)
	})

	it("summarizes the MCP snapshot published on the event bus", async () => {
		const { ctx, emitEvent, runStatus } = setup()
		ctx.mode = "rpc"

		emitEvent(MCP_STATUS_EVENT, {
			version: 1,
			servers: [{ name: "a", status: "connected", toolCount: 0, directToolCount: 0, disabled: false }],
			totalTools: 0,
			totalResources: 0,
			connectedCount: 1,
			disabledCount: 0,
		})

		expect(await runStatus()).toContain("MCP servers:    1 connected, 0 disabled, 0 failed · /mcp")
	})
})

describe("status command handler errors", () => {
	beforeEach(() => {
		configState.apiKey = "key-1"
		vi.mocked(getMe).mockReset()
		vi.mocked(verifyApiKey).mockReset()
		vi.mocked(getOrganization).mockReset()
	})

	it("omits email and organization rows when the identity fetches fail", async () => {
		vi.mocked(getMe).mockRejectedValue(new Error("boom"))
		vi.mocked(verifyApiKey).mockRejectedValue(new Error("boom"))
		const { ctx, startSession, runStatus } = setup()
		ctx.mode = "rpc"
		await startSession()
		await vi.waitFor(() => expect(verifyApiKey).toHaveBeenCalled())

		const rows = await runStatus()

		expect(rows.some((r) => r.startsWith("Email:"))).toBe(false)
		expect(rows.some((r) => r.startsWith("Organization:"))).toBe(false)
		expect(getOrganization).not.toHaveBeenCalled()
	})

	it("ignores malformed MCP status payloads", async () => {
		configState.apiKey = undefined
		const { ctx, emitEvent, runStatus } = setup()
		ctx.mode = "rpc"

		emitEvent(MCP_STATUS_EVENT, { version: 1 })

		expect(await runStatus()).toContain("MCP servers:    unavailable · /mcp")
	})
})
