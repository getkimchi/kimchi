import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BeforeProviderHeadersEvent, SessionShutdownEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { savePlanMarkdown } from "../shared/planning/plan-markdown.js"
import { createCommandContext, createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import requestTimingExtension from "./request-timing.js"
import {
	createWorkAttributionExtension,
	getWorkId,
	readPlanWorkId,
	recordProviderRequest,
	setWorkId,
} from "./work-attribution.js"

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-work-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
})
afterEach(() => {
	vi.unstubAllEnvs()
	rmSync(dir, { recursive: true, force: true })
})
function records() {
	return readdirSync(join(dir, "work-attribution")).flatMap((file) =>
		readFileSync(join(dir, "work-attribution", file), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line)),
	)
}
describe("local work attribution", () => {
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
		setWorkId(child, original)
		const old = createExtensionApi()
		createWorkAttributionExtension(original)(old.api)
		await old.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, child)
		const parentNext = setWorkId(parent)
		const reopened = createExtensionApi()
		createWorkAttributionExtension(parentNext)(reopened.api)
		await reopened.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(
			{ type: "before_provider_headers", headers: {} },
			child,
		)
		expect(getWorkId(child)).toBe(original)
		const fresh = createContext({ cwd: dir, sessionManager: { getSessionId: () => "fresh-child" } })
		await reopened.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(
			{ type: "before_provider_headers", headers: {} },
			fresh,
		)
		expect(getWorkId(fresh)).toBe(parentNext)
	})

	it("persists plan identity and explicitly continues it in another session", async () => {
		const parent = createContext({ cwd: dir })
		const workId = getWorkId(parent)
		const path = savePlanMarkdown({ cwd: dir, name: "test", planText: "# Plan", workId })
		expect(readPlanWorkId(readFileSync(path, "utf8"))).toBe(workId)
		const child = createContext({ cwd: dir, sessionManager: { getSessionId: () => "next-session" } })
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		const commandContext = { ...createCommandContext(), ...child }
		await mock.getRegisteredCommand("work").handler(path, commandContext)
		expect(getWorkId(child)).toBe(workId)
		expect(readPlanWorkId("<!-- kimchi-work-id: ../../escape -->")).toBeUndefined()
	})
	it("does not reassign work when reading a historical plan", async () => {
		const ctx = createContext({ cwd: dir })
		const original = getWorkId(ctx)
		const other = createContext({ cwd: dir, sessionManager: { getSessionId: () => "historical" } })
		const path = savePlanMarkdown({ cwd: dir, name: "historical", planText: "# History", workId: getWorkId(other) })
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		for (const handler of mock.getHandlers<ToolResultEvent>("tool_result"))
			await handler(
				{
					type: "tool_result",
					toolName: "read",
					toolCallId: "read",
					input: { path },
					content: [],
					details: {},
					isError: false,
				},
				ctx,
			)
		expect(getWorkId(ctx)).toBe(original)
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
		await mock.getHandler("turn_start")({}, ctx)
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
