import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Model } from "@earendil-works/pi-ai"
import type { McpStatusSnapshot } from "pi-mcp-adapter"
import { MCP_STATUS_EVENT } from "pi-mcp-adapter"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getMe } from "../../api/me.js"
import { getOrganization, verifyApiKey } from "../../api/organizations.js"
import { getStatusProvider, unregisterStatusProvider } from "../../modes/acp/status-provider-registry.js"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { clearAutoRoutingState, setAutoRoutingState } from "../auto-model/state.js"
import statusExtension, { buildStatusRows } from "./index.js"
import { buildStatusSnapshot, resolveLoginMethod, type StatusSnapshot, summarizeMcpSnapshot } from "./snapshot.js"

const configState = vi.hoisted(() => ({
	savedKey: undefined as string | undefined,
	envKey: undefined as string | undefined,
}))

vi.mock("../../config.js", () => ({
	// loadConfig merges the env override, like the real implementation does.
	loadConfig: () => ({ apiKey: configState.envKey ?? configState.savedKey }),
	getEnvironmentApiKey: () => configState.envKey,
	getSavedApiKey: () => configState.savedKey,
	getApiKeySource: () => (configState.envKey ? "environment" : "config"),
}))
// Deterministic, empty auth store for the buildStatusSnapshot path.
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

function baseSnapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
	return {
		version: "1.2.3",
		login: { method: "kimchi_account" },
		organization: undefined,
		email: "you@example.com",
		session: { name: "my-session", id: "b3611b12-9c93-4b2a-92d8-29c866db68b8", cwd: "/tmp/project" },
		model: { provider: "kimchi-dev", id: "kimi-k3", isAuto: false },
		mcp: { connected: 3, disabled: 10, failed: 1 },
		...overrides,
	}
}

