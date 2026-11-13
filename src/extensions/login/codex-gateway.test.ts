import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { filterCodexSubscription, isCodexGatewayAvailable, withGatewayOptions } from "./codex-gateway.js"

const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }))

vi.mock("../../config.js", () => ({ loadConfig: loadConfigMock }))

const GATEWAY = "https://gw.example/openai/v1"
const SSO_AUTH = { "kimchi-dev": { type: "oauth", access: "sso-jwt", orgId: "org-1" } }

let agentDir: string

function writeModels(codexModels: unknown[]): void {
	const providers = codexModels.length > 0 ? { "openai-codex": { baseUrl: GATEWAY, models: codexModels } } : {}
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers }))
}

function useApiKey(): void {
	loadConfigMock.mockReturnValue({ apiKey: "kimchi-key", customLlmEndpoint: "https://gw.example" })
}

function useSso(): void {
	loadConfigMock.mockReturnValue({ apiKey: "", customLlmEndpoint: "https://gw.example" })
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(SSO_AUTH))
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "kimchi-codex-gateway-"))
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", agentDir)
})

afterEach(() => {
	vi.unstubAllEnvs()
	loadConfigMock.mockReset()
	rmSync(agentDir, { recursive: true, force: true })
})

describe("isCodexGatewayAvailable", () => {
	it("is true for an API key session when the feed listed chatgpt models", () => {
		useApiKey()
		writeModels([{ id: "gpt-6-sol" }])
		expect(isCodexGatewayAvailable()).toBe(true)
	})

	it("is false when the feed listed no chatgpt models", () => {
		useApiKey()
		writeModels([])
		expect(isCodexGatewayAvailable()).toBe(false)
	})

	it("is false for an SSO session: the gateway accepts only a Kimchi API key next to a ChatGPT login", () => {
		useSso()
		writeModels([{ id: "gpt-6-sol" }])
		expect(isCodexGatewayAvailable()).toBe(false)
	})
})

describe("filterCodexSubscription", () => {
	const providers = [{ id: "anthropic" }, { id: "openai-codex" }]

	it("keeps OpenAI Codex when the gateway offers it", () => {
		useApiKey()
		writeModels([{ id: "gpt-6-sol" }])
		expect(filterCodexSubscription(providers).map((p) => p.id)).toEqual(["anthropic", "openai-codex"])
	})

	it("drops OpenAI Codex otherwise and keeps the rest", () => {
		useSso()
		writeModels([{ id: "gpt-6-sol" }])
		expect(filterCodexSubscription(providers).map((p) => p.id)).toEqual(["anthropic"])
	})
})

describe("withGatewayOptions", () => {
	it("adds the Kimchi key, SSE and the kimchi user agent for a gateway model", () => {
		useApiKey()
		expect(withGatewayOptions({ baseUrl: GATEWAY }, { headers: { "x-extra": "1" } })).toEqual({
			transport: "sse",
			headers: { "User-Agent": expect.stringMatching(/^kimchi\//), "x-extra": "1", "X-API-Key": "kimchi-key" },
		})
	})

	it("matches the gateway URL however the endpoint was written", () => {
		loadConfigMock.mockReturnValue({ apiKey: "kimchi-key", customLlmEndpoint: "gw.example/" })
		expect(withGatewayOptions({ baseUrl: GATEWAY }, undefined)).toMatchObject({
			headers: { "X-API-Key": "kimchi-key" },
		})
	})

	it("sends no Kimchi key to a model outside the gateway (old Codex login pointing at chatgpt.com)", () => {
		useApiKey()
		const options = withGatewayOptions({ baseUrl: "https://chatgpt.com/backend-api" }, { headers: { "x-extra": "1" } })
		expect(options).toEqual({ headers: { "x-extra": "1" } })
	})

	it("sends no SSO token as X-API-Key", () => {
		useSso()
		const options = withGatewayOptions({ baseUrl: GATEWAY }, { headers: { "x-extra": "1" } })
		expect(options).toEqual({ headers: { "x-extra": "1" } })
	})
})
