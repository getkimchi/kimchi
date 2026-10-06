import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	type BeforeProviderHeadersEvent,
	type InputEvent,
	type InputEventResult,
	type MessageStartEvent,
	SessionManager,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { createModel, createModelRegistry } from "./__mocks__/model-registry.js"
import { createWorkScopeSnapshot } from "./__mocks__/work-scope.js"
import * as continuation from "./work-attribution/continuation.js"
import * as supervisor from "./work-attribution/reconcile-supervisor.js"
import * as scope from "./work-attribution/scope.js"
import * as semantic from "./work-attribution/semantic.js"
import { flushWorkSummaries } from "./work-attribution/summary.js"
import {
	createWorkAttributionExtension,
	getToolRequest,
	getWorkId,
	getWorkSegment,
	workLedgerPath,
} from "./work-attribution.js"

let dir: string
let captured: scope.WorkScopeSnapshot
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-work-input-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
	captured = createWorkScopeSnapshot(join(dir, ".git"))
	vi.spyOn(scope, "captureWorkScope").mockResolvedValue(captured)
	vi.spyOn(scope, "readWorkScope").mockReturnValue(captured.scope)
	vi.spyOn(supervisor, "subscribeFileReconciliation").mockReturnValue(async () => {})
	vi.spyOn(supervisor, "subscribeCostReconciliation").mockReturnValue(async () => {})
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(dir, { recursive: true, force: true })
})
function requestRow(requestId: unknown) {
	return readdirSync(join(dir, "work-attribution"))
		.filter((file) => file.endsWith(".jsonl"))
		.flatMap((file) =>
			readFileSync(join(dir, "work-attribution", file), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		)
		.find((row) => row.type === "request" && row.requestId === requestId)
}

describe("input submitted while the agent is still streaming", () => {
	// Pi 0.85.1 AgentSession.prompt() awaits emitInput() for steer/followUp messages
	// BEFORE queueing them, while the current agent loop keeps dispatching requests.
	it("keeps the in-flight run's next request in its own segment after a queued follow-up", async () => {
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const ctx = createContext({ cwd: dir })
		const input = api.getHandler<InputEvent>("input")
		const headers = api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")
		await input({ type: "input", text: "Implement the export feature", source: "interactive" }, ctx)
		const original = getWorkSegment(ctx)
		const first: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await headers(first, ctx)
		// Alt+Enter while streaming: input event fires now, the message is delivered only after the run ends.
		await input(
			{ type: "input", text: "Afterwards, explain closures", source: "interactive", streamingBehavior: "followUp" },
			ctx,
		)
		// The agent loop continues input 1's tool turn before the follow-up is delivered.
		const next: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await headers(next, ctx)
		expect(requestRow(next.headers["X-Request-Id"]).segment.id).toBe(original?.id)
	})

	it("keeps the in-flight run's next request in its work when a queued follow-up names another plan", async () => {
		const planned = "11111111-1111-4111-8111-111111111111"
		vi.spyOn(continuation, "findWorkContinuation").mockImplementation(async (_ctx, text) =>
			text.includes("plan.md")
				? { workId: planned, source: "saved-plan", evidence: { path: "/plans/plan.md", contentHash: "a".repeat(64) } }
				: undefined,
		)
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const ctx = createContext({ cwd: dir })
		const input = api.getHandler<InputEvent>("input")
		const headers = api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")
		await input({ type: "input", text: "How does the auth middleware work?", source: "interactive" }, ctx)
		const original = getWorkId(ctx)
		await headers({ type: "before_provider_headers", headers: {} }, ctx)
		await input(
			{ type: "input", text: "Then implement /plans/plan.md", source: "interactive", streamingBehavior: "followUp" },
			ctx,
		)
		const next: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await headers(next, ctx)
		expect(requestRow(next.headers["X-Request-Id"]).workId).toBe(original)
	})
})

describe("steer message classified while a run is still implementing", () => {
	it("keeps the running implementation's next request and tool provenance in the original work", async () => {
		const repository = join(dir, ".git")
		vi.spyOn(semantic, "workMatchingEnabled").mockReturnValue(true)
		vi.spyOn(semantic, "rememberWorkIntent").mockResolvedValue()
		vi.spyOn(scope, "workRepository").mockResolvedValue(repository)
		const classify = vi.spyOn(semantic, "classifyWorkIntent")
		vi.spyOn(semantic, "loadWorkIntents").mockImplementation(async (_cwd, workId, text) => ({
			repository,
			account: { account: captured.scope.account, isCurrent: () => true },
			input: { current: { workId, summary: "Implement CSV export" }, candidates: [], message: text },
		}))
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const ctx = createContext({ cwd: dir, model: createModel("chat"), modelRegistry: createModelRegistry() })
		const input = api.getHandler<InputEvent>("input")
		const headers = api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")
		classify.mockResolvedValueOnce({ decision: "same", model: "kimchi-dev/chat" })
		await input({ type: "input", text: "Implement CSV export", source: "interactive" }, ctx)
		const original = getWorkId(ctx)
		await headers({ type: "before_provider_headers", headers: {} }, ctx)
		// User presses Enter while the agent is mid-run: pi emits input, then queues a steer.
		classify.mockResolvedValueOnce({ decision: "new", model: "kimchi-dev/chat" })
		await input(
			{ type: "input", text: "btw what is a closure?", source: "interactive", streamingBehavior: "steer" },
			ctx,
		)
		// A request the running loop dispatched before the steer was queued.
		const next: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await headers(next, ctx)
		await api.getHandler("message_end")(
			{
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "edit-export", name: "edit" }],
				},
			},
			ctx,
		)
		expect({
			request: requestRow(next.headers["X-Request-Id"]).workId,
			edit: getToolRequest(ctx, "edit-export")?.workId,
		}).toEqual({ request: original, edit: original })
	})
})

