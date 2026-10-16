import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BeforeProviderHeadersEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveEndpoints } from "../../config.js"
import { installGlobalFetchInstrumentation } from "../../http/instrument-fetch.js"
import { setResourceOverride } from "../../resources/store.js"
import { INFRA_BREAKER_THRESHOLD_ENV } from "../../upstream-retry-patch.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { runAsAgentWorker } from "../agent-worker-context.js"
import { PARENT_SESSION_ID_ENV_KEY } from "../agents/manager/constants.js"
import { CI_VARIABLES } from "../pr-cost-reporting/automation.js"
import { setPRReportingSessionMode } from "../pr-cost-reporting/consent.js"
import { COST_PER_PR_RESOURCE_ID } from "../work-attribution/resource.js"
import requestIdentityExtension, {
	applyPRReportingHeaders,
	pinRequestContext,
	prepareProviderRequest,
	requestCorrelation,
	trackProviderRequest,
} from "./index.js"

let dir: string
let gatewayUrl: string

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

describe("PR reporting headers", () => {
	it("tells the gateway it may report a request and names its session and turn", async () => {
		const { api, ctx } = await startSession("main-session")
		await api.emit("before_agent_start", { type: "before_agent_start", prompt: "Fix it" }, ctx)
		await api.emit("turn_start", { type: "turn_start" }, ctx)
		const headers = new Headers()
		applyPRReportingHeaders(headers, gatewayUrl, requestCorrelation(ctx))
		expect(Object.fromEntries(headers)).toEqual({
			"x-kimchi-pr-reporting": "proxy",
			"x-session-id": "main-session",
			"x-turn-index": "1",
		})
	})

	it("sends only off when reporting is not allowed", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		const { ctx } = await startSession("quiet-session")
		const headers = new Headers()
		applyPRReportingHeaders(headers, gatewayUrl, requestCorrelation(ctx))
		expect(Object.fromEntries(headers)).toEqual({ "x-kimchi-pr-reporting": "off" })
	})

	it.each([
		"https://api.openai.com/v1/chat/completions",
		"not a url",
	])("leaves requests outside the configured gateway unchanged: %s", async (url) => {
		const { ctx } = await startSession("main-session")
		const headers = new Headers({ Authorization: "Bearer key" })
		applyPRReportingHeaders(headers, url, requestCorrelation(ctx))
		expect(Object.fromEntries(headers)).toEqual({ authorization: "Bearer key" })
	})

	it("keeps the session headers telemetry already set on a main request", async () => {
		const { ctx } = await startSession("main-session")
		const headers = new Headers({ "X-Session-Id": "telemetry-session", "X-Turn-Index": "7" })
		applyPRReportingHeaders(headers, gatewayUrl, requestCorrelation(ctx))
		expect(headers.get("x-session-id")).toBe("telemetry-session")
		expect(headers.get("x-turn-index")).toBe("7")
	})

	it("names the parent session of a subagent request", async () => {
		vi.stubEnv(PARENT_SESSION_ID_ENV_KEY, "parent-session")
		const { ctx } = await startSession("child-session")
		const headers = new Headers()
		const correlation = await runAsAgentWorker(async () => requestCorrelation(ctx))
		applyPRReportingHeaders(headers, gatewayUrl, correlation)
		expect(headers.get("x-session-id")).toBe("child-session")
		expect(headers.get("x-parent-session-id")).toBe("parent-session")
		// Outside a subagent run the same environment names no parent.
		expect(requestCorrelation(ctx)).not.toHaveProperty("parentSessionId")
	})

	it("counts turns like telemetry: one per round-trip, never reset by a new prompt", async () => {
		const { api, ctx } = await startSession("main-session")
		expect(requestCorrelation(ctx).turnIndex).toBe(0)
		const turns: (number | undefined)[] = []
		for (const rounds of [2, 1]) {
			await api.emit("before_agent_start", { type: "before_agent_start", prompt: "Next" }, ctx)
			for (let round = 0; round < rounds; round++) {
				await api.emit("turn_start", { type: "turn_start" }, ctx)
				turns.push(requestCorrelation(ctx).turnIndex)
			}
		}
		expect(turns).toEqual([1, 2, 3])
		await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
		expect(requestCorrelation(ctx)).not.toHaveProperty("turnIndex")
	})
})

describe("tracked provider requests", () => {
	it("gives a main request an ID unless work attribution already did", async () => {
		const { api, ctx } = await startSession("main-session")
		const attributed: BeforeProviderHeadersEvent = {
			type: "before_provider_headers",
			headers: { "x-request-id": "attributed" },
		}
		await api.emit("before_provider_headers", attributed, ctx)
		expect(attributed.headers).toEqual({ "x-request-id": "attributed" })
		const plain: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await api.emit("before_provider_headers", plain, ctx)
		expect(plain.headers["X-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/)
	})

	it("reports a side call under the session pinned before it awaited", async () => {
		let sessionId = "first-session"
		const ctx = createContext({ cwd: dir, sessionManager: { getSessionId: () => sessionId } })
		const pinned = pinRequestContext(ctx)
		sessionId = "next-session"
		const headers = new Headers({ "X-Request-Id": trackProviderRequest(pinned) })
		prepareProviderRequest(headers, gatewayUrl)
		expect(headers.get("x-session-id")).toBe("first-session")
	})

	it.each([
		{ resource: true, requestId: true, value: "proxy" },
		{ resource: false, requestId: false, value: "off" },
	])("sends the request ID only while Cost per PR is enabled ($resource)", async ({ resource, requestId, value }) => {
		setResourceOverride(COST_PER_PR_RESOURCE_ID, resource)
		const sent = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"))
		vi.stubGlobal("fetch", sent)
		installGlobalFetchInstrumentation({
			userAgent: "test",
			onModelRequest: (headers, url) => prepareProviderRequest(headers, url),
		})
		const id = trackProviderRequest(session("main-session"))
		await fetch(gatewayUrl, { method: "POST", headers: { "X-Request-Id": id }, body: "{}" })
		const outgoing = new Headers(sent.mock.calls[0][1]?.headers)
		expect(outgoing.get("x-request-id")).toBe(requestId ? id : null)
		expect(outgoing.get("x-kimchi-pr-reporting")).toBe(value)
	})

	it("leaves untracked request IDs to their owner", () => {
		const headers = new Headers({ "X-Request-Id": "someone-else" })
		prepareProviderRequest(headers, gatewayUrl)
		expect(Object.fromEntries(headers)).toEqual({ "x-request-id": "someone-else" })
	})
})
