import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as agentDiscovery from "../../agent-discovery/index.js"
import type { AgentDiscovery } from "../../agent-discovery/index.js"
import type { KimchiConfig, SearchStrategyConfig } from "../../config.js"
import * as permissions from "../permissions/index.js"
import * as promptEnrichment from "../prompt-construction/prompt-enrichment.js"
import { buildConfigSnapshot } from "./config-snapshot.js"

const SEARCH_STRATEGY: SearchStrategyConfig = {
	strategy: "bm25",
	bm25K1: 1.2,
	bm25B: 0.75,
	fieldWeights: { name: 6, description: 2, schemaKey: 1 },
}

function makeConfig(overrides: Partial<KimchiConfig> = {}): KimchiConfig {
	return {
		apiKey: "test-api-key",
		agentConfigDir: "/tmp/agent-config",
		llmEndpoint: "https://api.test.example.com",
		customLlmEndpoint: undefined,
		maxToolResultChars: 12000,
		mcpSearchLimit: 10,
		mcpSearch: SEARCH_STRATEGY,
		retry: { maxRetries: 10 },
		onboarding: {},
		deviceId: "test-device-id",
		...overrides,
	}
}

const EXPECTED_KEYS = [
	"config.agents_enabled",
	"config.mcp_server_count",
	"config.model",
	"config.permission_mode",
	"config.provider",
	"config.search_provider",
	"config.telemetry_enabled",
]