describe("queued input delivery", () => {
	it.each([
		"steer",
		"followUp",
	] as const)("attributes a %s only when its message reaches the model", async (streamingBehavior) => {
		const planned = "11111111-1111-4111-8111-111111111111"
		const find = vi
			.spyOn(continuation, "findWorkContinuation")
			.mockImplementation(async (_ctx, text) =>
				text.includes("plan.md")
					? { workId: planned, source: "saved-plan", evidence: { path: "/plans/plan.md" } }
					: undefined,
			)
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const ctx = createContext({ cwd: dir })
		const input = api.getHandler<InputEvent>("input")
		const deliver = api.getHandler<MessageStartEvent>("message_start")
		await input({ type: "input", text: "Explain the existing code", source: "interactive" }, ctx)
		const original = { workId: getWorkId(ctx), segment: getWorkSegment(ctx) }
		await api.getHandler("before_agent_start")({}, ctx)
		await deliver(
			{ type: "message_start", message: { role: "user", content: "Expanded initial prompt", timestamp: 1 } },
			ctx,
		)
		expect(getWorkSegment(ctx)).toEqual(original.segment)
		find.mockClear()
		await input({ type: "input", text: "Implement /plans/plan.md", source: "interactive", streamingBehavior }, ctx)
		expect(find).not.toHaveBeenCalled()
		expect(getWorkId(ctx)).toBe(original.workId)
		await deliver(
			{
				type: "message_start",
				message: { role: "user", content: [{ type: "text", text: "Implement /plans/plan.md" }], timestamp: 2 },
			},
			ctx,
		)
		const headers: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(headers, ctx)
		expect(requestRow(headers.headers["X-Request-Id"])).toMatchObject({
			workId: planned,
			segment: { attribution: "explicit" },
		})
		expect(getWorkSegment(ctx)?.id).not.toBe(original.segment?.id)
		await api.getHandler("message_end")(
			{
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "queued-edit", name: "edit" }],
				},
			},
			ctx,
		)
		expect(getToolRequest(ctx, "queued-edit")).toMatchObject({
			workId: planned,
			requestId: headers.headers["X-Request-Id"],
		})
	})

	it.each([
		"steer",
		"followUp",
	] as const)("tells an identical user %s from a queued extension input in Pi's delivery order", async (streamingBehavior) => {
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		// Pi still holds the extension message when the user queues the same text.
		const ctx = createContext({ cwd: dir, hasPendingMessages: vi.fn(() => true) })
		const input = api.getHandler<InputEvent, InputEventResult>("input")
		const deliver = api.getHandler<MessageStartEvent>("message_start")
		await input({ type: "input", text: "Implement export", source: "interactive" }, ctx)
		const original = getWorkSegment(ctx)
		const text = "Explain the export step"
		expect(
			await input({ type: "input", text, source: "extension", streamingBehavior: "followUp" }, ctx),
		).toBeUndefined()
		await input({ type: "input", text, source: "interactive", streamingBehavior }, ctx)
		const message = (timestamp: number): MessageStartEvent => ({
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text }], timestamp },
		})
		// Pi delivers steering before follow-ups, and each queue in order.
		if (streamingBehavior === "followUp") {
			await deliver(message(1), ctx)
			expect(getWorkSegment(ctx)).toEqual(original)
		}
		await deliver(message(2), ctx)
		const userSegment = getWorkSegment(ctx)
		expect(userSegment?.id).not.toBe(original?.id)
		if (streamingBehavior === "steer") {
			await deliver(message(3), ctx)
			expect(getWorkSegment(ctx)).toEqual(userSegment)
		}
	})

	it("attributes a user message restored to the editor and queued again", async () => {
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const pending = vi.fn(() => true)
		const ctx = createContext({ cwd: dir, hasPendingMessages: pending })
		const input = api.getHandler<InputEvent>("input")
		const deliver = api.getHandler<MessageStartEvent>("message_start")
		await input({ type: "input", text: "Implement export", source: "interactive" }, ctx)
		const original = getWorkSegment(ctx)
		const text = "Explain the export step"
		await input({ type: "input", text, source: "extension", streamingBehavior: "followUp" }, ctx)
		// The user dequeues it into the editor; Pi's queue is now empty.
		pending.mockReturnValue(false)
		await input({ type: "input", text, source: "interactive", streamingBehavior: "followUp" }, ctx)
		await deliver({ type: "message_start", message: { role: "user", content: text, timestamp: 1 } }, ctx)
		expect(getWorkSegment(ctx)?.id).not.toBe(original?.id)
	})

	it("keeps an extension follow-up in the current input when the user queues a steer during its delivery", async () => {
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const ctx = createContext({ cwd: dir, hasPendingMessages: vi.fn(() => false) })
		const input = api.getHandler<InputEvent>("input")
		const deliver = api.getHandler<MessageStartEvent>("message_start")
		await input({ type: "input", text: "Implement export", source: "interactive" }, ctx)
		const original = getWorkSegment(ctx)
		const text = "Retry the export step"
		await input({ type: "input", text, source: "extension", streamingBehavior: "followUp" }, ctx)
		// Pi has already dequeued the follow-up while another extension's message_start handler runs.
		await input({ type: "input", text: "Also update the docs", source: "interactive", streamingBehavior: "steer" }, ctx)
		await deliver({ type: "message_start", message: { role: "user", content: text, timestamp: 1 } }, ctx)
		expect(getWorkSegment(ctx)).toEqual(original)
		await deliver(
			{ type: "message_start", message: { role: "user", content: "Also update the docs", timestamp: 2 } },
			ctx,
		)
		expect(getWorkSegment(ctx)?.id).not.toBe(original?.id)
	})

	it("keeps extension follow-ups and harness nudges in the current input", async () => {
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const ctx = createContext({ cwd: dir })
		const input = api.getHandler<InputEvent, InputEventResult>("input")
		const deliver = api.getHandler<MessageStartEvent>("message_start")
		await input({ type: "input", text: "Implement export", source: "interactive" }, ctx)
		const original = getWorkSegment(ctx)
		const text = "Retry the export step"
		expect(
			await input({ type: "input", text, source: "extension", streamingBehavior: "followUp" }, ctx),
		).toBeUndefined()
		await deliver({ type: "message_start", message: { role: "user", content: text, timestamp: 1 } }, ctx)
		await deliver(
			{
				type: "message_start",
				message: { role: "user", content: "<system-reminder>\nContinue the work\n</system-reminder>", timestamp: 2 },
			},
			ctx,
		)
		expect(getWorkSegment(ctx)).toEqual(original)
	})
})

