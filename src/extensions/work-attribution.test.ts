import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type BeforeProviderHeadersEvent,
	type InputEvent,
	SessionManager,
	type SessionShutdownEvent,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readPlanWorkId, savePlanMarkdown } from "../shared/planning/plan-markdown.js"
import { createCommandContext, createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import requestTimingExtension from "./request-timing.js"
import * as continuation from "./work-attribution/continuation.js"
import * as supervisor from "./work-attribution/reconcile-supervisor.js"
import { flushWorkSummaries } from "./work-attribution/summary.js"
import {
	appendWorkRecord,
	createWorkAttributionExtension,
	getToolRequest,
	getWorkId,
	recordProviderRequest,
	setWorkId,
} from "./work-attribution.js"

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-work-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
	vi.spyOn(supervisor, "subscribeFileReconciliation").mockReturnValue(async () => {})
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
	it("shows pending PRs, explains errors once, and clears the status when work changes", async () => {
		const ctx = createContext({ cwd: dir })
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
		const update = vi.mocked(supervisor.subscribeFileReconciliation).mock.calls[0][0]?.onPullRequest
		const commit = {
			workId: getWorkId(ctx),
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: dir,
			repository: join(dir, ".git"),
			worktree: dir,
			sha: "a".repeat(40),
			pullRequests: [],
		}
		update?.(commit)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR: waiting")
		const failed = {
			...commit,
			prLookup: { status: "error" as const, checkedAt: new Date().toISOString(), error: "Run gh auth login" },
		}
		update?.(failed)
		update?.(failed)
		await Promise.resolve()
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR: check /work")
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("gh auth login"), "warning")
		const linked = {
			...commit,
			prLookup: { status: "linked" as const, checkedAt: new Date().toISOString() },
			pullRequests: [
				{
					url: "https://github.com/example/repo/pull/7",
					number: 7,
					state: "open" as const,
					repository: "example/repo",
					host: "github.com",
					headSha: commit.sha,
					mergeCommitSha: null,
					mergedAt: null,
					closedAt: null,
					checkedAt: new Date().toISOString(),
				},
			],
		}
		update?.(linked)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR: #7 open")
		const checkedAt = new Date(Date.now() + 1000).toISOString()
		update?.({
			...linked,
			sessionId: "newer-contributor",
			prLookup: { status: "linked", checkedAt },
			pullRequests: [{ ...linked.pullRequests[0], state: "merged", mergedAt: checkedAt, checkedAt }],
		})
		// Snapshot replay can still contain another contributor's older observation.
		update?.(linked)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR: #7 merged")
		const warningCount = vi.mocked(ctx.ui.notify).mock.calls.length
		const otherSha = "b".repeat(40)
		update?.({
			...failed,
			sha: otherSha,
			prLookup: { ...failed.prLookup, error: "Old access failure" },
		})
		update?.({
			...linked,
			sha: otherSha,
			sessionId: "newer-contributor",
			prLookup: { status: "linked", checkedAt },
		})
		await Promise.resolve()
		expect(ctx.ui.notify).toHaveBeenCalledTimes(warningCount)
		const commandCtx = { ...createCommandContext(), ...ctx }
		await api.getRegisteredCommand("work").handler("", commandCtx)
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(linked.pullRequests[0].url), "info")
		await api.getRegisteredCommand("work").handler("new", commandCtx)
		update?.(linked)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", undefined)
		await api.getHandler<SessionShutdownEvent>("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
	})
	it("adopts a named artifact before dispatch and records why the sessions were joined", async () => {
		const ctx = createContext({ cwd: dir })
		const workId = getWorkId(createContext({ cwd: dir, sessionManager: { getSessionId: () => "planning" } }))
		const selected = {
			workId,
			source: "named-artifact" as const,
			evidence: { path: "/project/ADR.md", transitionId: "planning-write" },
		}
		vi.spyOn(continuation, "findWorkContinuation").mockResolvedValue(selected)
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		await api.getHandler<InputEvent>("input")({ type: "input", text: "Implement ADR.md", source: "rpc" }, ctx)
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
	it("allows the branch fallback only on a fresh session's first external input", async () => {
		const find = vi.spyOn(continuation, "findWorkContinuation").mockResolvedValue(undefined)
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const input = api.getHandler<InputEvent>("input")
		const ctx = createContext({ cwd: dir })
		await input({ type: "input", text: "Implement", source: "extension" }, ctx)
		expect(find).not.toHaveBeenCalled()
		await input({ type: "input", text: "Implement", source: "interactive" }, ctx)
		expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: dir }), "Implement", {
			allowBranchFallback: true,
		})
		await input({ type: "input", text: "Continue", source: "interactive" }, ctx)
		expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: dir }), "Continue", {
			allowBranchFallback: false,
		})
		const started = createContext({ cwd: dir, sessionManager: { getSessionId: () => "requested" } })
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(
			{ type: "before_provider_headers", headers: {} },
			started,
		)
		await input({ type: "input", text: "Later", source: "interactive" }, started)
		expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: dir }), "Later", {
			allowBranchFallback: false,
		})
	})
	it("allows fresh continuation after an earlier startup hook allocated the ledger", async () => {
		const ctx = createContext({ cwd: dir })
		getWorkId(ctx)
		const find = vi.spyOn(continuation, "findWorkContinuation").mockResolvedValue(undefined)
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		await api.getHandler<InputEvent>("input")({ type: "input", text: "Implement", source: "rpc" }, ctx)
		expect(find).toHaveBeenCalledWith(expect.objectContaining({ cwd: dir }), "Implement", { allowBranchFallback: true })
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
		expect(find).not.toHaveBeenCalled()
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
		expect(find).not.toHaveBeenCalled()
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