describe("buildConfigSnapshot", () => {
	let savedEnv: NodeJS.ProcessEnv
	// biome-ignore lint/suspicious/noExplicitAny: mock spy refs typed loosely to avoid vitest MockInstance generic friction
	let permSpy: any
	// biome-ignore lint/suspicious/noExplicitAny: mock spy refs typed loosely to avoid vitest MockInstance generic friction
	let multiSpy: any

	beforeEach(() => {
		savedEnv = { ...process.env }
		// No settings.json available -> model "unknown", provider "cast-ai"
		process.env.KIMCHI_CODING_AGENT_DIR = undefined
		process.env.KIMCHI_PERMISSIONS = undefined

		permSpy = vi.spyOn(permissions, "getDisplayPermissionMode").mockReturnValue("plan")
		multiSpy = vi.spyOn(promptEnrichment, "getMultiModelEnabled").mockReturnValue(true)
		// Mock discoverAgent to return 1 server named "evil-corp-server" per definition.
		const fakeDiscovery: AgentDiscovery = {
			id: "test",
			displayName: "test",
			mcpServers: {
				"evil-corp-server": {
					url: "https://mcp.secret.example.com",
				} as unknown as AgentDiscovery["mcpServers"][string],
			},
			skillCount: 0,
			commandsCount: 0,
		}
		vi.spyOn(agentDiscovery, "discoverAgent").mockReturnValue(fakeDiscovery)
	})

	afterEach(() => {
		process.env = savedEnv
		vi.restoreAllMocks()
	})

	describe("safe keys present with correct values", () => {
		it("returns exactly the 7 expected config.* keys", () => {
			const snapshot = buildConfigSnapshot(makeConfig(), true)
			expect(Object.keys(snapshot).sort()).toEqual(EXPECTED_KEYS)
		})

		it("every value is a primitive (string|number|boolean), no nested objects/arrays", () => {
			const snapshot = buildConfigSnapshot(makeConfig(), true)
			for (const [key, value] of Object.entries(snapshot)) {
				const t = typeof value
				expect(t === "string" || t === "number" || t === "boolean", `${key} must be primitive, got ${t}`).toBe(true)
			}
		})

		it("reflects config + mocked accessors with telemetry enabled", () => {
			const snapshot = buildConfigSnapshot(makeConfig(), true)
			expect(snapshot["config.search_provider"]).toBe("bm25")
			expect(snapshot["config.telemetry_enabled"]).toBe(true)
			expect(snapshot["config.permission_mode"]).toBe("plan")
			expect(snapshot["config.agents_enabled"]).toBe(true)
			// model unknown when no settings.json present
			expect(snapshot["config.model"]).toBe("unknown")
			expect(snapshot["config.provider"]).toBe("cast-ai")
		})

		it("flows through alternate mocked values when telemetry disabled", () => {
			permSpy.mockReturnValue("yolo")
			multiSpy.mockReturnValue(false)
			const snapshot = buildConfigSnapshot(makeConfig({ mcpSearch: { ...SEARCH_STRATEGY, strategy: "regex" } }), false)
			expect(snapshot["config.telemetry_enabled"]).toBe(false)
			expect(snapshot["config.permission_mode"]).toBe("yolo")
			expect(snapshot["config.agents_enabled"]).toBe(false)
			expect(snapshot["config.search_provider"]).toBe("regex")
		})

		it("mcp_server_count equals total mocked server count across agent definitions", () => {
			const snapshot = buildConfigSnapshot(makeConfig(), true)
			// discoverAgent mocked to return 1 server per AGENT_DEFINITIONS entry.
			expect(snapshot["config.mcp_server_count"]).toBe(agentDiscovery.AGENT_DEFINITIONS.length)
			expect(typeof snapshot["config.mcp_server_count"]).toBe("number")
		})
	})

	describe("PII / secret-leak guard", () => {
		it("does not leak api keys, endpoints, mcp server names, or PII into the snapshot", () => {
			const configWithSecrets = makeConfig({
				apiKey: "secret-key-123",
				llmEndpoint: "https://secret.example.com",
				customLlmEndpoint: "https://secret2.example.com",
				deviceId: "device-uuid-secret",
			})
			// discoverAgent mock returns a server named "evil-corp-server" with a secret URL.
			const snapshot = buildConfigSnapshot(configWithSecrets, true)

			const serialized = JSON.stringify(snapshot)
			const forbidden = [
				"secret-key-123",
				"secret.example.com",
				"secret2.example.com",
				"device-uuid-secret",
				"evil-corp-server", // MCP server NAME must never leak
				"https://mcp.secret.example.com", // MCP server URL must never leak
				"user@evil.com", // hypothetical user PII
			]
			for (const secret of forbidden) {
				expect(serialized, `leaked secret substring: ${secret}`).not.toContain(secret)
			}
		})

		it("emits exactly the 7 safe keys even when config carries secrets", () => {
			const configWithSecrets = makeConfig({
				apiKey: "secret-key-123",
				llmEndpoint: "https://secret.example.com",
			})
			const snapshot = buildConfigSnapshot(configWithSecrets, true)
			expect(Object.keys(snapshot).sort()).toEqual(EXPECTED_KEYS)
			// No extra key smuggles a secret value through.
			expect(Object.keys(snapshot)).toHaveLength(7)
		})
	})

	describe("error handling", () => {
		it("returns a safe fallback snapshot when a helper throws", () => {
			// Force discoverAgent to throw — simulates a corrupted agent config
			vi.spyOn(agentDiscovery, "discoverAgent").mockImplementation(() => {
				throw new Error("corrupted agent config")
			})

			const snapshot = buildConfigSnapshot(makeConfig(), true)

			// Must still have exactly the 7 expected keys.
			expect(Object.keys(snapshot).sort()).toEqual(EXPECTED_KEYS)
			// Fallback values are safe defaults.
			expect(snapshot["config.model"]).toBe("unknown")
			expect(snapshot["config.provider"]).toBe("cast-ai")
			expect(snapshot["config.search_provider"]).toBe("unknown")
			expect(snapshot["config.telemetry_enabled"]).toBe(true)
			expect(snapshot["config.permission_mode"]).toBe("default")
			expect(snapshot["config.agents_enabled"]).toBe(false)
			expect(snapshot["config.mcp_server_count"]).toBe(0)
		})
	})
})