it.each(["fresh", "established"])("keeps an unowned Markdown mention in an ordinary %s session", async (kind) => {
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const ctx = createContext({ cwd: dir })
	const input = api.getHandler<InputEvent>("input")
	if (kind === "established") await input({ type: "input", text: "Explain the code", source: "interactive" }, ctx)
	await input({ type: "input", text: "Fix the typo in README.md and follow AGENTS.md", source: "interactive" }, ctx)
	expect(getWorkSegment(ctx)).toMatchObject({ attribution: "session", reason: "matching-disabled" })
})

describe("fresh-session guard after scope recovery", () => {
	it("does not let a restored session with output adopt another work after its unscoped work is replaced", async () => {
		const legacy = randomUUID()
		const other = "22222222-2222-4222-8222-222222222222"
		vi.spyOn(scope, "readWorkScope").mockImplementation((workId) => (workId === legacy ? undefined : captured.scope))
		const find = vi.spyOn(continuation, "findWorkContinuation").mockResolvedValue({
			workId: other,
			source: "named-artifact",
			evidence: { path: join(dir, "docs/adr.md"), transitionId: randomUUID() },
		})
		const manager = SessionManager.inMemory(dir)
		manager.appendCustomEntry("work_identity", { workId: legacy })
		manager.appendMessage({ role: "user", content: "Write the migration", timestamp: 1 })
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "write-1",
			toolName: "write",
			isError: false,
			content: [{ type: "text", text: "Written" }],
			timestamp: 2,
		})
		const ctx = { ...createContext({ cwd: dir }), sessionManager: manager }
		// Ledger written by an earlier Kimchi process, before scope.json existed.
		mkdirSync(join(dir, "work-attribution"), { recursive: true })
		writeFileSync(
			workLedgerPath(ctx),
			`${JSON.stringify({ version: 1, type: "work", workId: legacy, sessionId: manager.getSessionId(), cwd: dir, recordedAt: new Date(0).toISOString() })}\n`,
		)
		const api = createExtensionApi()
		api.appendEntry.mockImplementation((type, data) => {
			manager.appendCustomEntry(type, data)
		})
		createWorkAttributionExtension()(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "resume" }, ctx)
		expect(getWorkId(ctx)).toBe(legacy)
		await api.getHandler<InputEvent>("input")(
			{ type: "input", text: "Now implement docs/adr.md", source: "interactive" },
			ctx,
		)
		expect(find).toHaveBeenCalled()
		// Documented: "Restored sessions and existing work output prevent adopting another saved task."
		expect(getWorkId(ctx)).not.toBe(other)
	})
})

it("leaves an input unresolved without a warning when matching history exceeds its limits", async () => {
	vi.spyOn(semantic, "workMatchingEnabled").mockReturnValue(true)
	vi.spyOn(semantic, "loadWorkIntents").mockRejectedValue(
		new semantic.WorkMatchingLimit("more than 256 saved tasks to compare"),
	)
	const api = createExtensionApi()
	createWorkAttributionExtension()(api.api)
	const ctx = createContext({ cwd: dir, model: createModel("chat"), modelRegistry: createModelRegistry() })
	await api.getHandler<InputEvent>("input")({ type: "input", text: "Explain closures", source: "interactive" }, ctx)
	expect(getWorkSegment(ctx)).toMatchObject({ attribution: "unknown" })
	expect(ctx.ui.notify).not.toHaveBeenCalled()
})
