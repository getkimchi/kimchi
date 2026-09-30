import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type BeforeProviderHeadersEvent,
	type ExtensionContext,
	type InputEvent,
	SessionManager,
	type SessionShutdownEvent,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import { readPlanWorkId, savePlanMarkdown } from "../shared/planning/plan-markdown.js"
import { createCommandContext, createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import requestTimingExtension from "./request-timing.js"
import * as transitions from "./work-attribution/file-transitions.js"
import { flushWorkSummaries } from "./work-attribution/summary.js"
import {
	appendWorkRecord,
	createWorkAttributionExtension,
	getWorkId,
	recordProviderRequest,
	setWorkId,
} from "./work-attribution.js"

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-work-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
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
	it("lets a child shut down while its parent still reconciles, then drains the parent's own work", async () => {
		let release!: () => void
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		const reconcile = vi.spyOn(transitions, "reconcileFileTransitions").mockImplementation(() => blocked)
		const parent = createContext({ cwd: dir })
		const parentApi = createExtensionApi()
		createWorkAttributionExtension()(parentApi.api)
		await parentApi.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, parent)
		const child = createContext({ cwd: dir, sessionManager: { getSessionId: () => "child-shutdown" } })
		const childApi = createExtensionApi()
		createWorkAttributionExtension(getWorkId(parent))(childApi.api)
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
			const signal = reconcile.mock.calls[0][1]
			expect(signal?.aborted).toBe(false)
			let parentStopped = false
			parentShutdown = Promise.resolve(
				parentApi.getHandler<SessionShutdownEvent>("session_shutdown")(
					{ type: "session_shutdown", reason: "quit" },
					parent,
				),
			).then(() => {
				parentStopped = true
			})
			expect(signal?.aborted).toBe(true)
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

	it("restores the work at a real historical fork point and preserves the fork on resume", async () => {
		const parent = SessionManager.create(dir, join(dir, "sessions"))
		const parentCtx = { ...createContext({ cwd: dir }), sessionManager: parent }
		const api = createExtensionApi()
		api.appendEntry.mockImplementation((type, data) => {
			parent.appendCustomEntry(type, data)
		})
		createWorkAttributionExtension()(api.api)
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

describe("local work summary view", () => {
	/** The summary view is info-severity; the warning call is persistence's own signal. */
	function infoNotification(context: ExtensionContext): string {
		const calls = (context.ui.notify as Mock).mock.calls as [string, string][]
		const message = calls.find(([, severity]) => severity === "info")?.[0]
		if (!message) throw new Error(`Expected an info notification but got: ${JSON.stringify(calls)}`)
		return message
	}

	it.each([undefined, "{"])("shows the empty state when the summary is missing or invalid (%s)", async (corrupt) => {
		const ctx = createContext({ cwd: dir })
		const workId = getWorkId(ctx)
		await flushWorkSummaries()
		const summaryPath = join(dir, "work", workId, "work.json")
		expect(existsSync(summaryPath)).toBe(true)
		if (corrupt === undefined) rmSync(summaryPath)
		else writeFileSync(summaryPath, corrupt)
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		await mock.getRegisteredCommand("work").handler("--summary", { ...createCommandContext(), ...ctx })
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No work summary yet"), "info")
		const message = infoNotification(ctx)
		expect(message).toContain(workId)
		expect(message).toContain(summaryPath)
	})

	it("shows a fresh session's empty counts on first run", async () => {
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		const ctx = createContext({ cwd: dir })
		await mock.getRegisteredCommand("work").handler("--summary", { ...createCommandContext(), ...ctx })
		const workId = getWorkId(ctx)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Sessions: 1"), "info")
		const message = infoNotification(ctx)
		expect(message).toContain("Requests: 0")
		expect(message).toContain("Plan versions: 0")
		expect(message).toContain("Commits: 0 unique")
		expect(message).toContain("Models: none")
		expect(message).toContain(workId)
		expect(message).toContain(join(dir, "work", workId, "work.json"))
	})

	it("counts repeated commit hashes once across sessions", async () => {
		const parent = createContext({ cwd: dir })
		const workId = getWorkId(parent)
		const child = createContext({ cwd: dir, sessionManager: { getSessionId: () => "child" } })
		setWorkId(child, workId)
		appendWorkRecord(parent, { type: "commit", sha: "a".repeat(40), repository: "/r/.git", worktree: "/r" })
		appendWorkRecord(child, { type: "commit", sha: "a".repeat(40), repository: "/r/.git", worktree: "/r" })
		appendWorkRecord(child, { type: "commit", sha: "b".repeat(40), repository: "/r/.git", worktree: "/r" })
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		await mock.getRegisteredCommand("work").handler("--summary", { ...createCommandContext(), ...parent })
		expect(parent.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Commits: 2 unique"), "info")
		expect(infoNotification(parent)).toContain("Sessions: 2")
	})

	it("summarizes multiple sessions, requests, plan versions, and models", async () => {
		const parent = createContext({ cwd: dir })
		const workId = getWorkId(parent)
		const child = createContext({ cwd: dir, sessionManager: { getSessionId: () => "child" } })
		setWorkId(child, workId)
		recordProviderRequest(parent, { provider: "test", id: "model-a" })
		recordProviderRequest(parent, { provider: "test", id: "model-a" })
		recordProviderRequest(child, { provider: "test", id: "model-b" })
		appendWorkRecord(parent, {
			type: "plan",
			path: "/repo/plans/feature.md",
			snapshotPath: "/repo/plans/snapshots/v1.md",
		})
		appendWorkRecord(child, {
			type: "plan",
			path: "/repo/plans/feature.md",
			snapshotPath: "/repo/plans/snapshots/v2.md",
		})
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		await mock.getRegisteredCommand("work").handler("--summary", { ...createCommandContext(), ...parent })
		expect(parent.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Models: model-a, model-b"), "info")
		const message = infoNotification(parent)
		expect(message).toContain("Sessions: 2")
		expect(message).toContain("Requests: 3")
		expect(message).toContain("Plan versions: 2")
		expect(message).toContain(join(dir, "work", workId, "work.json"))
	})

	it("reports the summary without switching identity or fabricating records, preserving /work and /work new", async () => {
		const ctx = createContext({ cwd: dir })
		const workId = getWorkId(ctx)
		const before = records()
		const mock = createExtensionApi()
		createWorkAttributionExtension()(mock.api)
		const commandContext = { ...createCommandContext(), ...ctx }
		await mock.getRegisteredCommand("work").handler("--summary", commandContext)
		expect(getWorkId(ctx)).toBe(workId)
		expect(records()).toEqual(before)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(workId), "info")
		await mock.getRegisteredCommand("work").handler("", commandContext)
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(`Work ID: ${workId}`, "info")
		await mock.getRegisteredCommand("work").handler("new", commandContext)
		expect(getWorkId(ctx)).not.toBe(workId)
	})
})
