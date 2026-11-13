import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { filterCodexSubscription, isCodexGatewayAvailable, withGatewayOptions } from "./codex-gateway.js"
import { resetCodexSession } from "./codex-request-context.js"

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
			headers: {
				"User-Agent": expect.stringMatching(/^kimchi\//),
				"x-extra": "1",
				originator: "kimchi",
				"X-API-Key": "kimchi-key",
			},
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

	it("leaves a model outside the gateway without correlation fields or an onPayload wrapper", () => {
		useApiKey()
		const onPayload = vi.fn()
		const given: StreamOptions = { sessionId: "s1", onPayload, headers: { "x-extra": "1" } }
		const options = withGatewayOptions({ baseUrl: "https://chatgpt.com/backend-api" }, given)
		expect(options).toBe(given)
		expect(options.headers).not.toHaveProperty("originator")
		expect(options.headers).not.toHaveProperty("thread-id")
		expect(options.onPayload).toBe(onPayload)
	})

	it("sends no SSO token as X-API-Key", () => {
		useSso()
		const given: StreamOptions = { sessionId: "s1", headers: { "x-extra": "1" } }
		const options = withGatewayOptions({ baseUrl: GATEWAY }, given)
		expect(options).toBe(given)
		expect(options.headers).not.toHaveProperty("originator")
		expect(options.headers).not.toHaveProperty("thread-id")
	})
})

describe("withGatewayOptions correlation", () => {
	const model = { baseUrl: GATEWAY }

	beforeEach(() => {
		useApiKey()
		resetCodexSession("s1")
	})

	it("adds Codex correlation headers", () => {
		const options: StreamOptions | undefined = withGatewayOptions(model, { sessionId: "s1" })
		const headers = options?.headers as Record<string, string>
		expect(headers.originator).toBe("kimchi")
		expect(headers["thread-id"]).toBe("s1")
		expect(headers["x-codex-window-id"]).toBe("s1:0")
		const metadata = JSON.parse(headers["x-codex-turn-metadata"])
		expect(Object.keys(metadata).sort()).toEqual(
			["session_id", "thread_id", "turn_id", "request_kind", "window_id", "window_number"].sort(),
		)
		expect(metadata).toMatchObject({
			session_id: "s1",
			thread_id: "s1",
			request_kind: "turn",
			window_id: "s1:0",
			window_number: 0,
		})
	})

	it("adds client_metadata to the payload after the caller's onPayload", async () => {
		const callerOnPayload = vi.fn(async (p: unknown) => ({ ...(p as object), marker: 1 }))
		const options: StreamOptions | undefined = withGatewayOptions(model, {
			sessionId: "s1",
			onPayload: callerOnPayload,
		})
		const payload = (await options?.onPayload?.({ model: "m" }, model as unknown as Model<Api>)) as Record<
			string,
			unknown
		>
		expect(callerOnPayload).toHaveBeenCalledOnce()
		expect(payload.marker).toBe(1)
		const clientMetadata = payload.client_metadata as Record<string, string>
		expect(Object.keys(clientMetadata).sort()).toEqual(
			["session_id", "thread_id", "turn_id", "x-codex-window-id"].sort(),
		)
		expect(clientMetadata["x-codex-window-id"]).toBe("s1:0")
	})

	it("keeps the payload when the caller's onPayload returns undefined", async () => {
		const options: StreamOptions | undefined = withGatewayOptions(model, {
			sessionId: "s1",
			onPayload: () => undefined,
		})
		const payload = (await options?.onPayload?.({ model: "m" }, model as unknown as Model<Api>)) as Record<
			string,
			unknown
		>
		expect(payload).toMatchObject({ model: "m" })
		expect(payload.client_metadata).toBeDefined()
	})

	it("adds nothing without a session id", () => {
		const onPayload = vi.fn()
		const options: StreamOptions | undefined = withGatewayOptions(model, { onPayload })
		const headers = options?.headers as Record<string, string>
		expect(headers.originator).toBe("kimchi")
		expect(headers).not.toHaveProperty("thread-id")
		expect(headers).not.toHaveProperty("x-codex-window-id")
		expect(headers).not.toHaveProperty("x-codex-turn-metadata")
		expect(options?.onPayload).toBe(onPayload)
	})

	it("passes the parent session header through unchanged", () => {
		const options: StreamOptions | undefined = withGatewayOptions(model, {
			sessionId: "s1",
			headers: { "X-Parent-Session-Id": "p1" },
		})
		expect((options?.headers as Record<string, string>)["X-Parent-Session-Id"]).toBe("p1")
	})
})
