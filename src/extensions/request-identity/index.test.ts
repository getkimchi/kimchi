import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { complete, getModel } from "@earendil-works/pi-ai/compat"
import type { BeforeProviderHeadersEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveEndpoints } from "../../config.js"
import { installGlobalFetchInstrumentation } from "../../http/instrument-fetch.js"
import { clearProjectScopeTrust, setProjectScopeTrusted } from "../../project-scope-trust.js"
import { setResourceOverride } from "../../resources/store.js"
import { INFRA_BREAKER_THRESHOLD_ENV } from "../../upstream-retry-patch.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { runAsAgentWorker } from "../agent-worker-context.js"
import { PARENT_SESSION_ID_ENV_KEY } from "../agents/manager/constants.js"
import { CI_VARIABLES } from "../pr-cost-reporting/automation.js"
import { setPRReportingSessionMode } from "../pr-cost-reporting/consent.js"
import { COST_PER_PR_RESOURCE_ID } from "../pr-cost-reporting/resource.js"
import requestTimingExtension from "../request-timing.js"
import requestIdentityExtension, {
	getActiveRequestId,
	pinRequestContext,
	prepareProviderRequest,
	trackProviderRequest,
} from "./index.js"

let dir: string
let gatewayUrl: string
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-request-identity-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
	for (const name of [...CI_VARIABLES, "KIMCHI_PR_COST_REPORTING", INFRA_BREAKER_THRESHOLD_ENV]) vi.stubEnv(name, "")
	vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
	setPRReportingSessionMode("tui")
	gatewayUrl = `${resolveEndpoints({ cwd: dir }).openAiBaseUrl}/chat/completions`
})

afterEach(() => {
	setPRReportingSessionMode(undefined)
	setResourceOverride(COST_PER_PR_RESOURCE_ID, undefined)
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	rmSync(dir, { recursive: true, force: true })
})

function session(sessionId: string) {
	return createContext({ cwd: dir, sessionManager: { getSessionId: () => sessionId } })
}

/** Start an identity extension for a session, as Pi does on session_start. */
async function startSession(sessionId: string) {
	const api = createExtensionApi()
	requestIdentityExtension(api.api)
	const ctx = session(sessionId)
	await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)
	return { api, ctx }
}

/** The headers of one dispatch of a tracked request, as the fetch hook prepares them. */
function dispatch(requestId: string, url = gatewayUrl, init: Record<string, string> = {}, bodyTags: string[] = []) {
	const headers = new Headers({ ...init, "X-Request-Id": requestId })
	prepareProviderRequest(headers, url, { bodyTags })
	return headers
}

async function mainRequest(api: ReturnType<typeof createExtensionApi>, ctx: ReturnType<typeof session>) {
	const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
	await api.emit("before_provider_headers", event, ctx)
	return event
}