describe("buildStatusRows", () => {
	it("renders the confirmed layout: version → login → blank → session block", () => {
		expect(buildStatusRows(baseSnapshot())).toEqual([
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

	it.each([
		{ login: { method: "kimchi_account" as const }, expected: "Kimchi account" },
		{
			login: { method: "api_key_env" as const },
			expected: "Kimchi API key (KIMCHI_API_KEY environment)",
		},
		{
			login: { method: "api_key_env_override" as const },
			expected: "Kimchi API key (KIMCHI_API_KEY environment, overrides saved key)",
		},
		{
			login: { method: "third_party" as const, thirdPartyProviders: ["anthropic"] },
			expected: "Third-party provider (anthropic)",
		},
		{ login: { method: "none" as const }, expected: "Not logged in" },
	])("maps the $login.method enum to its display string", ({ login, expected }) => {
		expect(buildStatusRows(baseSnapshot({ login }))[1]).toBe(`Login method:   ${expected}`)
	})

	it("joins multiple third-party providers in the display string", () => {
		const rows = buildStatusRows(
			baseSnapshot({ login: { method: "third_party", thirdPartyProviders: ["anthropic", "openai"] } }),
		)
		expect(rows[1]).toBe("Login method:   Third-party provider (anthropic, openai)")
	})

	it("omits the Email row when no email is available", () => {
		const rows = buildStatusRows(baseSnapshot({ email: undefined }))
		expect(rows.some((r) => r.startsWith("Email:"))).toBe(false)
		expect(rows[1]).toBe("Login method:   Kimchi account")
		expect(rows[2]).toBe("")
	})

	it("renders the Organization row between login method and email when present", () => {
		const rows = buildStatusRows(
			baseSnapshot({ organization: { id: "516442fe-054a-49e2-ac2d-9dc9b104c3d2", name: "CAST AI" } }),
		)
		expect(rows.slice(0, 4)).toEqual([
			"Version:        1.2.3",
			"Login method:   Kimchi account",
			"Organization:   CAST AI (516442fe-054a-49e2-ac2d-9dc9b104c3d2)",
			"Email:          you@example.com",
		])
	})

	it("omits the Organization row when unknown", () => {
		const rows = buildStatusRows(baseSnapshot({ organization: undefined }))
		expect(rows.some((r) => r.startsWith("Organization:"))).toBe(false)
	})

	it("shows the /name hint for unnamed sessions", () => {
		const snapshot = baseSnapshot()
		snapshot.session = { id: snapshot.session.id, cwd: snapshot.session.cwd }
		const rows = buildStatusRows(snapshot)
		expect(rows.find((r) => r.startsWith("Session name:"))).toBe("Session name:   (unnamed — use /name to add a name)")
	})

	it("renders (no model selected) when the snapshot has no model", () => {
		const rows = buildStatusRows(baseSnapshot({ model: null }))
		expect(rows.find((r) => r.startsWith("Model:"))).toBe("Model:          (no model selected)")
	})

	it("appends (auto) only for auto-routed models", () => {
		expect(
			buildStatusRows(baseSnapshot({ model: { provider: "kimchi-dev", id: "auto", isAuto: true } })).find((r) =>
				r.startsWith("Model:"),
			),
		).toBe("Model:          kimchi-dev/auto (auto)")
	})

	it("shows the concrete routed model id in place of (auto) once a pick lands", () => {
		expect(
			buildStatusRows(
				baseSnapshot({ model: { provider: "kimchi-dev", id: "auto", isAuto: true, resolvedModelId: "kimi-k3" } }),
			).find((r) => r.startsWith("Model:")),
		).toBe("Model:          kimchi-dev/auto (kimi-k3)")
	})

	it("marks MCP as unavailable when no snapshot has been received", () => {
		const rows = buildStatusRows(baseSnapshot({ mcp: undefined }))
		expect(rows.find((r) => r.startsWith("MCP servers:"))).toBe("MCP servers:    unavailable · /mcp")
	})
})

describe("buildStatusSnapshot", () => {
	afterEach(() => clearAutoRoutingState("test-session"))

	function autoSessionContext() {
		return createContext({
			model: model("auto"),
			sessionManager: { getSessionName: () => "my-session" },
		})
	}

	it("populates version, session, and camelCase model fields from the live session", () => {
		const snapshot = buildStatusSnapshot(autoSessionContext())

		expect(snapshot.version).toBe("9.9.9-test")
		expect(snapshot.session).toEqual({ name: "my-session", id: "test-session", cwd: "/tmp" })
		expect(snapshot.model).toEqual({ provider: "kimchi-dev", id: "auto", isAuto: true })
		// Not logged in by default in this mocked store.
		expect(snapshot.login).toEqual({ method: "none" })
	})

	it("omits session name, identity, and mcp when unknown", () => {
		const ctx = createContext({ sessionManager: { getSessionName: () => undefined } })
		const snapshot = buildStatusSnapshot(ctx)

		expect(snapshot.session.name).toBeUndefined()
		expect(snapshot.email).toBeUndefined()
		expect(snapshot.organization).toBeUndefined()
		expect(snapshot.mcp).toBeUndefined()
	})

	it("reports model as null when no model is selected", () => {
		const snapshot = buildStatusSnapshot(createContext({ sessionManager: { getSessionName: () => undefined } }))

		expect(snapshot.model).toBeNull()
	})

	it("re-reads credential state per call", () => {
		const ctx = autoSessionContext()
		expect(buildStatusSnapshot(ctx).login).toEqual({ method: "none" })

		configState.savedKey = "saved-key"
		expect(buildStatusSnapshot(ctx).login).toEqual({ method: "kimchi_account" })
		configState.savedKey = undefined
	})

	it("includes identity email and organization from the background fetch state", () => {
		const snapshot = buildStatusSnapshot(autoSessionContext(), {
			identity: { email: "you@example.com", organization: { id: "org-1", name: "CAST AI" } },
		})

		expect(snapshot.email).toBe("you@example.com")
		expect(snapshot.organization).toEqual({ id: "org-1", name: "CAST AI" })
	})

	it("shows the concrete model auto resolved to for this session", () => {
		setAutoRoutingState("test-session", { status: "resolved", model: model("kimi-k3"), requestedId: "auto" })

		const snapshot = buildStatusSnapshot(autoSessionContext())

		expect(snapshot.model).toEqual({ provider: "kimchi-dev", id: "auto", isAuto: true, resolvedModelId: "kimi-k3" })
	})

	it("leaves resolvedModelId absent while no concrete pick has resolved", () => {
		const snapshot = buildStatusSnapshot(autoSessionContext())

		expect(snapshot.model?.resolvedModelId).toBeUndefined()
	})

	it("leaves resolvedModelId absent when the resolved pick was for a different virtual model", () => {
		setAutoRoutingState("test-session", { status: "resolved", model: model("kimi-k3"), requestedId: "auto-beta" })

		const snapshot = buildStatusSnapshot(autoSessionContext())

		expect(snapshot.model?.resolvedModelId).toBeUndefined()
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
		).toEqual({ method: "api_key_env_override" })
	})

	it("reports a Kimchi account when the env key matches the saved config key", () => {
		expect(
			resolveLoginMethod({ envApiKey: "k", configApiKey: "k", apiKeySource: "environment", authPath: authPath() }),
		).toEqual({ method: "kimchi_account" })
	})

	it("reports the environment API key when KIMCHI_API_KEY is the only credential", () => {
		expect(
			resolveLoginMethod({
				envApiKey: "k",
				configApiKey: undefined,
				apiKeySource: "environment",
				authPath: authPath(),
			}),
		).toEqual({ method: "api_key_env" })
	})

	it("reports a Kimchi account when the saved config key exists and no env override", () => {
		expect(
			resolveLoginMethod({ envApiKey: undefined, configApiKey: "c", apiKeySource: "config", authPath: authPath() }),
		).toEqual({ method: "kimchi_account" })
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
		).toEqual({ method: "third_party", thirdPartyProviders: ["anthropic"] })
	})

	it("reports none when nothing is configured", () => {
		expect(
			resolveLoginMethod({
				envApiKey: undefined,
				configApiKey: undefined,
				apiKeySource: "config",
				authPath: authPath(),
			}),
		).toEqual({ method: "none" })
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
		).toEqual({ method: "none" })
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
		shutdownSession: () => getHandler("session_shutdown")({ type: "session_shutdown" }, ctx),
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
		configState.savedKey = undefined
		configState.envKey = undefined
		vi.mocked(getMe).mockReset()
		vi.mocked(verifyApiKey).mockReset()
		vi.mocked(getOrganization).mockReset()
	})
	afterEach(() => {
		// The registry is module-global; leave no gather closures behind.
		unregisterStatusProvider("test-session")
	})

	it("notifies the exact layout block in RPC mode", async () => {
		const { ctx, runStatus } = setup()
		ctx.mode = "rpc"

		const rows = await runStatus()

		expect(ctx.ui.custom).not.toHaveBeenCalled()
		// No key in config and an empty auth store → login.method "none"; no
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

	it("reports the env key as login method when KIMCHI_API_KEY overrides the saved key", async () => {
		configState.savedKey = "saved-key"
		configState.envKey = "env-key"
		mockIdentity()
		const { ctx, runStatus } = setup()
		ctx.mode = "rpc"

		expect(await runStatus()).toContain(
			"Login method:   Kimchi API key (KIMCHI_API_KEY environment, overrides saved key)",
		)
	})

	it("reports the env key as login method when KIMCHI_API_KEY is the only credential", async () => {
		configState.envKey = "env-key"
		mockIdentity()
		const { ctx, runStatus } = setup()
		ctx.mode = "rpc"

		expect(await runStatus()).toContain("Login method:   Kimchi API key (KIMCHI_API_KEY environment)")
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
		configState.savedKey = "key-1"
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

		configState.savedKey = "key-after-login"
		await runStatus()

		expect(getMe).toHaveBeenCalledWith("key-after-login")
		await vi.waitFor(async () => {
			expect(await runStatus()).toContain("Email:          you@example.com")
		})
	})

	it("refetches identity when the key changes", async () => {
		configState.savedKey = "key-1"
		mockIdentity()
		const { startSession } = setup()
		await startSession()
		await startSession()
		expect(getMe).toHaveBeenCalledOnce()

		configState.savedKey = "key-2"
		await startSession()

		expect(getMe).toHaveBeenCalledTimes(2)
		expect(getMe).toHaveBeenLastCalledWith("key-2")
	})

	it("starts each extension instance without cached identity", async () => {
		configState.savedKey = "key-1"
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

	it("registers a per-session snapshot provider on session start", async () => {
		configState.savedKey = "key-1"
		mockIdentity()
		const { startSession } = setup()

		await startSession()

		const provider = getStatusProvider("test-session")
		expect(provider).toBeDefined()

		const snapshot = provider?.()
		expect(snapshot).toMatchObject({
			version: "9.9.9-test",
			login: { method: "kimchi_account" },
			session: { id: "test-session", cwd: "/tmp/project" },
			model: null,
		})
		// Absent-until-landed identity/mcp freshness is covered by the refresh test below.
	})

	it("triggers the non-blocking identity refresh when the registered provider is called", async () => {
		mockIdentity()
		const { startSession } = setup()
		await startSession()
		expect(getMe).not.toHaveBeenCalled()

		configState.savedKey = "key-after-login"
		getStatusProvider("test-session")?.()

		expect(getMe).toHaveBeenCalledWith("key-after-login")
		await vi.waitFor(() => {
			expect(getStatusProvider("test-session")?.().email).toBe("you@example.com")
		})
	})

	it("unregisters the provider on session shutdown", async () => {
		const { startSession, shutdownSession } = setup()
		await startSession()
		expect(getStatusProvider("test-session")).toBeDefined()

		shutdownSession()

		expect(getStatusProvider("test-session")).toBeUndefined()
	})
})

describe("status command handler errors", () => {
	beforeEach(() => {
		configState.savedKey = "key-1"
		configState.envKey = undefined
		vi.mocked(getMe).mockReset()
		vi.mocked(verifyApiKey).mockReset()
		vi.mocked(getOrganization).mockReset()
	})
	afterEach(() => {
		unregisterStatusProvider("test-session")
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
		configState.savedKey = undefined
		const { ctx, emitEvent, runStatus } = setup()
		ctx.mode = "rpc"

		emitEvent(MCP_STATUS_EVENT, { version: 1 })

		expect(await runStatus()).toContain("MCP servers:    unavailable · /mcp")
	})
})
