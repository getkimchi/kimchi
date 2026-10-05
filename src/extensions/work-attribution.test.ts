import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { complete, getModel } from "@earendil-works/pi-ai/compat"
import {
	type BeforeProviderHeadersEvent,
	createLocalBashOperations,
	findCutPoint,
	type InputEvent,
	type SessionBeforeCompactEvent,
	SessionManager,
	type SessionShutdownEvent,
	type SessionStartEvent,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installGlobalFetchInstrumentation } from "../http/instrument-fetch.js"
import { readPlanWorkId, savePlanMarkdown } from "../shared/planning/plan-markdown.js"
import { createCommandContext, createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { createWorkScopeSnapshot } from "./__mocks__/work-scope.js"
import requestTimingExtension from "./request-timing.js"
import { createWorkCommitTrackingOperations } from "./work-attribution/commits.js"
import * as continuation from "./work-attribution/continuation.js"
import * as costSync from "./work-attribution/cost-sync.js"
import * as supervisor from "./work-attribution/reconcile-supervisor.js"
import * as scope from "./work-attribution/scope.js"
import { flushWorkSummaries, readWorkRecords, recoverWorkSummaries } from "./work-attribution/summary.js"
import {
	appendWorkRecord,
	createWorkAttributionExtension,
	getActiveRequest,
	getToolRequest,
	getWorkId,
	getWorkSegment,
	prepareProviderRequest,
	recordProviderRequest,
	recordProviderResponse,
	setWorkId,
	tryWorkAttribution,
	tryWorkAttributionAsync,
	WORK_CHANGED_EVENT,
} from "./work-attribution.js"

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-work-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
	const captured = createWorkScopeSnapshot(join(dir, ".git"))
	vi.spyOn(scope, "captureWorkScope").mockResolvedValue(captured)
	vi.spyOn(scope, "readWorkScope").mockReturnValue(captured.scope)
	vi.spyOn(supervisor, "subscribeFileReconciliation").mockReturnValue(async () => {})
	vi.spyOn(supervisor, "subscribeCostReconciliation").mockReturnValue(async () => {})
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	rmSync(dir, { recursive: true, force: true })
})
function records() {
	return readdirSync(join(dir, "work-attribution"))
		.filter((file) => file.endsWith(".jsonl"))
		.flatMap((file) =>
			readFileSync(join(dir, "work-attribution", file), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		)
}
function wireHeaders(values: BeforeProviderHeadersEvent["headers"]): Headers {
	const headers = new Headers()
	for (const [key, value] of Object.entries(values)) if (value !== null) headers.set(key, value)
	return headers
}
describe("local work attribution", () => {
	it.each([
		"user",
		"custom",
		"assistant",
	] as const)("keeps work metadata without creating an extra compaction summary before %s", async (role) => {
		const assistant = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		})
		const manager = SessionManager.inMemory(dir)
		manager.appendMessage({ role: "user", content: "Earlier task", timestamp: 1 })
		manager.appendMessage(assistant("Earlier answer"))
		const previousTurn = manager.appendMessage({ role: "user", content: "Previous turn", timestamp: 2 })
		manager.appendMessage(assistant("Previous answer"))
		// Every input appends work identity metadata before its message.
		manager.appendCustomEntry("work_identity", { workId: randomUUID() })
		manager.appendCustomEntry("work_identity", { segment: { id: randomUUID() } })
		if (role === "custom") manager.appendCustomMessageEntry("annotation", "Continue", false)
		else if (role === "user") manager.appendMessage({ role, content: "Continue", timestamp: 3 })
		// Control: metadata inside a turn, so the kept assistant message really is a split turn's suffix.
		else manager.appendMessage(assistant("Continuing"))
		const entries = manager.getBranch()
		// The Pi behaviour behind the session_before_compact workaround: the cut moves back over the metadata, and the
		// turn before it counts as split. Once Pi stops doing this for a whole turn, remove the workaround.
		const cut = findCutPoint(entries, 0, entries.length, 1)
		expect(entries[cut.firstKeptEntryIndex]).toMatchObject({ type: "custom", customType: "work_identity" })
		expect(cut).toMatchObject({
			isSplitTurn: true,
			turnStartIndex: entries.findIndex((entry) => entry.id === previousTurn),
		})
		// Like Pi's prepareCompaction(), which is not exported, split the history at the cut.
		const messages = (from: number, to: number) =>
			entries.slice(from, to).flatMap((entry) => sessionEntryToContextMessages(entry).slice(0, 1))
		const event: SessionBeforeCompactEvent = {
			type: "session_before_compact",
			branchEntries: entries,
			preparation: {
				firstKeptEntryId: entries[cut.firstKeptEntryIndex].id,
				messagesToSummarize: messages(0, cut.turnStartIndex),
				turnPrefixMessages: messages(cut.turnStartIndex, cut.firstKeptEntryIndex),
				isSplitTurn: cut.isSplitTurn,
				tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
			},
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}
		const before = structuredClone(event.preparation)
		const branchBefore = structuredClone(event.branchEntries)
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		for (const handler of api.getHandlers<SessionBeforeCompactEvent>("session_before_compact"))
			await handler(event, createContext({ cwd: dir, sessionManager: manager }))
		if (role === "assistant") expect(event.preparation).toEqual(before)
		else
			expect(event.preparation).toEqual({
				...before,
				messagesToSummarize: messages(0, cut.firstKeptEntryIndex),
				turnPrefixMessages: [],
				isSplitTurn: false,
			})
		expect(event.branchEntries).toEqual(branchBefore)
	})
	it("marks a new request's missing scope as unknown instead of making it look like legacy history", () => {
		const ctx = createContext({ cwd: dir })
		const original = recordProviderRequest(ctx)
		vi.mocked(scope.readWorkScope).mockReturnValue(undefined)
		const afterLoss = recordProviderRequest(ctx)
		const first = records().find((row) => row.type === "request" && row.requestId === original.requestId)
		const second = records().find((row) => row.type === "request" && row.requestId === afterLoss.requestId)
		expect(first.scope).toBeDefined()
		expect(second.workId).toBe(first.workId)
		expect(second.scope).toBeNull()
	})
	it.each([
		"same",
		"different",
	])("repairs one earlier input in the %s work and revokes it after recovery", async (owner) => {
		const planner = createContext({ cwd: dir, sessionManager: { getSessionId: () => "planner" } })
		const segment = { id: randomUUID(), attribution: "session", reason: "matching-disabled" } as const
		const selected = recordProviderRequest({ ...planner, segment })
		const unrelated = recordProviderRequest({ ...planner, segment: { ...segment, id: randomUUID() } })
		const ctx = {
			...createCommandContext(),
			...createContext({
				cwd: dir,
				sessionManager: { getSessionId: () => (owner === "same" ? "planner" : "implementer") },
			}),
		}
		const target = recordProviderRequest(ctx)
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		const command = mock.getRegisteredCommand("work")
		await command.handler(`link ${selected.workId} ${segment.id}`, ctx)
		const links = records().filter((row) => row.type === "work_link")
		expect(links).toHaveLength(1)
		expect(links[0]).toMatchObject({
			sourceWorkId: selected.workId,
			targetWorkId: target.workId,
			requestIds: [selected.requestId],
			revision: 1,
			status: "active",
		})
		expect(links[0].requestIds).not.toContain(unrelated.requestId)
		expect(getWorkId(planner)).toBe(selected.workId)
		expect(getWorkId(ctx)).toBe(target.workId)
		await flushWorkSummaries()
		const path = join(dir, "work", target.workId, "work.json")
		expect(JSON.parse(readFileSync(path, "utf8")).workLinks).toHaveLength(1)
		writeFileSync(path, "damaged")
		recoverWorkSummaries()
		await flushWorkSummaries()
		expect(JSON.parse(readFileSync(path, "utf8")).workLinks).toHaveLength(1)
		await command.handler(`unlink ${links[0].linkId}`, ctx)
		expect(records().filter((row) => row.type === "work_link")).toEqual([
			links[0],
			expect.objectContaining({
				linkId: links[0].linkId,
				revision: 2,
				status: "revoked",
				requestIds: [selected.requestId],
			}),
		])
	})
	it("starts billing reconciliation once for a main session and never for its child", async () => {
		const stop = vi.fn(async () => {})
		vi.mocked(supervisor.subscribeCostReconciliation).mockReturnValue(stop)
		const parent = createExtensionApi()
		const child = createExtensionApi()
		const ctx = createContext({ cwd: dir })
		createWorkAttributionExtension()(parent.api)
		createWorkAttributionExtension(getWorkId(ctx))(child.api)
		for (const api of [parent, parent, child])
			await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)
		expect(supervisor.subscribeCostReconciliation).toHaveBeenCalledOnce()
		await child.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
		expect(stop).not.toHaveBeenCalled()
		await parent.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
		expect(stop).toHaveBeenCalledOnce()
	})
	it("pins billing metadata at dispatch before a later account or work switch", () => {
		const ctx = createContext({ cwd: dir })
		const identity = recordProviderRequest(ctx, ctx.model)
		const original = {
			apiUrl: "https://billing.example/api",
			gatewayUrl: "https://gateway.example/v1/chat/completions",
			credentialHash: "a".repeat(64),
		}
		vi.spyOn(costSync, "captureBillingSource").mockReturnValue(original)
		const headers = new Headers({ "X-Request-Id": identity.requestId, Authorization: "Bearer test-key" })
		prepareProviderRequest(headers, original.gatewayUrl)
		vi.mocked(costSync.captureBillingSource).mockReturnValue({ ...original, credentialHash: "b".repeat(64) })
		setWorkId(ctx)
		recordProviderResponse(identity.requestId, {
			status: 200,
			headers: new Headers({ "X-Prompt-Id": "11111111-2222-4333-8444-555555555555" }),
		})
		expect(records().find((row) => row.type === "request_response")).toMatchObject({
			workId: identity.workId,
			billingSource: original,
		})
	})
	it.each([
		{ bodyTags: undefined, header: "team:one", reason: "body-uninspectable" },
		{ bodyTags: Array.from({ length: 10 }, () => "duplicate:tag"), header: "", reason: "tag-limit" },
		{ bodyTags: ["kimchi-request:user-owned"], header: "team:one", reason: "reserved-tag" },
	])("persists skipped tagging without changing user tags: $reason", ({ bodyTags, header, reason }) => {
		const ctx = createContext({ cwd: dir })
		const { requestId } = recordProviderRequest(ctx, ctx.model)
		vi.spyOn(costSync, "captureBillingSource").mockReturnValue({
			apiUrl: "https://billing.invalid",
			gatewayUrl: "https://model.invalid/v1/chat/completions",
			credentialHash: "a".repeat(64),
		})
		const headers = new Headers({ "X-Request-Id": requestId, "X-Tags": header })
		prepareProviderRequest(headers, "https://model.invalid/v1/chat/completions", { bodyTags })
		expect(headers.get("X-Tags")).toBe(header)
		expect(records().find((row) => row.type === "request_dispatch")).toMatchObject({
			requestId,
			billingTagSkipped: reason,
		})
		expect(records().find((row) => row.type === "request_dispatch")).not.toHaveProperty("billingSelector")
	})
	it.each([
		false,
		true,
	])("does not send an unrecorded tag when dispatch persistence fails (retry: %s)", async (retry) => {
		const ctx = createContext({ cwd: dir })
		const { requestId } = recordProviderRequest(ctx, ctx.model)
		const url = "https://model.invalid/v1/chat/completions"
		vi.spyOn(costSync, "captureBillingSource").mockReturnValue({
			apiUrl: "https://billing.invalid",
			gatewayUrl: url,
			credentialHash: "a".repeat(64),
		})
		const headers = new Headers({ "X-Request-Id": requestId, "X-Tags": "team:one" })
		if (retry) prepareProviderRequest(headers, url, { bodyTags: [] })
		await flushWorkSummaries()
		rmSync(join(dir, "work-attribution"), { recursive: true })
		writeFileSync(join(dir, "work-attribution"), "blocked")
		const sent = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const outgoing = new Headers(init?.headers)
			expect(outgoing.get("X-Request-Id")).toBeNull()
			expect(outgoing.get("X-Tags")).toBe("team:one")
			return new Response("ok")
		})
		vi.stubGlobal("fetch", sent)
		vi.spyOn(console, "warn").mockImplementation(() => {})
		installGlobalFetchInstrumentation({ userAgent: "test", onModelRequest: prepareProviderRequest })
		expect(await (await fetch(url, { headers, body: "{}", method: "POST" })).text()).toBe("ok")
		expect(sent).toHaveBeenCalledOnce()
	})
	it.each([
		"http",
		"network",
	])("records Pi's hidden %s retry and attributes diagnostics and native writes to the successful attempt", async (failure) => {
		vi.stubEnv("KIMCHI_STREAM_IDLE_TIMEOUT_MS", "0")
		execFileSync("git", ["init", "-q", dir])
		const model = {
			...getModel("openai", "gpt-4o-mini"),
			api: "openai-completions" as const,
			baseUrl: "https://model.invalid/v1",
		}
		const ctx = createContext({ cwd: dir, model })
		const api = createExtensionApi()
		if (failure === "network") requestTimingExtension(api.api)
		createWorkAttributionExtension()(api.api)
		if (failure === "http") requestTimingExtension(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)
		const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		for (const handler of api.getHandlers<BeforeProviderHeadersEvent>("before_provider_headers"))
			await handler(event, ctx)
		const logicalId = event.headers["X-Request-Id"]
		const promptIds = ["11111111-2222-4333-8444-555555555555", "22222222-2222-4333-8444-555555555555"]
		vi.spyOn(costSync, "captureBillingSource").mockReturnValue({
			apiUrl: "https://billing.invalid/api",
			gatewayUrl: `${model.baseUrl}/chat/completions`,
			credentialHash: "a".repeat(64),
		})
		const calls: {
			requestId: string | null
			recordedBeforeSend: boolean
			tag: string | null
			tagRecordedBeforeSend: boolean
		}[] = []
		vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers)
			const requestId = headers.get("x-request-id")
			const tag = headers.get("x-tags")
			calls.push({
				requestId,
				recordedBeforeSend: records().some((row) => row.type === "request" && row.requestId === requestId),
				tag,
				tagRecordedBeforeSend: records().some(
					(row) => row.type === "request_dispatch" && row.requestId === requestId && row.billingSelector?.tag === tag,
				),
			})
			if (calls.length === 1) {
				if (failure === "network") throw new TypeError("fetch failed")
				return Response.json(
					{ error: { message: "retry", type: "server_error" } },
					{ status: 503, headers: { "Retry-After": "0", "X-Prompt-Id": promptIds[0] } },
				)
			}
			const chunk = {
				id: "chat",
				object: "chat.completion.chunk",
				created: 1,
				model: model.id,
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "write-success",
									type: "function",
									function: {
										name: "write",
										arguments: JSON.stringify({ path: "retry.txt", content: "saved after retry\n" }),
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
			}
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { "Content-Type": "text/event-stream", "X-Prompt-Id": promptIds[1] },
			})
		})
		installGlobalFetchInstrumentation({
			userAgent: "retry-test",
			onModelRequest: prepareProviderRequest,
			onModelResponse: recordProviderResponse,
		})
		const result = await complete(
			model,
			{
				messages: [{ role: "user", content: "Write a file", timestamp: Date.now() }],
				tools: [api.getRegisteredTool("write")],
			},
			{
				apiKey: "fake",
				headers: event.headers,
				maxRetries: 1,
				maxRetryDelayMs: 1,
				onResponse: async (response) => {
					await api.getHandler("after_provider_response")({ type: "after_provider_response", ...response }, ctx)
				},
			},
		)
		expect(result.errorMessage).toBeUndefined()
		expect(result.stopReason).toBe("toolUse")
		expect(calls).toHaveLength(2)
		expect(calls.every((call) => call.recordedBeforeSend)).toBe(true)
		expect(calls.every((call) => call.tagRecordedBeforeSend)).toBe(true)
		expect(calls.map((call) => call.tag)).toEqual(calls.map((call) => `kimchi-request:${call.requestId}`))
		expect(calls[0].requestId).toBe(logicalId)
		expect(calls[1].requestId).not.toBe(logicalId)
		for (const handler of api.getHandlers("message_end")) await handler({ message: result }, ctx)
		expect(api.getAppendedEntries("request_diagnostics")).toEqual([
			expect.objectContaining({ requestId: calls[1].requestId, status: 200 }),
		])
		await api
			.getRegisteredTool("write")
			.execute("write-success", { path: "retry.txt", content: "saved after retry\n" }, undefined, undefined, ctx)
		expect(readFileSync(join(dir, "retry.txt"), "utf8")).toBe("saved after retry\n")
		expect(readWorkRecords(dir).find((row) => row.type === "file_transition")).toMatchObject({
			requestId: calls[1].requestId,
		})
		await flushWorkSummaries()
		const requests = JSON.parse(readFileSync(join(dir, "work", getWorkId(ctx), "work.json"), "utf8")).requests
		expect(requests).toHaveLength(2)
		expect(records().filter((row) => row.type === "request")).toHaveLength(2)
		expect(records().filter((row) => row.type === "request_dispatch")).toHaveLength(2)
		expect(requests[0].billingSelector.tag).toBe(calls[0].tag)
		expect(requests[1]).toMatchObject({
			requestId: calls[1].requestId,
			parentRequestId: logicalId,
			response: { status: 200, promptId: promptIds[1] },
		})
		if (failure === "http") expect(requests[0].response).toMatchObject({ status: 503, promptId: promptIds[0] })
		else expect(requests[0]).not.toHaveProperty("response")
	})
	it("keeps retries of both original and alias IDs in the original work after another main request starts", async () => {
		const ctx = createContext({ cwd: dir, model: { provider: "original", id: "first-model" } })
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const original: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(original, ctx)
		const logicalId = original.headers["X-Request-Id"]
		const originalWork = getWorkId(ctx)
		prepareProviderRequest(wireHeaders(original.headers))
		const firstRetry = wireHeaders(original.headers)
		prepareProviderRequest(firstRetry)
		const retryId = firstRetry.get("x-request-id")
		expect(retryId).not.toBe(logicalId)
		expect(getActiveRequest(ctx)?.requestId).toBe(retryId)
		expect(original.headers["X-Request-Id"]).toBe(retryId)
		setWorkId(ctx)
		ctx.model = { ...getModel("openai", "gpt-4o-mini") }
		const current: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(current, ctx)
		for (const id of [logicalId, retryId]) {
			if (!id) throw new Error("Expected request ID")
			const wire = new Headers({ "X-Request-Id": id })
			prepareProviderRequest(wire)
			expect(wire.get("x-request-id")).not.toBe(id)
			expect(records().find((row) => row.requestId === wire.get("x-request-id"))).toMatchObject({
				workId: originalWork,
				parentRequestId: logicalId,
				provider: "original",
				model: "first-model",
			})
			expect(getActiveRequest(ctx)?.requestId).toBe(current.headers["X-Request-Id"])
		}
		expect(original.headers["X-Request-Id"]).toBe(retryId)
	})
	it("does not let auxiliary retries replace the main response's tool identity", async () => {
		const ctx = createContext({ cwd: dir })
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const main: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(main, ctx)
		prepareProviderRequest(wireHeaders(main.headers))
		const auxiliary = recordProviderRequest(ctx, { provider: "kimchi-dev", id: "classifier" })
		prepareProviderRequest(new Headers({ "X-Request-Id": auxiliary.requestId }))
		const retry = new Headers({ "X-Request-Id": auxiliary.requestId })
		prepareProviderRequest(retry)
		expect(retry.get("x-request-id")).not.toBe(auxiliary.requestId)
		await api.getHandler("message_end")(
			{
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "write", name: "write" }],
				},
			},
			ctx,
		)
		expect(getToolRequest(ctx, "write")?.requestId).toBe(main.headers["X-Request-Id"])
	})
	it("pins a retry's session and model even when the caller changes both", async () => {
		let sessionId = "first-session"
		const model = { provider: "original", id: "original-model" }
		const ctx = createContext({ cwd: dir, sessionManager: { getSessionId: () => sessionId } })
		const original = recordProviderRequest(ctx, model)
		prepareProviderRequest(new Headers({ "X-Request-Id": original.requestId }))
		sessionId = "next-session"
		model.id = "next-model"
		setWorkId(ctx)
		const retry = new Headers({ "X-Request-Id": original.requestId })
		prepareProviderRequest(retry)
		expect(records().find((row) => row.requestId === retry.get("x-request-id"))).toMatchObject({
			parentRequestId: original.requestId,
			sessionId: "first-session",
			workId: original.workId,
			model: "original-model",
		})
	})
	it("drops stale timing and tool identities when a retry cannot be persisted", async () => {
		const ctx = createContext({ cwd: dir })
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(event, ctx)
		const sdkHeaders = wireHeaders(event.headers)
		const sent: (string | null)[] = []
		vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
			sent.push(new Headers(init?.headers).get("x-request-id"))
			return new Response("ok")
		})
		installGlobalFetchInstrumentation({
			userAgent: "test",
			onModelRequest: prepareProviderRequest,
			onModelResponse: recordProviderResponse,
		})
		await fetch("https://model.invalid/v1/chat/completions", { headers: sdkHeaders })
		await flushWorkSummaries()
		rmSync(join(dir, "work-attribution"), { recursive: true })
		writeFileSync(join(dir, "work-attribution"), "blocked")
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		expect(await (await fetch("https://model.invalid/v1/chat/completions", { headers: sdkHeaders })).text()).toBe("ok")
		expect(sent).toEqual([sdkHeaders.get("X-Request-Id"), null])
		expect(event.headers["X-Request-Id"]).toBeNull()
		expect(getActiveRequest(ctx)).toBeUndefined()
		await api.getHandler("message_end")(
			{
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "write", name: "write" }],
				},
			},
			ctx,
		)
		expect(getToolRequest(ctx, "write")).toBeUndefined()
		expect(warning).toHaveBeenCalledWith("[work-attribution] Request identity unavailable:", expect.any(Error))
	})
	it("saves billing response IDs with the request's original work, session and start time", async () => {
		let sessionId = "billing-origin"
		const ctx = createContext({ cwd: dir, sessionManager: { getSessionId: () => sessionId } })
		const attempt = recordProviderRequest(ctx, { provider: "kimchi-dev", id: "glm-5.3" })
		const original = records().find((row) => row.requestId === attempt.requestId)
		sessionId = "switched-session"
		setWorkId(ctx)
		const promptId = "11111111-2222-4333-8444-555555555555"
		recordProviderResponse(attempt.requestId, {
			status: 200,
			headers: new Headers({ "X-Prompt-Id": promptId, "X-Trace-Id": "a".repeat(32), Authorization: "must-not-save" }),
		})
		recordProviderResponse(attempt.requestId, { status: 500, headers: new Headers() })
		await flushWorkSummaries()
		const summary = JSON.parse(readFileSync(join(dir, "work", attempt.workId, "work.json"), "utf8"))
		expect(summary.requests).toHaveLength(1)
		expect(summary.requests[0]).toMatchObject({
			requestId: attempt.requestId,
			sessionId: "billing-origin",
			startedAt: original.startedAt,
			response: { status: 200, promptId, traceId: "a".repeat(32) },
		})
		expect(Date.parse(original.startedAt)).toBeLessThanOrEqual(Date.parse(original.recordedAt))
		expect(JSON.stringify(records())).not.toContain("must-not-save")
		expect(records().filter((row) => row.type === "request")).toHaveLength(1)
		expect(records().filter((row) => row.type === "request_response")).toHaveLength(1)
		expect(summary.requests[0]).not.toHaveProperty("costUsd")
	})
	it("records missing or malformed billing identity without inventing a charge", async () => {
		const ctx = createContext({ cwd: dir })
		const attempt = recordProviderRequest(ctx)
		recordProviderResponse(attempt.requestId, {
			status: 503,
			headers: new Headers({ "X-Prompt-Id": "not-an-id", "X-Trace-Id": "sensitive garbage" }),
		})
		recordProviderResponse("unknown-request", { status: 200, headers: new Headers() })
		await flushWorkSummaries()
		const summary = JSON.parse(readFileSync(join(dir, "work", attempt.workId, "work.json"), "utf8"))
		expect(summary.requests).toHaveLength(1)
		expect(summary.requests[0].response).toEqual({ status: 503, receivedAt: expect.any(String) })
	})
	it("adopts a named artifact before dispatch and records why the sessions were joined", async () => {
		const ctx = createContext({ cwd: dir })
		const workId = getWorkId(createContext({ cwd: dir, sessionManager: { getSessionId: () => "planning" } }))
		const selected = {
			workId,
			source: "named-artifact" as const,
			evidence: { path: "/project/ADR.md", transitionId: "planning-write" },
		}
		const api = createExtensionApi()
		const announced = vi.fn()
		vi.spyOn(continuation, "findWorkContinuation").mockImplementation(async () => {
			// Count only what the adoption announces, after the input bound the session.
			api.api.events.on(WORK_CHANGED_EVENT, announced)
			return selected
		})
		createWorkAttributionExtension()(api.api)
		await api.getHandler<InputEvent>("input")({ type: "input", text: "Implement ADR.md", source: "rpc" }, ctx)
		expect(announced).toHaveBeenCalledOnce()
		const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(event, ctx)
		expect(records().find((row) => row.requestId === event.headers["X-Request-Id"]).workId).toBe(workId)
		expect(records()).toContainEqual(
			expect.objectContaining({
				type: "work",
				workId,
				continuation: { source: selected.source, evidence: selected.evidence },
			}),
		)
		expect(api.getAppendedEntries("work_identity")).toContainEqual({
			workId,
			continuation: { source: selected.source, evidence: selected.evidence },
		})
	})
	it("keeps an accepted plan continuation for later inputs until a reference to other work ends it", async () => {
		const planned = getWorkId(createContext({ cwd: dir, sessionManager: { getSessionId: () => "planning" } }))
		const find = vi
			.spyOn(continuation, "findWorkContinuation")
			.mockResolvedValueOnce({ workId: planned, source: "saved-plan", evidence: { path: "/plan.md" } })
		const manager = SessionManager.inMemory(dir)
		const ctx = { ...createContext({ cwd: dir }), sessionManager: manager }
		const api = createExtensionApi()
		api.appendEntry.mockImplementation((type, data) => {
			manager.appendCustomEntry(type, data)
		})
		createWorkAttributionExtension()(api.api)
		const input = api.getHandler<InputEvent>("input")
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
		await input({ type: "input", text: "Implement /plan.md", source: "interactive" }, ctx)
		expect(getWorkId(ctx)).toBe(planned)
		expect(getWorkSegment(ctx)).toMatchObject({ attribution: "explicit", reason: "saved-plan" })
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "native-write",
			toolName: "write",
			isError: false,
			content: [{ type: "text", text: "Written" }],
			timestamp: Date.now(),
		})
		await input({ type: "input", text: "Also add a test", source: "interactive" }, ctx)
		expect(getWorkSegment(ctx)).toMatchObject({ attribution: "explicit", reason: "saved-plan" })

		// A restart keeps the continuation and its reason.
		await api.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "resume" }, ctx)
		await input({ type: "input", text: "Fix the lint error", source: "interactive" }, ctx)
		expect(getWorkSegment(ctx)).toMatchObject({ attribution: "explicit", reason: "saved-plan" })
		expect(find).toHaveBeenCalledOnce()

		const other = "22222222-2222-4222-8222-222222222222"
		find.mockResolvedValueOnce({ workId: other, source: "saved-plan", evidence: { path: "/other.md" } })
		await input({ type: "input", text: "Implement /other.md", source: "interactive" }, ctx)
		expect(getWorkId(ctx)).toBe(planned)
		expect(getWorkSegment(ctx)).toMatchObject({ attribution: "unknown", reason: "unresolved-reference" })
		await input({ type: "input", text: "Carry on", source: "interactive" }, ctx)
		expect(getWorkSegment(ctx)).toMatchObject({ attribution: "session" })
		await api.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
	})
	it("resolves external input before work output and ignores extension input", async () => {
		const find = vi.spyOn(continuation, "findWorkContinuation").mockResolvedValue(undefined)
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const input = api.getHandler<InputEvent>("input")
		const ctx = createContext({ cwd: dir })
		await input({ type: "input", text: "Implement", source: "extension" }, ctx)
		expect(find).not.toHaveBeenCalled()
		await input({ type: "input", text: "Implement", source: "interactive" }, ctx)
		expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: dir }), "Implement", expect.any(Object))
		await input({ type: "input", text: "Continue", source: "interactive" }, ctx)
		expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: dir }), "Continue", expect.any(Object))
		const started = createContext({ cwd: dir, sessionManager: { getSessionId: () => "requested" } })
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(
			{ type: "before_provider_headers", headers: {} },
			started,
		)
		await input({ type: "input", text: "Later", source: "interactive" }, started)
		expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: dir }), "Later", expect.any(Object))
	})
	it("allows fresh continuation after an earlier startup hook allocated the ledger", async () => {
		const ctx = createContext({ cwd: dir })
		getWorkId(ctx)
		const find = vi.spyOn(continuation, "findWorkContinuation").mockResolvedValue(undefined)
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		await api.getHandler<InputEvent>("input")({ type: "input", text: "Implement", source: "rpc" }, ctx)
		expect(find).toHaveBeenCalledWith(expect.objectContaining({ cwd: dir }), "Implement", expect.any(Object))
	})
	it("preserves restored identity even when a crash left no native tool result", async () => {
		const ctx = createContext({ cwd: dir })
		const original = getWorkId(ctx)
		const old = createExtensionApi()
		createWorkAttributionExtension()(old.api)
		await old.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
		// An earlier startup hook may restore the ledger before attribution binds.
		expect(getWorkId(ctx)).toBe(original)
		const selected = "11111111-1111-4111-8111-111111111111"
		const find = vi
			.spyOn(continuation, "findWorkContinuation")
			.mockResolvedValue({ workId: selected, source: "named-artifact", evidence: { path: "/project/ADR.md" } })
		const resumed = createExtensionApi()
		createWorkAttributionExtension()(resumed.api)
		await resumed.getHandler<InputEvent>("input")({ type: "input", text: "Implement ADR.md", source: "rpc" }, ctx)
		expect(getWorkId(ctx)).toBe(original)
		expect(find).toHaveBeenCalledOnce()
		expect(getWorkSegment(ctx)).toMatchObject({ attribution: "unknown", reason: "unresolved-reference" })
		const plan = savePlanMarkdown({ cwd: dir, name: "explicit", planText: "# Plan", workId: selected })
		await resumed.getRegisteredCommand("work").handler(plan.path, { ...createCommandContext(), ...ctx })
		expect(getWorkId(ctx)).toBe(selected)
	})
	it("preserves explicit work selection and historical native output without a summary", async () => {
		const selected = "11111111-1111-4111-8111-111111111111"
		const find = vi
			.spyOn(continuation, "findWorkContinuation")
			.mockResolvedValue({ workId: selected, source: "saved-plan", evidence: { path: "/plan.md" } })
		const manager = SessionManager.inMemory(dir)
		const ctx = { ...createContext({ cwd: dir }), sessionManager: manager }
		const api = createExtensionApi()
		api.appendEntry.mockImplementation((type, data) => {
			manager.appendCustomEntry(type, data)
		})
		createWorkAttributionExtension()(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
		const own = getWorkId(ctx)
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "native-write",
			toolName: "write",
			isError: false,
			content: [{ type: "text", text: "Written" }],
			timestamp: Date.now(),
		})
		await api.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
		rmSync(join(dir, "work", own, "work.json"))
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "resume" }, ctx)
		await api.getHandler<InputEvent>("input")({ type: "input", text: "Implement /plan.md", source: "interactive" }, ctx)
		expect(getWorkId(ctx)).toBe(own)
		expect(find).toHaveBeenCalledOnce()
		expect(getWorkSegment(ctx)).toMatchObject({ attribution: "unknown", reason: "unresolved-reference" })
		find.mockClear()
		const empty = createContext({ cwd: dir, sessionManager: { getSessionId: () => "explicit" } })
		await api.getRegisteredCommand("work").handler("new", { ...createCommandContext(), ...empty })
		const explicit = getWorkId(empty)
		await api.getHandler<InputEvent>("input")({ type: "input", text: "Implement /plan.md", source: "rpc" }, empty)
		expect(getWorkId(empty)).toBe(explicit)
		expect(find).not.toHaveBeenCalled()
		await api.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
	})
	it("does not switch work after an asynchronous continuation lookup became stale", async () => {
		const ctx = createContext({ cwd: dir })
		let release!: (value: continuation.WorkContinuation) => void
		vi.spyOn(continuation, "findWorkContinuation").mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const input = Promise.resolve(
			api.getHandler<InputEvent>("input")({ type: "input", text: "Implement plan.md", source: "interactive" }, ctx),
		)
		await api.getRegisteredCommand("work").handler("new", { ...createCommandContext(), ...ctx })
		const chosen = getWorkId(ctx)
		release({
			workId: "11111111-1111-4111-8111-111111111111",
			source: "named-artifact",
			evidence: { path: "/plan.md" },
		})
		await input
		expect(getWorkId(ctx)).toBe(chosen)
	})
	it("pins tool calls to their successful response across auxiliary requests and work switches", async () => {
		const api = createExtensionApi()
		const ctx = createContext({ cwd: dir })
		createWorkAttributionExtension()(api.api)
		const headers = api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")
		const failed: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await headers(failed, ctx)
		const success: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await headers(success, ctx)
		const workId = getWorkId(ctx)
		await api.getHandler("message_end")(
			{
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{ type: "toolCall", id: "edit-one", name: "edit" },
						{ type: "toolCall", id: "write-two", name: "write" },
					],
				},
			},
			ctx,
		)
		const auxiliary = recordProviderRequest(ctx, { provider: "test", id: "classifier" })
		setWorkId(ctx)
		for (const tool of ["edit-one", "write-two"])
			expect(getToolRequest(ctx, tool)).toEqual({ requestId: success.headers["X-Request-Id"], workId })
		expect(getToolRequest(ctx, "edit-one")?.requestId).not.toBe(auxiliary.requestId)
		expect(getToolRequest(ctx, "unknown")).toBeUndefined()
		await api.getHandler("tool_execution_end")({ toolCallId: "edit-one" }, ctx)
		expect(getToolRequest(ctx, "edit-one")).toBeUndefined()
		expect(getToolRequest(ctx, "write-two")).toBeDefined()
		await api.getHandler("turn_end")({}, ctx)
		expect(getToolRequest(ctx, "write-two")).toBeUndefined()
	})
	it("keeps parent and child tool identities separate and drops missing or aborted provenance", async () => {
		const parent = createContext({ cwd: dir })
		const child = createContext({ cwd: dir, sessionManager: { getSessionId: () => "child-tools" } })
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const response = (stopReason = "toolUse") => ({
			message: { role: "assistant", stopReason, content: [{ type: "toolCall", id: "same-id", name: "write" }] },
		})
		for (const ctx of [parent, child]) {
			const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
			await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(event, ctx)
			await api.getHandler("message_end")(response(), ctx)
			expect(getToolRequest(ctx, "same-id")?.requestId).toBe(event.headers["X-Request-Id"])
		}
		expect(getToolRequest(parent, "same-id")).not.toEqual(getToolRequest(child, "same-id"))
		for (const stopReason of ["error", "aborted"]) {
			await api.getHandler("message_end")(response(stopReason), child)
			expect(getToolRequest(child, "same-id")).toBeUndefined()
		}
		await api.getHandler("turn_start")({}, parent)
		await api.getHandler("message_end")(response(), parent)
		expect(getToolRequest(parent, "same-id")).toBeUndefined()
		await api.getHandler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, child)
		expect(getToolRequest(child, "same-id")).toBeUndefined()
	})
	it("does not reuse tool provenance after a request persistence failure", async () => {
		const api = createExtensionApi()
		const ctx = createContext({ cwd: dir })
		createWorkAttributionExtension()(api.api)
		const headers = api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")
		await headers({ type: "before_provider_headers", headers: {} }, ctx)
		await flushWorkSummaries()
		rmSync(join(dir, "work-attribution"), { recursive: true })
		writeFileSync(join(dir, "work-attribution"), "blocked")
		await headers({ type: "before_provider_headers", headers: {} }, ctx)
		await api.getHandler("message_end")(
			{
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "write", name: "write" }],
				},
			},
			ctx,
		)
		expect(getToolRequest(ctx, "write")).toBeUndefined()
	})
	it.each([
		"known",
		"missing",
	])("lets a child with a %s work ID shut down while its parent reconciles", async (identity) => {
		let release!: () => void
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		const stop = vi.fn(() => blocked)
		const reconcile = vi.spyOn(supervisor, "subscribeFileReconciliation").mockReturnValue(stop)
		const parent = createContext({ cwd: dir })
		const parentApi = createExtensionApi()
		createWorkAttributionExtension()(parentApi.api)
		await parentApi.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, parent)
		await parentApi.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "resume" }, parent)
		const child = createContext({ cwd: dir, sessionManager: { getSessionId: () => "child-shutdown" } })
		const childApi = createExtensionApi()
		createWorkAttributionExtension(identity === "known" ? getWorkId(parent) : null)(childApi.api)
		await childApi.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, child)
		let childStopped = false
		const childShutdown = Promise.resolve(
			childApi.getHandler<SessionShutdownEvent>("session_shutdown")(
				{ type: "session_shutdown", reason: "quit" },
				child,
			),
		).then(() => {
			childStopped = true
		})
		let parentShutdown: Promise<unknown> | undefined
		try {
			await vi.waitFor(() => expect(childStopped).toBe(true), { timeout: 1000 })
			expect(reconcile).toHaveBeenCalledOnce()
			expect(stop).not.toHaveBeenCalled()
			let parentStopped = false
			parentShutdown = Promise.resolve(
				parentApi.getHandler<SessionShutdownEvent>("session_shutdown")(
					{ type: "session_shutdown", reason: "quit" },
					parent,
				),
			).then(() => {
				parentStopped = true
			})
			expect(stop).toHaveBeenCalledOnce()
			await Promise.resolve()
			expect(parentStopped).toBe(false)
		} finally {
			release()
			await childShutdown
			await (parentShutdown ??
				parentApi.getHandler<SessionShutdownEvent>("session_shutdown")(
					{ type: "session_shutdown", reason: "quit" },
					parent,
				))
		}
	})
	it("never adopts a plan automatically in a child whose inherited identity was unavailable", async () => {
		const selected = "11111111-1111-4111-8111-111111111111"
		const find = vi.spyOn(continuation, "findWorkContinuation").mockResolvedValue({
			workId: selected,
			source: "saved-plan",
			evidence: { path: "/plan.md" },
		})
		const api = createExtensionApi()
		createWorkAttributionExtension(null)(api.api)
		const ctx = createContext({ cwd: dir })
		await api.getHandler<InputEvent>("input")({ type: "input", text: "Implement /plan.md", source: "rpc" }, ctx)
		expect(find).not.toHaveBeenCalled()
		expect(getWorkId(ctx)).not.toBe(selected)
	})

	it("writes every request before returning headers, including retry attempts", async () => {
		const mock = createExtensionApi()
		const ctx = createContext({ cwd: dir })
		createWorkAttributionExtension()(mock.api)
		const first: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		const second: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await mock.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(first, ctx)
		expect(records().filter((row) => row.type === "request")).toHaveLength(1)
		await mock.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(second, ctx)
		const requests = records().filter((row) => row.type === "request")
		expect(requests[0].requestId).not.toBe(requests[1].requestId)
		expect(requests[0].workId).toBe(requests[1].workId)
		expect(first.headers["X-Request-Id"]).toBe(requests[0].requestId)
	})
	it("pins a child's work independently of subsequent parent changes", async () => {
		const parent = createContext({ cwd: dir })
		const inherited = getWorkId(parent)
		const mock = createExtensionApi()
		createWorkAttributionExtension(inherited)(mock.api)
		setWorkId(parent)
		const child = createContext({ cwd: dir, sessionManager: { getSessionId: () => "child" } })
		await mock.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(
			{ type: "before_provider_headers", headers: {} },
			child,
		)
		expect(getWorkId(child)).toBe(inherited)
		expect(getWorkId(parent)).not.toBe(inherited)
	})
	it("keeps a reopened child's original work after its parent starts new work", async () => {
		const parent = createContext({ cwd: dir })
		const child = createContext({ cwd: dir, sessionManager: { getSessionId: () => "saved-child" } })
		const original = getWorkId(parent)
		const segment = { id: "first-input", attribution: "unknown", reason: "model-uncertain" } as const
		const old = createExtensionApi()
		createWorkAttributionExtension(original, segment)(old.api)
		await old.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(
			{ type: "before_provider_headers", headers: {} },
			child,
		)
		await old.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, child)
		const parentNext = setWorkId(parent)
		const reopened = createExtensionApi()
		const nextSegment = { id: "next-input", attribution: "explicit", reason: "work-command" } as const
		createWorkAttributionExtension(parentNext, nextSegment)(reopened.api)
		await reopened.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(
			{ type: "before_provider_headers", headers: {} },
			child,
		)
		expect(getWorkId(child)).toBe(original)
		expect(getWorkSegment(child)).toEqual(segment)
		const fresh = createContext({ cwd: dir, sessionManager: { getSessionId: () => "fresh-child" } })
		await reopened.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(
			{ type: "before_provider_headers", headers: {} },
			fresh,
		)
		expect(getWorkId(fresh)).toBe(parentNext)
		expect(getWorkSegment(fresh)).toEqual(nextSegment)
	})
	it("does not carry a prior task's segment through a direct work switch", async () => {
		const ctx = createContext({ cwd: dir })
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		await api.getHandler<InputEvent>("input")({ type: "input", source: "interactive", text: "First task" }, ctx)
		expect(getWorkSegment(ctx)).toBeDefined()
		setWorkId(ctx)
		expect(getWorkSegment(ctx)).toBeUndefined()
	})

	it("restores the work at a real historical fork point and preserves the fork on resume", async () => {
		const parent = SessionManager.create(dir, join(dir, "sessions"))
		const parentCtx = { ...createContext({ cwd: dir }), sessionManager: parent }
		const api = createExtensionApi()
		api.appendEntry.mockImplementation((type, data) => {
			parent.appendCustomEntry(type, data)
		})
		createWorkAttributionExtension()(api.api)
		await api.getHandler<InputEvent>("input")({ type: "input", source: "interactive", text: "First task" }, parentCtx)
		const originalSegment = getWorkSegment(parentCtx)
		expect(originalSegment).toBeDefined()
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(
			{ type: "before_provider_headers", headers: {} },
			parentCtx,
		)
		const original = getWorkId(parentCtx)
		const forkPoint = parent.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "First task" }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		})
		await api.getRegisteredCommand("work").handler("new", { ...createCommandContext(), ...parentCtx })
		expect(getWorkId(parentCtx)).not.toBe(original)
		const parentFile = parent.getSessionFile()
		if (!parentFile) throw new Error("Expected persisted parent")
		const fork = SessionManager.open(parentFile)
		const forkFile = fork.createBranchedSession(forkPoint)
		if (!forkFile) throw new Error("Expected persisted fork")
		const forkCtx = { ...createContext({ cwd: dir }), sessionManager: fork }
		const forkApi = createExtensionApi()
		createWorkAttributionExtension()(forkApi.api)
		await forkApi.getHandler<SessionStartEvent>("session_start")(
			{ type: "session_start", reason: "fork", previousSessionFile: parentFile },
			forkCtx,
		)
		expect(getWorkId(forkCtx)).toBe(original)
		expect(getWorkSegment(forkCtx)).toEqual(originalSegment)
		await forkApi.getHandler<SessionShutdownEvent>("session_shutdown")(
			{ type: "session_shutdown", reason: "quit" },
			forkCtx,
		)
		setWorkId(parentCtx)
		const resumed = SessionManager.open(forkFile)
		const resumedCtx = { ...createContext({ cwd: dir }), sessionManager: resumed }
		const resumedApi = createExtensionApi()
		createWorkAttributionExtension()(resumedApi.api)
		await resumedApi.getHandler<SessionStartEvent>("session_start")(
			{ type: "session_start", reason: "resume", previousSessionFile: parentFile },
			resumedCtx,
		)
		expect(getWorkId(resumedCtx)).toBe(original)
		expect(getWorkSegment(resumedCtx)).toEqual(originalSegment)
	})

	it("ignores malformed copied work metadata and lets the session's ledger win", async () => {
		const sessionManager = SessionManager.inMemory(dir)
		sessionManager.appendCustomEntry("work_identity", { workId: "../../not-a-uuid" })
		const ctx = { ...createContext({ cwd: dir }), sessionManager }
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "fork" }, ctx)
		const workId = getWorkId(ctx)
		expect(workId).toMatch(/^[0-9a-f-]{36}$/)
		sessionManager.appendCustomEntry("work_identity", { workId: "00000000-0000-4000-8000-000000000000" })
		await api.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
		const resumed = createExtensionApi()
		createWorkAttributionExtension()(resumed.api)
		await resumed.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "resume" }, ctx)
		expect(getWorkId(ctx)).toBe(workId)
	})

	it("persists plan identity and explicitly continues it in another session", async () => {
		const parent = createContext({ cwd: dir })
		const workId = getWorkId(parent)
		const { path } = savePlanMarkdown({ cwd: dir, name: "test", planText: "# Plan", workId })
		expect(readPlanWorkId(readFileSync(path, "utf8"))).toBe(workId)
		const child = createContext({ cwd: dir, sessionManager: { getSessionId: () => "next-session" } })
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		const commandContext = { ...createCommandContext(), ...child }
		await mock.getRegisteredCommand("work").handler(path, commandContext)
		expect(getWorkId(child)).toBe(workId)
		expect(readPlanWorkId("<!-- kimchi-work-id: ../../escape -->")).toBeUndefined()
	})
	it.each([
		"Implement .kimchi/plans/feature.md",
		"please implement @.kimchi/plans/feature.md now",
		"Follow `PLANS/.kimchi/plans/feature.md`",
	])("continues a saved plan's work when the user names it: %s", async (text) => {
		const planWork = getWorkId(createContext({ cwd: dir, sessionManager: { getSessionId: () => "planner" } }))
		savePlanMarkdown({ cwd: dir, name: "feature", planText: "# Feature", workId: planWork })
		savePlanMarkdown({ cwd: join(dir, "PLANS"), name: "feature", planText: "# Feature", workId: planWork })
		const ctx = createContext({ cwd: dir, sessionManager: { getSessionId: () => "implementer" } })
		const provisional = getWorkId(ctx)
		recordProviderRequest(ctx)
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		await mock.getHandler<InputEvent>("input")({ type: "input", text, source: "interactive" }, ctx)
		expect(getWorkId(ctx)).toBe(planWork)
		expect(provisional).not.toBe(planWork)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(planWork), "info")
	})
	it("keeps its own work when it already committed, or when only an extension names the plan", async () => {
		const planWork = getWorkId(createContext({ cwd: dir, sessionManager: { getSessionId: () => "planner" } }))
		savePlanMarkdown({ cwd: dir, name: "feature", planText: "# Feature", workId: planWork })
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		const input = mock.getHandler<InputEvent>("input")
		const text = "Implement .kimchi/plans/feature.md"

		const nudged = createContext({ cwd: dir, sessionManager: { getSessionId: () => "nudged" } })
		const own = getWorkId(nudged)
		await input({ type: "input", text, source: "extension" }, nudged)
		expect(getWorkId(nudged)).toBe(own)

		const committed = createContext({ cwd: dir, sessionManager: { getSessionId: () => "committed" } })
		const committedWork = getWorkId(committed)
		appendWorkRecord(committed, { type: "commit", sha: "a".repeat(40), repository: "/r/.git", worktree: "/r" })
		await input({ type: "input", text, source: "interactive" }, committed)
		expect(getWorkId(committed)).toBe(committedWork)
	})
	it.each([
		"interactive",
		"rpc",
	] as const)("continues a retained plan after deleting its original worktree (%s)", async (source) => {
		const original = join(dir, "original-worktree")
		const planner = createContext({ cwd: original, sessionManager: { getSessionId: () => "planner" } })
		const planWork = setWorkId(planner, source === "rpc" ? getWorkId(planner).toUpperCase() : undefined)
		const saved = savePlanMarkdown({ cwd: original, name: "feature", planText: "# Feature", workId: planWork })
		expect(saved.snapshotPath).toEqual(expect.any(String))
		rmSync(original, { recursive: true })
		const cwd = join(dir, "other-worktree")
		const ctx = createContext({ cwd, sessionManager: { getSessionId: () => "implementer" } })
		const provisional = getWorkId(ctx)
		// A same-named local plan belongs to different work; only the explicit retained path selects the original.
		savePlanMarkdown({ cwd, name: "feature", planText: "# Different feature", workId: provisional })
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		await mock.getHandler<InputEvent>("input")({ type: "input", text: "Implement feature.md", source }, ctx)
		expect(getWorkId(ctx)).toBe(provisional)
		await mock.getHandler<InputEvent>("input")({ type: "input", text: `Implement ${saved.snapshotPath}`, source }, ctx)
		expect(recordProviderRequest(ctx).workId).toBe(planWork)
	})
	it("reads only leading plan metadata and leaves example UUIDs unrelated", () => {
		const workId = "11111111-1111-4111-8111-111111111111"
		const example = "22222222-2222-4222-8222-222222222222"
		const body = `# Plan\n\`\`\`markdown\n<!-- kimchi-work-id: ${example} -->\n\`\`\`\n`
		expect(readPlanWorkId(body)).toBeUndefined()
		expect(readPlanWorkId(`<!-- kimchi-work-id: ${workId} -->`)).toBe(workId)
		expect(readPlanWorkId(`<!-- kimchi-work-id: ${workId} -->\r\n${body}`)).toBe(workId)
		expect(readPlanWorkId(`<!-- kimchi-work-id: invalid -->\n${body}`)).toBeUndefined()
		expect(readPlanWorkId(`<!-- kimchi-work-id: ${workId} --> trailing`)).toBeUndefined()
	})

	it("does not register tool-result handlers that infer work from arbitrary plan reads", () => {
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		expect(mock.getHandlers("tool_result")).toHaveLength(0)
	})

	it("restores work after shutdown and records a new explicit work separately", async () => {
		const ctx = createContext({ cwd: dir })
		const original = getWorkId(ctx)
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		await mock.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
		expect(getWorkId(ctx)).toBe(original)
		expect(setWorkId(ctx)).not.toBe(original)
	})
	it("attaches persisted request identity to timing diagnostics", async () => {
		const ctx = createContext({ cwd: dir })
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		requestTimingExtension(mock.api)
		const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		for (const handler of mock.getHandlers<BeforeProviderHeadersEvent>("before_provider_headers"))
			await handler(event, ctx)
		await mock.getHandler("after_provider_response")({ type: "after_provider_response", status: 200, headers: {} }, ctx)
		// turn_start also flushes a response without an assistant message (e.g. compaction).
		for (const handler of mock.getHandlers("turn_start")) await handler({}, ctx)
		const request = records().find((row) => row.type === "request")
		expect(mock.getAppendedEntries("request_diagnostics")).toEqual([
			expect.objectContaining({ requestId: request.requestId, workId: request.workId }),
		])
	})
	it("warns visibly when local persistence fails and never exposes a false request ID", async () => {
		writeFileSync(join(dir, "work-attribution"), "blocked")
		const ctx = createContext({ cwd: dir })
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await mock.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(event, ctx)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Work attribution unavailable"), "warning")
		expect(event.headers["X-Request-Id"]).toBeUndefined()
	})
	it("keeps new request rows readable after a process left a partial tail", () => {
		const ctx = createContext({ cwd: dir })
		getWorkId(ctx)
		const path = join(dir, "work-attribution", "test-session.jsonl")
		appendFileSync(path, '{"type":"request"')
		const next = recordProviderRequest(ctx)
		const rows = readFileSync(path, "utf8").trim().split("\n")
		expect(JSON.parse(rows.at(-1) ?? "").requestId).toBe(next.requestId)
	})
})

describe("cost-per-PR switch", () => {
	it("turns attribution from other extensions into a no-op that writes nothing", async () => {
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", dir)
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ resources: { "extensions.cost-per-pr": false } }))
		const record = vi.fn(() => "recorded")

		expect(tryWorkAttribution(record)).toBeUndefined()
		expect(await tryWorkAttributionAsync(async () => record())).toBeUndefined()
		const local = createLocalBashOperations()
		expect(createWorkCommitTrackingOperations(createContext({ cwd: dir }), "bash-call", local)).toBe(local)

		expect(record).not.toHaveBeenCalled()
		expect(readdirSync(dir)).toEqual(["settings.json"])
	})
})