describe("PR reporting headers", () => {
	it("tells the gateway it may report a request and names its session and turn", async () => {
		const { api, ctx } = await startSession("main-session")
		await api.emit("before_agent_start", { type: "before_agent_start", prompt: "Fix it" }, ctx)
		await api.emit("turn_start", { type: "turn_start" }, ctx)
		const { headers } = await mainRequest(api, ctx)
		const wire = dispatch(String(headers["X-Request-Id"]))
		expect(wire.get("x-kimchi-pr-reporting")).toBe("proxy")
		expect(wire.get("x-session-id")).toBe("main-session")
		expect(wire.get("x-turn-index")).toBe("1")
		expect(wire.has("x-parent-session-id")).toBe(false)
	})

	it("sends only off when reporting is not allowed", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		const { ctx } = await startSession("quiet-session")
		const wire = dispatch(trackProviderRequest(ctx))
		expect(wire.get("x-kimchi-pr-reporting")).toBe("off")
		expect(wire.has("x-session-id")).toBe(false)
		expect(wire.has("x-turn-index")).toBe(false)
	})

	it("leaves requests outside the configured gateway without PR headers or tag", async () => {
		const { ctx } = await startSession("main-session")
		const requestId = trackProviderRequest(ctx)
		const wire = dispatch(requestId, "https://api.openai.com/v1/chat/completions", { Authorization: "Bearer key" })
		expect(Object.fromEntries(wire)).toEqual({ authorization: "Bearer key", "x-request-id": requestId })
	})

	it("keeps the session headers telemetry already set on a main request", async () => {
		const { ctx } = await startSession("main-session")
		const wire = dispatch(trackProviderRequest(ctx), gatewayUrl, { "X-Session-Id": "telemetry", "X-Turn-Index": "7" })
		expect(wire.get("x-session-id")).toBe("telemetry")
		expect(wire.get("x-turn-index")).toBe("7")
	})

	it("names the parent session of a subagent request", async () => {
		vi.stubEnv(PARENT_SESSION_ID_ENV_KEY, "parent-session")
		const { ctx } = await startSession("child-session")
		const wire = dispatch(await runAsAgentWorker(async () => trackProviderRequest(ctx)))
		expect(wire.get("x-session-id")).toBe("child-session")
		expect(wire.get("x-parent-session-id")).toBe("parent-session")
		// Outside a subagent run the same environment names no parent.
		expect(dispatch(trackProviderRequest(ctx)).has("x-parent-session-id")).toBe(false)
	})

	it("counts turns like telemetry: one per round-trip, never reset by a new prompt", async () => {
		const { api, ctx } = await startSession("main-session")
		const turn = () => dispatch(trackProviderRequest(ctx)).get("x-turn-index")
		expect(turn()).toBe("0")
		const turns: (string | null)[] = []
		for (const rounds of [2, 1]) {
			await api.emit("before_agent_start", { type: "before_agent_start", prompt: "Next" }, ctx)
			for (let round = 0; round < rounds; round++) {
				await api.emit("turn_start", { type: "turn_start" }, ctx)
				turns.push(turn())
			}
		}
		expect(turns).toEqual(["1", "2", "3"])
		await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
		expect(dispatch(trackProviderRequest(ctx)).has("x-turn-index")).toBe(false)
	})

	it("keeps a session's identity when an older instance of the same session shuts down", async () => {
		const older = await startSession("main-session")
		const newer = await startSession("main-session")
		const current = await mainRequest(newer.api, newer.ctx)
		await older.api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, older.ctx)
		expect(getActiveRequestId(newer.ctx)).toBe(current.headers["X-Request-Id"])
		expect(dispatch(trackProviderRequest(newer.ctx)).get("x-turn-index")).toBe("0")
	})

	it("reports a side call under the session pinned before it awaited", () => {
		let sessionId = "first-session"
		const ctx = createContext({ cwd: dir, sessionManager: { getSessionId: () => sessionId } })
		const pinned = pinRequestContext(ctx)
		sessionId = "next-session"
		expect(dispatch(trackProviderRequest(pinned)).get("x-session-id")).toBe("first-session")
	})
})

