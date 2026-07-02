import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { collectKnownSecrets } from "./secret-registry.js"

// Mock config path so tests don't touch real config
const tmpDir = join(import.meta.dirname, "__tmp_secret_registry_test__")

vi.mock("../../config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../config.js")>()
	return {
		...actual,
		readApiKeyFromConfigFile: vi.fn(() => undefined),
		readAllGitTokens: vi.fn(() => undefined),
	}
})

vi.mock("../mcp-adapter/config.js", () => ({
	loadMcpConfig: vi.fn(() => ({ config: { mcpServers: {} }, warnings: [] })),
}))

import { readAllGitTokens, readApiKeyFromConfigFile } from "../../config.js"
import { loadMcpConfig } from "../mcp-adapter/config.js"

const originalEnv = { ...process.env }

beforeEach(() => {
	mkdirSync(tmpDir, { recursive: true })
	vi.clearAllMocks()
	process.env = { ...originalEnv }
	// Clear all secret-bearing env vars so tests are deterministic
	for (const key of Object.keys(originalEnv)) {
		if (/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) {
			process.env[key] = undefined
		}
	}
})

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true })
	process.env = { ...originalEnv }
})

describe("collectKnownSecrets", () => {
	describe("API key", () => {
		it("collects apiKey from config file", () => {
			vi.mocked(readApiKeyFromConfigFile).mockReturnValue("file-api-key-12345678")
			const secrets = collectKnownSecrets()
			expect(secrets.has("file-api-key-12345678")).toBe(true)
		})

		it("collects apiKey from process.env.KIMCHI_API_KEY", () => {
			process.env.KIMCHI_API_KEY = "env-api-key-123456789"
			vi.mocked(readApiKeyFromConfigFile).mockReturnValue(undefined)
			const secrets = collectKnownSecrets()
			expect(secrets.has("env-api-key-123456789")).toBe(true)
		})

		it("collects API keys from any env var matching API_KEY/TOKEN/SECRET", () => {
			process.env.ANTHROPIC_API_KEY = "sk-ant-key-12345678901234567890"
			process.env.CUSTOM_SERVICE_TOKEN = "custom-token-12345678901234567"
			process.env.MY_DB_PASSWORD = "db-pass-123456789"
			vi.mocked(readApiKeyFromConfigFile).mockReturnValue(undefined)
			const secrets = collectKnownSecrets()
			expect(secrets.has("sk-ant-key-12345678901234567890")).toBe(true)
			expect(secrets.has("custom-token-12345678901234567")).toBe(true)
			expect(secrets.has("db-pass-123456789")).toBe(true)
		})

		it("does not collect values from non-secret env vars", () => {
			process.env.HOME = "/home/user"
			process.env.PATH = "/usr/bin:/bin"
			process.env.SOME_CONFIG = "not-a-secret"
			const secrets = collectKnownSecrets()
			expect(secrets.has("/home/user")).toBe(false)
			expect(secrets.has("/usr/bin:/bin")).toBe(false)
			expect(secrets.has("not-a-secret")).toBe(false)
		})

		it("skips apiKey shorter than 8 chars", () => {
			vi.mocked(readApiKeyFromConfigFile).mockReturnValue("short")
			const secrets = collectKnownSecrets()
			expect(secrets.has("short")).toBe(false)
		})
	})

	describe("Git tokens", () => {
		it("collects all gitToken values", () => {
			vi.mocked(readAllGitTokens).mockReturnValue({
				"github.com": "ghp_token_123456789012345678",
				"gitlab.com": "glpat_token_12345678901234567890",
			})
			const secrets = collectKnownSecrets()
			expect(secrets.has("ghp_token_123456789012345678")).toBe(true)
			expect(secrets.has("glpat_token_12345678901234567890")).toBe(true)
		})

		it("handles empty gitTokens", () => {
			vi.mocked(readAllGitTokens).mockReturnValue({})
			const secrets = collectKnownSecrets()
			expect(secrets.size).toBe(0)
		})

		it("handles missing gitTokens field (undefined)", () => {
			vi.mocked(readAllGitTokens).mockReturnValue(undefined)
			const secrets = collectKnownSecrets()
			expect(secrets.size).toBe(0)
		})
	})

	describe("MCP bearer tokens", () => {
		it("collects bearer token from headers", () => {
			vi.mocked(loadMcpConfig).mockReturnValue({
				config: {
					mcpServers: {
						svc: { url: "https://mcp.example.com", headers: { Authorization: "Bearer mcp-bearer-token-12345678" } },
					},
				},
				warnings: [],
			})
			const secrets = collectKnownSecrets()
			expect(secrets.has("mcp-bearer-token-12345678")).toBe(true)
		})

		it("collects bearerToken field", () => {
			vi.mocked(loadMcpConfig).mockReturnValue({
				config: {
					mcpServers: {
						svc: { url: "https://mcp.example.com", bearerToken: "literal-bearer-token-12345678" },
					},
				},
				warnings: [],
			})
			const secrets = collectKnownSecrets()
			expect(secrets.has("literal-bearer-token-12345678")).toBe(true)
		})

		it("collects bearerTokenEnv field", () => {
			process.env.CUSTOM_MCP_TOKEN = "env-resolved-token-12345678"
			vi.mocked(loadMcpConfig).mockReturnValue({
				config: {
					mcpServers: {
						svc: { url: "https://mcp.example.com", bearerTokenEnv: "CUSTOM_MCP_TOKEN" },
					},
				},
				warnings: [],
			})
			const secrets = collectKnownSecrets()
			expect(secrets.has("env-resolved-token-12345678")).toBe(true)
		})

		it("resolves $VAR interpolation in headers", () => {
			process.env.MY_TOKEN = "interpolated-token-12345678"
			vi.mocked(loadMcpConfig).mockReturnValue({
				config: {
					mcpServers: {
						svc: { url: "https://mcp.example.com", headers: { Authorization: "Bearer $MY_TOKEN" } },
					},
				},
				warnings: [],
			})
			const secrets = collectKnownSecrets()
			expect(secrets.has("interpolated-token-12345678")).toBe(true)
		})

		it("resolves ${VAR} interpolation in headers", () => {
			process.env.MY_TOKEN = "interpolated-token-12345678"
			vi.mocked(loadMcpConfig).mockReturnValue({
				config: {
					mcpServers: {
						svc: { url: "https://mcp.example.com", headers: { Authorization: "Bearer ${MY_TOKEN}" } },
					},
				},
				warnings: [],
			})
			const secrets = collectKnownSecrets()
			expect(secrets.has("interpolated-token-12345678")).toBe(true)
		})

		it("handles servers with no bearer auth", () => {
			vi.mocked(loadMcpConfig).mockReturnValue({
				config: {
					mcpServers: {
						a: { url: "https://mcp.example.com", headers: { "X-Custom": "value" } },
						b: { command: "my-mcp-server" },
					},
				},
				warnings: [],
			})
			const secrets = collectKnownSecrets()
			expect(secrets.size).toBe(0)
		})

		it("handles empty server list", () => {
			vi.mocked(loadMcpConfig).mockReturnValue({ config: { mcpServers: {} }, warnings: [] })
			const secrets = collectKnownSecrets()
			expect(secrets.size).toBe(0)
		})
	})

	describe("error resilience", () => {
		it("returns empty set when config throws", () => {
			vi.mocked(readApiKeyFromConfigFile).mockImplementation(() => {
				throw new Error("read failed")
			})
			vi.mocked(readAllGitTokens).mockImplementation(() => {
				throw new Error("read failed")
			})
			vi.mocked(loadMcpConfig).mockImplementation(() => {
				throw new Error("read failed")
			})
			const secrets = collectKnownSecrets()
			expect(secrets.size).toBe(0)
		})
	})
})
