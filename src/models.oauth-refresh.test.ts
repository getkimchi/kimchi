import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isCredentialStale, markCredentialStale, resetCredentialStalenessForTests } from "./credential-staleness.js"
import { installKimchiOAuth } from "./extensions/login/flow.js"
import { updateModelsConfig } from "./models.js"
import { fakeOAuthDeps } from "./modes/acp/ext-methods/oauth-test-utils.js"

const AI_ENABLER_MODEL = {
	slug: "kimi-k3.1-pro",
	display_name: "Kimi K3.1 Pro",
	provider: "ai-enabler",
	reasoning: true,
	input_modalities: ["text"],
	is_serverless: true,
	limits: { context_window: 262_144, max_output_tokens: 32_768 },
}

const ANTHROPIC_MODEL = {
	slug: "claude-sonnet-4-6",
	display_name: "Claude Sonnet 4.6",
	provider: "anthropic",
	reasoning: true,
	input_modalities: ["text"],
	is_serverless: true,
	limits: { context_window: 1_000_000, max_output_tokens: 128_000 },
}

describe("OAuth-aware model discovery", () => {
	let dir: string
	let authPath: string
	let modelsPath: string
	let server: Server | undefined

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-models-oauth-"))
		authPath = join(dir, "auth.json")
		modelsPath = join(dir, "models.json")
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", dir)
		resetCredentialStalenessForTests()
	})

	afterEach(async () => {
		if (server) {
			server.closeAllConnections()
			await new Promise<void>((resolve) => server?.close(() => resolve()))
		}
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
		resetCredentialStalenessForTests()
		rmSync(dir, { recursive: true, force: true })
	})

	it("refreshes and persists an expiring OAuth credential before one catalog request", async () => {
		const requestOrder: string[] = []
		let metadataUsedReplacement = false
		let metadataUsedOrganization = false
		server = createServer((request, response) => {
			if (request.method === "POST" && request.url === "/oauth/token") {
				request.resume()
				request.on("end", () => {
					requestOrder.push("refresh")
					response.writeHead(200, { "content-type": "application/json" })
					response.end(JSON.stringify({ access_token: "replacement-fake-access", expires_in: 3600 }))
				})
				return
			}
			if (request.method === "GET" && request.url === "/v1/models/metadata?include_in_cli=true") {
				requestOrder.push("metadata")
				metadataUsedReplacement = request.headers.authorization === "Bearer replacement-fake-access"
				metadataUsedOrganization = request.headers["x-castai-organization-id"] === "fake-org"
				response.writeHead(200, { "content-type": "application/json" })
				response.end(JSON.stringify({ models: [AI_ENABLER_MODEL, ANTHROPIC_MODEL] }))
				return
			}
			response.writeHead(404).end()
		})
		const endpoint = await listen(server)
		writeExpiringAuth(`${endpoint}/oauth/token`)
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"kimchi-dev/anthropic": { api: "anthropic-messages", models: [] },
					custom: {
						api: "openai-completions",
						models: [
							{
								id: "custom-model",
								name: "Custom Model",
								provider: "custom",
								reasoning: false,
								input: ["text"],
								contextWindow: 8192,
								maxTokens: 1024,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			}),
		)

		const result = await updateModelsConfig(modelsPath, "", {
			endpoint,
			refreshOAuth: { authPath, installOAuth: installKimchiOAuth },
		})

		expect(requestOrder).toEqual(["refresh", "metadata"])
		expect(metadataUsedReplacement).toBe(true)
		expect(metadataUsedOrganization).toBe(true)
		expect(result.models.map((model) => model.slug)).toEqual(["claude-sonnet-4-6", "custom-model", "kimi-k3.1-pro"])
		const persistedAuth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>
		expect(persistedAuth["kimchi-dev"]).toMatchObject({
			access: "replacement-fake-access",
			refresh: "fake-refresh",
			orgId: "fake-org",
		})
		expect(persistedAuth["kimchi-dev/anthropic"]).toMatchObject({
			access: "replacement-fake-access",
			refresh: "fake-refresh",
			orgId: "fake-org",
		})
		const persistedModels = JSON.parse(readFileSync(modelsPath, "utf8"))
		expect(persistedModels.providers.custom.models.map((model: { id: string }) => model.id)).toEqual(["custom-model"])
		expect(persistedModels.providers["kimchi-dev"].models.map((model: { id: string }) => model.id)).toEqual([
			"kimi-k3.1-pro",
		])
		expect(persistedModels.providers["kimchi-dev/anthropic"].models.map((model: { id: string }) => model.id)).toEqual([
			"claude-sonnet-4-6",
		])
	})

	it("clears prior rejection without using a refreshed credential when sibling persistence fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		writeExpiringAuth()
		writeCachedModels()
		markCredentialStale(undefined, "kimchi-dev")
		markCredentialStale("expiring-fake-access", "kimchi-dev")
		let metadataRequests = 0
		server = createServer((_request, response) => {
			metadataRequests += 1
			response.writeHead(500).end()
		})
		const endpoint = await listen(server)
		const deps = fakeOAuthDeps((credential) => ({
			...credential,
			access: "replacement-fake-access",
			expires: Date.now() + 3600_000,
		}))

		const result = await updateModelsConfig(modelsPath, "", {
			endpoint,
			refreshOAuth: {
				authPath,
				installOAuth: deps.installOAuth,
				syncOAuthCredential: () => Promise.reject(new Error("read-only models.json")),
			},
		})

		expect(result.models.map((model) => model.slug)).toEqual(["cached-model"])
		expect(deps.refreshCalls).toHaveLength(1)
		expect(metadataRequests).toBe(0)
		const persistedAuth = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { access: string }>
		expect(persistedAuth["kimchi-dev"].access).toBe("replacement-fake-access")
		expect(persistedAuth["kimchi-dev/anthropic"].access).toBe("expiring-fake-access")
		expect(isCredentialStale(undefined, "kimchi-dev")).toBe(false)
		expect(isCredentialStale("expiring-fake-access", "kimchi-dev")).toBe(false)
		resetCredentialStalenessForTests()
		expect(isCredentialStale("expiring-fake-access", "kimchi-dev")).toBe(false)
	})

	it("uses cached models without signing out when the refresh issuer returns 500", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		const refresh = await startTokenResponse(500, { error: "server_error" })
		writeExpiringAuth(refresh.tokenUrl)
		writeCachedModels()

		const result = await updateModelsConfig(modelsPath, "", {
			endpoint: refresh.endpoint,
			refreshOAuth: { authPath, installOAuth: installKimchiOAuth },
		})

		expect(result.models.map((model) => model.slug)).toEqual(["cached-model"])
		expect(refresh.metadataRequests()).toBe(0)
		expect(isCredentialStale("expiring-fake-access", "kimchi-dev")).toBe(false)
	})

	it("uses the existing staleness flow for a definitive invalid_grant", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {})
		const refresh = await startTokenResponse(400, { error: "invalid_grant", error_description: "revoked" })
		writeExpiringAuth(refresh.tokenUrl)
		writeCachedModels()

		const result = await updateModelsConfig(modelsPath, "", {
			endpoint: refresh.endpoint,
			refreshOAuth: { authPath, installOAuth: installKimchiOAuth },
		})

		expect(result.models.map((model) => model.slug)).toEqual(["cached-model"])
		expect(refresh.metadataRequests()).toBe(0)
		expect(isCredentialStale("expiring-fake-access", "kimchi-dev")).toBe(true)
		resetCredentialStalenessForTests()
		expect(isCredentialStale("expiring-fake-access", "kimchi-dev")).toBe(true)
		expect(isCredentialStale("unrelated-fake-access", "kimchi-dev")).toBe(false)
	})

	it("preserves the caller organization when stored OAuth has no organization", async () => {
		let metadataUsedOrganization = false
		server = createServer((request, response) => {
			metadataUsedOrganization = request.headers["x-castai-organization-id"] === "caller-fake-org"
			response.writeHead(200, { "content-type": "application/json" })
			response.end(JSON.stringify({ models: [AI_ENABLER_MODEL] }))
		})
		const endpoint = await listen(server)
		writeFileSync(
			authPath,
			JSON.stringify({
				"kimchi-dev": {
					type: "oauth",
					access: "valid-fake-access",
					refresh: "fake-refresh",
					expires: Date.now() + 3600_000,
				},
			}),
		)

		const result = await updateModelsConfig(modelsPath, "", {
			endpoint,
			organizationId: "caller-fake-org",
			refreshOAuth: { authPath, installOAuth: installKimchiOAuth },
		})

		expect(result.models.map((model) => model.slug)).toEqual(["kimi-k3.1-pro"])
		expect(metadataUsedOrganization).toBe(true)
	})

	function writeExpiringAuth(tokenUrl = "http://127.0.0.1:1/oauth/token"): void {
		const credential = {
			type: "oauth",
			access: "expiring-fake-access",
			refresh: "fake-refresh",
			expires: Date.now() + 60_000,
			tokenUrl,
			clientId: "fake-client",
			useIdToken: false,
			orgId: "fake-org",
		}
		writeFileSync(authPath, JSON.stringify({ "kimchi-dev": credential, "kimchi-dev/anthropic": credential }))
	}

	function writeCachedModels(): void {
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"kimchi-dev": {
						baseUrl: "https://llm.kimchi.dev/openai/v1",
						apiKey: "$KIMCHI_API_KEY",
						api: "openai-completions",
						authHeader: true,
						models: [
							{
								id: "cached-model",
								name: "Cached Model",
								provider: "ai-enabler",
								reasoning: false,
								input: ["text"],
								contextWindow: 8192,
								maxTokens: 1024,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
					"kimchi-dev/anthropic": {
						baseUrl: "https://llm.kimchi.dev/anthropic",
						apiKey: "$KIMCHI_API_KEY",
						api: "anthropic-messages",
						authHeader: true,
						models: [],
					},
				},
			}),
		)
	}

	async function startTokenResponse(status: number, body: Record<string, unknown>) {
		let metadataRequests = 0
		server = createServer((request, response) => {
			if (request.method === "POST" && request.url === "/oauth/token") {
				request.resume()
				request.on("end", () => {
					response.writeHead(status, { "content-type": "application/json" })
					response.end(JSON.stringify(body))
				})
				return
			}
			metadataRequests += 1
			response.writeHead(500).end()
		})
		const endpoint = await listen(server)
		return { endpoint, tokenUrl: `${endpoint}/oauth/token`, metadataRequests: () => metadataRequests }
	}

	async function listen(target: Server): Promise<string> {
		await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve))
		const address = target.address() as AddressInfo
		return `http://127.0.0.1:${address.port}`
	}
})
