import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpStatusSnapshot } from "pi-mcp-adapter"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildStatusRows, resolveLoginMethod, summarizeMcpSnapshot } from "./index.js"

vi.mock("../../config.js", () => ({
	loadConfig: () => ({ apiKey: undefined }),
	getEnvironmentApiKey: () => undefined,
}))
vi.mock("../../api/me.js", () => ({ getMe: vi.fn() }))
vi.mock("../../utils.js", () => ({ getVersion: () => "9.9.9-test" }))

function baseDeps(overrides: Partial<Parameters<typeof buildStatusRows>[0]> = {}) {
	return {
		version: "1.2.3",
		loginMethod: "Kimchi account",
		email: "you@example.com",
		sessionName: "my-session",
		sessionId: "b3611b12-9c93-4b2a-92d8-29c866db68b8",
		cwd: "/tmp/project",
		modelRef: "anthropic/claude-sonnet-4-5",
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
			"Model:          anthropic/claude-sonnet-4-5",
			"MCP servers:    3 connected, 10 disabled, 1 failed · /mcp",
		])
	})

	it("omits the Email row when no email is available", () => {
		const rows = buildStatusRows(baseDeps({ email: undefined }))
		expect(rows.some((r) => r.startsWith("Email:"))).toBe(false)
		expect(rows[1]).toBe("Login method:   Kimchi account")
		expect(rows[2]).toBe("")
	})

	it("never renders an Organization row", () => {
		const rows = buildStatusRows(baseDeps())
		expect(rows.some((r) => r.toLowerCase().includes("organization"))).toBe(false)
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

	it("marks MCP as unavailable when no snapshot has been received", () => {
		const rows = buildStatusRows(baseDeps({ mcp: undefined }))
		expect(rows.find((r) => r.startsWith("MCP servers:"))).toBe("MCP servers:    unavailable · /mcp")
	})
})

describe("summarizeMcpSnapshot", () => {
	function snapshot(statuses: Array<{ status: string; disabled?: boolean }>): McpStatusSnapshot {
		return {
			version: 1,
			servers: statuses.map((s, i) => ({
				name: `server-${i}`,
				status: s.status as McpStatusSnapshot["servers"][number]["status"],
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

	it("counts connected/cached as connected, disabled as disabled, remainder as failed", () => {
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

	it("prefers the environment API key", () => {
		expect(resolveLoginMethod({ envApiKey: "k", configApiKey: "c", authPath: authPath() })).toBe(
			"Kimchi API key (KIMCHI_API_KEY environment)",
		)
	})

	it("reports a Kimchi account when the saved config key exists and no env override", () => {
		expect(resolveLoginMethod({ envApiKey: undefined, configApiKey: "c", authPath: authPath() })).toBe("Kimchi account")
	})

	it("lists third-party providers when no Kimchi credential exists", () => {
		writeFileSync(
			authPath(),
			JSON.stringify({
				"kimchi-dev": { type: "api_key", key: "x" },
				anthropic: { type: "oauth", access: "y" },
			}),
		)
		expect(resolveLoginMethod({ envApiKey: undefined, configApiKey: undefined, authPath: authPath() })).toBe(
			"Third-party provider (anthropic)",
		)
	})

	it("reports Not logged in when nothing is configured", () => {
		expect(resolveLoginMethod({ envApiKey: undefined, configApiKey: undefined, authPath: authPath() })).toBe(
			"Not logged in",
		)
	})

	it("falls back gracefully when auth.json is corrupt", () => {
		writeFileSync(authPath(), "{ not json")
		expect(resolveLoginMethod({ envApiKey: undefined, configApiKey: undefined, authPath: authPath() })).toBe(
			"Not logged in",
		)
	})
})
