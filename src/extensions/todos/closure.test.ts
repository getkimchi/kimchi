import { SessionManager } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { runAsAgentWorker } from "../agent-worker-context.js"
import { FERMENT_V2_CUSTOM_ENTRY_TYPE } from "../ferment-v2/constants.js"
import { createFermentV2, putFermentV2Entry } from "../ferment-v2/reducer.js"
import { FERMENT_V2_STATUS, FERMENT_V2_STATUSES } from "../ferment-v2/types.js"
import { TODO_CLOSURE_CUSTOM_TYPE, TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import todosExtension from "./index.js"
import { getInputRevision } from "./reconciliation.js"
import { TODO_STALENESS_CUSTOM_TYPE } from "./staleness-steers.js"
import { __resetTodoStore, applyWriteTodos, registerActiveTodoScopeProvider } from "./store.js"
import { TODO_TOOL_NAMES } from "./tool.js"
import { TODO_STATUS, type TodoDraft } from "./types.js"

async function harness() {
	const api = createExtensionApi()
	const manager = SessionManager.inMemory("/tmp")
	const ctx = createContext()
	Object.assign(ctx, { sessionManager: manager, hasUI: false, hasPendingMessages: () => false })
	api.sendMessage.mockImplementation((message) => {
		manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details)
	})
	todosExtension(api.api)
	const fire = async (event: string, payload: unknown = {}) => {
		for (const handler of api.getHandlers(event)) await handler(payload, ctx)
	}
	await fire("session_start")
	const request = async () => {
		manager.appendMessage({ role: "user", content: "Verify and compare inputs", timestamp: 1 })
		// Genuine user input advances the session's input revision.
		await fire("input", { type: "input", text: "Verify and compare inputs", source: "interactive" })
	}
	await request()
	const write = (todos: TodoDraft[]) => {
		const details = applyWriteTodos({ todos }, manager.getSessionId())
		manager.appendCustomEntry(TODO_CUSTOM_ENTRY_TYPE, details)
	}
	/** A real assistant tool write: reconciles the scope against the current
	 *  input revision (background writes — plain `write` — do not). */
	const writeAsTool = (todos: TodoDraft[]) => {
		const sessionId = manager.getSessionId()
		const details = applyWriteTodos({ todos }, sessionId, {
			origin: "tool",
			inputRevision: getInputRevision(sessionId),
		})
		manager.appendCustomEntry(TODO_CUSTOM_ENTRY_TYPE, details)
	}
	const work = async (toolName = "bash", isError = false) => {
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "work",
			toolName,
			content: [{ type: "text", text: "Observed result" }],
			isError,
			timestamp: 1,
		})
		await fire("tool_execution_end", { toolName, isError })
	}
	const end = (stopReason = "stop", text = "Comparison done.") =>
		fire("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text }], stopReason },
			toolResults: [],
		})
	return {
		...api,
		manager,
		ctx,
		fire,
		write,
		writeAsTool,
		work,
		end,
		request,
		closure: () => api.sendMessage.mock.calls.filter(([message]) => message.customType === TODO_CLOSURE_CUSTOM_TYPE),
	}
}