describe("request IDs and tags", () => {
	it("gives each attempt its own ID and tag and drops the previous attempt's tag", async () => {
		const { ctx } = await startSession("main-session")
		const logicalId = trackProviderRequest(ctx)
		const first = dispatch(logicalId, gatewayUrl, { "X-Tags": "team:one" })
		expect(first.get("x-request-id")).toBe(logicalId)
		expect(first.get("x-tags")).toBe(`team:one,kimchi-request:${logicalId}`)
		// An SDK retry can resend the headers it was given, including our tag.
		const retry = dispatch(logicalId, gatewayUrl, { "X-Tags": `team:one,kimchi-request:${logicalId}` })
		const retryId = retry.get("x-request-id")
		expect(retryId).toMatch(UUID)
		expect(retryId).not.toBe(logicalId)
		expect(retry.get("x-tags")).toBe(`team:one,kimchi-request:${retryId}`)
		expect(retry.get("x-session-id")).toBe("main-session")
	})

	it.each([
		{ bodyTags: undefined, header: "team:one", reason: "body-uninspectable" },
		{ bodyTags: Array.from({ length: 10 }, () => "duplicate:tag"), header: "", reason: "tag-limit" },
		{ bodyTags: ["kimchi-request:user-owned"], header: "team:one", reason: "reserved-tag" },
	])("keeps user tags and adds none when the request has no room ($reason)", async ({ bodyTags, header }) => {
		const { ctx } = await startSession("main-session")
		const requestId = trackProviderRequest(ctx)
		const headers = new Headers({ "X-Request-Id": requestId, "X-Tags": header })
		prepareProviderRequest(headers, gatewayUrl, { bodyTags })
		expect(headers.get("x-tags")).toBe(header)
		expect(headers.get("x-request-id")).toBe(requestId)
		expect(headers.get("x-kimchi-pr-reporting")).toBe("proxy")
	})

	it("sends no request ID or tag while Cost per PR is disabled, but still says off", async () => {
		setResourceOverride(COST_PER_PR_RESOURCE_ID, false)
		const { api, ctx } = await startSession("main-session")
		const { headers } = await mainRequest(api, ctx)
		const wire = dispatch(String(headers["X-Request-Id"]), gatewayUrl, { "X-Tags": "team:one" })
		expect(Object.fromEntries(wire)).toEqual({ "x-kimchi-pr-reporting": "off", "x-tags": "team:one" })
		expect(getActiveRequestId(ctx)).toBeUndefined()
	})

	it("finds the gateway by origin and path, whatever the configured host's case or default port", async () => {
		vi.stubEnv("KIMCHI_BASE_URL", "https://LLM.Example.TEST:443")
		const completions = new URL(`${resolveEndpoints({ cwd: dir }).openAiBaseUrl}/chat/completions`).href
		const { ctx } = await startSession("main-session")
		const reporting = (url: string) => {
			const headers = new Headers({ "X-Request-Id": trackProviderRequest(ctx) })
			prepareProviderRequest(headers, url, { bodyTags: [] })
			return headers.get("x-kimchi-pr-reporting")
		}
		expect(reporting(completions)).toBe("proxy")
		expect(reporting(`${completions}?beta=true`)).toBe("proxy")
		expect(reporting(completions.replace("https://", "https://user:secret@"))).toBeNull()
		expect(reporting(completions.replace("/v1/", "/v10/"))).toBeNull()
	})

	it("still finds the gateway when another configured endpoint is not a URL", async () => {
		vi.stubEnv("KIMCHI_BASE_URL", "")
		mkdirSync(join(dir, ".kimchi"))
		writeFileSync(join(dir, ".kimchi", "config.json"), JSON.stringify({ llmEndpoint: "gateway.example.test/v1" }), {
			mode: 0o600,
		})
		setProjectScopeTrusted(dir, true)
		try {
			expect(resolveEndpoints({ cwd: dir }).llmEndpoint).toBe("gateway.example.test/v1")
			const { ctx } = await startSession("main-session")
			expect(dispatch(trackProviderRequest(ctx)).get("x-kimchi-pr-reporting")).toBe("proxy")
		} finally {
			clearProjectScopeTrust(dir)
		}
	})

	it("tags an image-heavy request sent through the fetch instrumentation", async () => {
		const { ctx } = await startSession("main-session")
		const requestId = trackProviderRequest(ctx)
		const sent = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"))
		vi.stubGlobal("fetch", sent)
		installGlobalFetchInstrumentation({ userAgent: "test", onModelRequest: prepareProviderRequest })
		const image = `data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}`
		const body = JSON.stringify({ messages: [{ content: [{ type: "image_url", image_url: { url: image } }] }] })
		await fetch(gatewayUrl, { method: "POST", headers: { "X-Request-Id": requestId }, body })
		expect(new Headers(sent.mock.calls[0][1]?.headers).get("x-tags")).toBe(`kimchi-request:${requestId}`)
	})

	it("keeps the main request's identity when a side call retries", async () => {
		const { api, ctx } = await startSession("main-session")
		const main = await mainRequest(api, ctx)
		const mainId = String(main.headers["X-Request-Id"])
		dispatch(mainId)
		expect(getActiveRequestId(ctx)).toBe(mainId)
		const sideCall = trackProviderRequest(ctx)
		dispatch(sideCall)
		expect(dispatch(sideCall).get("x-request-id")).not.toBe(sideCall)
		expect(getActiveRequestId(ctx)).toBe(mainId)
		expect(main.headers["X-Request-Id"]).toBe(mainId)
	})

	it("moves an older main request's retries off the active request once another starts", async () => {
		const { api, ctx } = await startSession("main-session")
		const original = await mainRequest(api, ctx)
		const logicalId = String(original.headers["X-Request-Id"])
		dispatch(logicalId)
		const retryId = dispatch(logicalId).get("x-request-id")
		expect(getActiveRequestId(ctx)).toBe(retryId)
		const current = await mainRequest(api, ctx)
		for (const id of [logicalId, String(retryId)]) {
			expect(dispatch(id).get("x-request-id")).not.toBe(id)
			expect(getActiveRequestId(ctx)).toBe(current.headers["X-Request-Id"])
		}
		await api.emit("turn_start", { type: "turn_start" }, ctx)
		expect(getActiveRequestId(ctx)).toBeUndefined()
	})

	it.each([
		"http",
		"network",
	])("gives Pi's hidden %s retry its own ID and tag, and records the successful attempt", async (failure) => {
		vi.stubEnv("KIMCHI_STREAM_IDLE_TIMEOUT_MS", "0")
		const model = {
			...getModel("openai", "gpt-4o-mini"),
			api: "openai-completions" as const,
			baseUrl: resolveEndpoints({ cwd: dir }).openAiBaseUrl,
		}
		const ctx = createContext({ cwd: dir, model, sessionManager: { getSessionId: () => "main-session" } })
		const api = createExtensionApi()
		requestIdentityExtension(api.api)
		requestTimingExtension(api.api)
		await api.emit("session_start", { type: "session_start", reason: "startup" }, ctx)
		const event = await mainRequest(api, ctx)
		const logicalId = event.headers["X-Request-Id"]
		const calls: { requestId: string | null; tag: string | null; reporting: string | null }[] = []
		vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers)
			calls.push({
				requestId: headers.get("x-request-id"),
				tag: headers.get("x-tags"),
				reporting: headers.get("x-kimchi-pr-reporting"),
			})
			if (calls.length === 1) {
				if (failure === "network") throw new TypeError("fetch failed")
				return Response.json(
					{ error: { message: "retry", type: "server_error" } },
					{ status: 503, headers: { "Retry-After": "0" } },
				)
			}
			const chunk = {
				id: "chat",
				object: "chat.completion.chunk",
				created: 1,
				model: model.id,
				choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
			}
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { "Content-Type": "text/event-stream" },
			})
		})
		installGlobalFetchInstrumentation({ userAgent: "retry-test", onModelRequest: prepareProviderRequest })
		const result = await complete(
			model,
			{ messages: [{ role: "user", content: "Say done", timestamp: Date.now() }] },
			{
				apiKey: "fake",
				headers: event.headers,
				maxRetries: 1,
				maxRetryDelayMs: 1,
				onResponse: async (response) => {
					await api.emit("after_provider_response", { type: "after_provider_response", ...response }, ctx)
				},
			},
		)
		expect(result.errorMessage).toBeUndefined()
		expect(calls).toHaveLength(2)
		expect(calls[0].requestId).toBe(logicalId)
		expect(calls[1].requestId).toMatch(UUID)
		expect(calls[1].requestId).not.toBe(logicalId)
		expect(calls.map((call) => call.tag)).toEqual(calls.map((call) => `kimchi-request:${call.requestId}`))
		expect(calls.map((call) => call.reporting)).toEqual(["proxy", "proxy"])
		await api.emit("message_end", { message: result }, ctx)
		expect(api.getAppendedEntries("request_diagnostics")).toEqual([
			expect.objectContaining({ requestId: calls[1].requestId, status: 200 }),
		])
	})

	it("leaves untracked request IDs unchanged", () => {
		const headers = new Headers({ "X-Request-Id": "someone-else" })
		prepareProviderRequest(headers, gatewayUrl, { bodyTags: [] })
		expect(Object.fromEntries(headers)).toEqual({ "x-request-id": "someone-else" })
	})
})
