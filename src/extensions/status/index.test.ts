import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Model } from "@earendil-works/pi-ai"
import type { McpStatusSnapshot } from "pi-mcp-adapter"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { clearAutoRoutingState, setAutoRoutingState } from "../auto-model/state.js"
import statusExtension, {
	buildStatusRows,
	gatherStatusRows,
	resolveLoginMethod,
	summarizeMcpSnapshot,
} from "./index.js"

vi.mock("../../config.js", () => ({
	loadConfig: () => ({ apiKey: undefined }),
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

	it("shows the concrete model auto resolved to for this session", async () => {
		setAutoRoutingState("test-session", { status: "resolved", model: model("kimi-k3"), requestedId: "auto" })

		const rows = await gatherStatusRows(autoSessionContext())

		expect(rows.find((r) => r.startsWith("Model:"))).toBe("Model:          kimchi-dev/auto (kimi-k3)")
	})

	it("falls back to (auto) while no concrete pick has resolved", async () => {
		const rows = await gatherStatusRows(autoSessionContext())

		expect(rows.find((r) => r.startsWith("Model:"))).toBe("Model:          kimchi-dev/auto (auto)")
	})

	it("falls back to (auto) when the resolved pick was for a different virtual model", async () => {
		setAutoRoutingState("test-session", { status: "resolved", model: model("kimi-k3"), requestedId: "auto-beta" })

		const rows = await gatherStatusRows(autoSessionContext())

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

	it("reports a Kimchi account when both a config key and the env key exist (account takes precedence)", () => {
		expect(
			resolveLoginMethod({ envApiKey: "k", configApiKey: "c", apiKeySource: "environment", authPath: authPath() }),
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

describe("status command handler", () => {
	it("notifies the exact layout block in non-TUI mode", async () => {
		const { api, getRegisteredCommand } = createExtensionApi()
		statusExtension(api)
		const command = getRegisteredCommand("status")
		const ctx = createCommandContext()
		ctx.mode = "print"
		ctx.cwd = "/tmp/project"
		ctx.sessionManager.getSessionName = () => undefined

		await command.handler("", ctx)

		expect(ctx.ui.custom).not.toHaveBeenCalled()
		// Login method comes from the mocked config (no key) and empty auth store
		// → "Not logged in"; no session_start fired → no email; no MCP snapshot.
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			[
				"Version:        9.9.9-test",
				"Login method:   Not logged in",
				"",
				"Session name:   (unnamed — use /name to add a name)",
				"Session ID:     test-session",
				"cwd:            /tmp/project",
				"Model:          (no model selected)",
				"MCP servers:    unavailable · /mcp",
			].join("\n"),
			"info",
		)
	})
})