describe("bounded todo cleanup", () => {
	beforeEach(__resetTodoStore)

	it("nudges at wrap-up after only later items were completed", async () => {
		const h = await harness()
		h.write([{ id: 1, content: "Verify inputs", status: TODO_STATUS.IN_PROGRESS }])
		for (let i = 0; i < 5; i++) await h.work()
		expect(h.sendMessage.mock.calls.filter(([m]) => m.customType === TODO_STALENESS_CUSTOM_TYPE)).toHaveLength(0)
		h.write([
			{ id: 1, content: "Verify inputs", status: TODO_STATUS.IN_PROGRESS },
			{ id: 2, content: "Collect results", status: TODO_STATUS.COMPLETED },
			{ id: 3, content: "Compare results", status: TODO_STATUS.COMPLETED },
		])
		await h.end()
		expect(h.closure()).toHaveLength(1)
		expect(h.closure()[0][0]).toMatchObject({ display: false, content: expect.stringContaining("Verify inputs") })
		expect(h.closure()[0][1]).toEqual({ deliverAs: "steer" })
	})

	it("cannot loop after todo edits or replay, but a new user request can be checked", async () => {
		const h = await harness()
		h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
		await h.work()
		await h.end()
		h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING, note: "Deferred" }])
		await h.end()
		await h.fire("session_tree")
		await h.end()
		await h.fire("session_shutdown")
		await h.fire("session_start", { reason: "resume" })
		await h.end()
		expect(h.closure()).toHaveLength(1)
		await h.request()
		await h.work()
		await h.end()
		expect(h.closure()).toHaveLength(2)
	})

	it("checks once on a conversational request with old unfinished todos", async () => {
		const h = await harness()
		h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
		await h.work()
		await h.request()
		await h.end("stop", "42")
		expect(h.closure()).toHaveLength(1)
		// Bounded per user request: a second terminal turn does not re-fire.
		await h.end("stop", "42")
		expect(h.closure()).toHaveLength(1)
	})

	it.each([...TODO_TOOL_NAMES, "write_todos"])("does not treat a %s result as reconciliation", async (name) => {
		const h = await harness()
		h.write([{ content: "Future task", status: TODO_STATUS.PENDING }])
		await h.work(name)
		await h.end()
		expect(h.closure()).toHaveLength(1)
	})

	it("does not fire without dangling todos", async () => {
		const h = await harness()
		h.write([{ content: "Done task", status: TODO_STATUS.COMPLETED }])
		await h.request()
		await h.end("stop", "All finished.")
		expect(h.closure()).toHaveLength(0)
	})

	describe("closure suppression via reconciliation", () => {
		it("suppresses the closure steer after a real reconciliation with no further work", async () => {
			const h = await harness()
			h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
			await h.work()
			h.writeAsTool([{ content: "Publish after approval", status: TODO_STATUS.PENDING, note: "Still deferred" }])
			await h.end()
			expect(h.closure()).toHaveLength(0)
		})

		it.each([
			...TODO_TOOL_NAMES,
			"write_todos",
		])("a real %s write reconciles and suppresses the closure check", async (name) => {
			const h = await harness()
			h.write([{ content: "Future task", status: TODO_STATUS.PENDING }])
			await h.work(name)
			h.writeAsTool([{ content: "Future task", status: TODO_STATUS.PENDING, note: "Reviewed" }])
			await h.end()
			expect(h.closure()).toHaveLength(0)
		})

		it("re-opens the closure check when work follows a reconciliation", async () => {
			const h = await harness()
			h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
			h.writeAsTool([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
			await h.work()
			await h.end()
			expect(h.closure()).toHaveLength(1)
		})

		it("invalidates reconciliation on newer user input", async () => {
			const h = await harness()
			h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
			h.writeAsTool([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
			await h.request()
			await h.end("stop", "42")
			expect(h.closure()).toHaveLength(1)
		})

		it("a background write does not satisfy the reconciliation check", async () => {
			const h = await harness()
			h.writeAsTool([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
			h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING, note: "Synced" }])
			await h.end()
			expect(h.closure()).toHaveLength(1)
		})

		it("an unrelated-scope write does not reconcile the global list", async () => {
			const h = await harness()
			h.write([{ content: "Global task", status: TODO_STATUS.PENDING }])
			const sessionId = h.manager.getSessionId()
			applyWriteTodos(
				{
					scope: { kind: "ferment-step", phaseId: "p", stepId: "s" },
					todos: [{ content: "Step task", status: "pending" }],
				},
				sessionId,
				{ origin: "tool", inputRevision: getInputRevision(sessionId) },
			)
			await h.end()
			expect(h.closure()).toHaveLength(1)
		})

		it("a command write reconciles the global list", async () => {
			const h = await harness()
			h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
			const sessionId = h.manager.getSessionId()
			applyWriteTodos({ todos: [{ content: "Publish after approval", status: TODO_STATUS.PENDING }] }, sessionId, {
				origin: "command",
				inputRevision: getInputRevision(sessionId),
			})
			await h.end()
			expect(h.closure()).toHaveLength(0)
		})

		it("clears unproven acknowledgments on replay", async () => {
			const h = await harness()
			h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
			h.writeAsTool([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
			await h.fire("session_tree")
			await h.end()
			expect(h.closure()).toHaveLength(1)
		})
	})

	it("requires a user request in the active branch", async () => {
		const h = await harness()
		h.manager.resetLeaf()
		h.write([{ content: "Work", status: TODO_STATUS.IN_PROGRESS }])
		await h.work()
		await h.end()
		expect(h.closure()).toHaveLength(0)
	})

	it("does not register parent reminders in agent workers", async () => {
		await runAsAgentWorker(async () => {
			const h = await harness()
			h.write([{ content: "Worker task", status: TODO_STATUS.IN_PROGRESS }])
			for (let i = 0; i < 30; i++) await h.work()
			await h.end()
			expect(h.closure()).toHaveLength(0)
			expect(h.sendMessage.mock.calls.filter(([m]) => m.customType === TODO_STALENESS_CUSTOM_TYPE)).toHaveLength(0)
		})
	})

	it("does not consume cleanup eligibility while tool results or user input are pending", async () => {
		const h = await harness()
		h.write([{ content: "Work", status: TODO_STATUS.IN_PROGRESS }])
		await h.work()
		await h.fire("turn_end", {
			message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
			toolResults: [{}],
		})
		h.ctx.hasPendingMessages = () => true
		await h.end()
		expect(h.closure()).toHaveLength(0)
		h.ctx.hasPendingMessages = () => false
		await h.end()
		expect(h.closure()).toHaveLength(1)
	})

	it("can clean up a failed tool attempt without counting it toward work reminders", async () => {
		const h = await harness()
		h.write([{ content: "Blocked attempt", status: TODO_STATUS.IN_PROGRESS }])
		for (let i = 0; i < 5; i++) await h.work("read", true)
		await h.end()
		expect(h.sendMessage.mock.calls.filter(([m]) => m.customType === TODO_STALENESS_CUSTOM_TYPE)).toHaveLength(0)
		expect(h.closure()).toHaveLength(1)
	})

	it("resets work reminder thresholds when switching to a branch before the reminder", async () => {
		const h = await harness()
		h.write([{ content: "Work", status: TODO_STATUS.IN_PROGRESS }])
		const fork = h.manager.getLeafId()
		if (!fork) throw new Error("Expected todo entry")
		for (let i = 0; i < 10; i++) await h.work()
		await h.end()
		h.manager.branch(fork)
		await h.fire("session_tree")
		await h.request()
		for (let i = 0; i < 10; i++) await h.work()
		await h.end()
		expect(h.closure()).toHaveLength(2)
		expect(
			h.sendMessage.mock.calls.filter(([m]) => m.customType === TODO_STALENESS_CUSTOM_TYPE).map(([m]) => m.details),
		).toEqual([
			{ reason: "staleness", threshold: 10, scope: { kind: "global" } },
			{ reason: "staleness", threshold: 10, scope: { kind: "global" } },
		])
	})

	it.each([
		"Verification passed. Should I publish?",
		"Verification passed. Waiting for your approval.",
		"Should I publish? Verification passed.",
	])("waits for the user after work: %s", async (answer) => {
		const h = await harness()
		h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
		await h.work()
		await h.end("stop", answer)
		expect(h.closure()).toHaveLength(0)
	})

	it("does not call a completed list stale", async () => {
		const h = await harness()
		h.write([{ content: "Finished setup", status: TODO_STATUS.COMPLETED }])
		for (let i = 0; i < 26; i++) await h.work("read")
		await h.end()
		expect(
			h.sendMessage.mock.calls.filter(([message]) => message.customType === TODO_STALENESS_CUSTOM_TYPE),
		).toHaveLength(0)
		expect(h.closure()).toHaveLength(0)
	})

	it("keeps cleanup bounded when compaction removes the reminder from model context", async () => {
		const h = await harness()
		h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
		await h.work()
		await h.end()
		expect(JSON.stringify(h.manager.buildSessionContext().messages)).toContain(TODO_CLOSURE_CUSTOM_TYPE)
		const kept = h.manager.appendCustomMessageEntry("test-checkpoint", "Deferred work remains open", false)
		h.manager.appendCompaction("Work done; publishing deferred", kept, 1000)
		expect(JSON.stringify(h.manager.buildSessionContext().messages)).not.toContain(TODO_CLOSURE_CUSTOM_TYPE)
		await h.fire("session_compact")
		await h.end()
		expect(h.closure()).toHaveLength(1)
		await h.request()
		await h.work()
		await h.end()
		expect(h.closure()).toHaveLength(2)
	})

	it("counts work reminders separately from the once-per-request cleanup", async () => {
		const h = await harness()
		h.write([{ content: "Long task", status: TODO_STATUS.IN_PROGRESS }])
		for (let i = 0; i < 30; i++) await h.work("read")
		await h.end()
		const reminders = () =>
			h.sendMessage.mock.calls
				.filter(([message]) => message.customType === TODO_STALENESS_CUSTOM_TYPE)
				.map(([message]) => message.details)
		expect(reminders()).toEqual(
			[10, 20, 30].map((threshold) => ({ reason: "staleness", threshold, scope: { kind: "global" } })),
		)
		expect(h.closure()).toHaveLength(1)
		h.write([{ content: "Long task", status: TODO_STATUS.IN_PROGRESS, note: "Progress recorded" }])
		for (let i = 0; i < 10; i++) await h.work("read")
		await h.end()
		expect(reminders()).toEqual(
			[10, 20, 30, 10].map((threshold) => ({ reason: "staleness", threshold, scope: { kind: "global" } })),
		)
		expect(h.closure()).toHaveLength(1)
	})

	it.each([
		"error",
		"aborted",
		"length",
		"toolUse",
		"queued input",
		"no tools",
		"blocked",
		"empty",
		"worker scope",
	])("skips cleanup for %s", async (reason) => {
		const h = await harness()
		h.write([{ content: "Work", status: reason === "blocked" ? TODO_STATUS.BLOCKED : TODO_STATUS.IN_PROGRESS }])
		if (reason === "empty") h.write([])
		if (reason === "queued input") h.ctx.hasPendingMessages = () => true
		if (reason === "no tools") h.api.setActiveTools([])
		const unregister =
			reason === "worker scope"
				? registerActiveTodoScopeProvider(() => ({ kind: "ferment-step", phaseId: "p", stepId: "s" }))
				: () => {}
		await h.work()
		await h.end(["error", "aborted", "length", "toolUse"].includes(reason) ? reason : "stop")
		unregister()
		expect(h.closure()).toHaveLength(0)
	})

	it.each(FERMENT_V2_STATUSES)("respects %s Ferment ownership", async (status) => {
		const h = await harness()
		const run = createFermentV2(undefined, "Earlier objective", "run", new Date().toISOString())
		h.manager.appendCustomEntry(FERMENT_V2_CUSTOM_ENTRY_TYPE, putFermentV2Entry({ ...run, status }))
		h.request()
		h.write([{ content: "Verify follow-up", status: TODO_STATUS.IN_PROGRESS }])
		await h.work()
		await h.end()
		expect(h.closure()).toHaveLength(status === FERMENT_V2_STATUS.COMPLETE ? 1 : 0)
	})
})
