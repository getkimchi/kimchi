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
	const request = () => manager.appendMessage({ role: "user", content: "Verify and compare inputs", timestamp: 1 })
	request()
	const write = (todos: TodoDraft[]) => {
		const details = applyWriteTodos({ todos }, manager.getSessionId())
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
		h.request()
		await h.work()
		await h.end()
		expect(h.closure()).toHaveLength(2)
	})

	it("does not revisit an unchanged deferred list on a new conversational request", async () => {
		const h = await harness()
		h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
		await h.work()
		h.request()
		await h.end("stop", "42")
		expect(h.closure()).toHaveLength(0)
	})

	it.each([...TODO_TOOL_NAMES, "write_todos"])("ignores %s when deciding whether task work happened", async (name) => {
		const h = await harness()
		h.write([{ content: "Future task", status: TODO_STATUS.PENDING }])
		await h.work(name)
		await h.end()
		expect(h.closure()).toHaveLength(0)
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
		for (let i = 0; i < 4; i++) await h.work()
		await h.end()
		h.manager.branch(fork)
		await h.fire("session_tree")
		h.request()
		for (let i = 0; i < 4; i++) await h.work()
		await h.end()
		expect(h.closure()).toHaveLength(2)
		expect(
			h.sendMessage.mock.calls.filter(([m]) => m.customType === TODO_STALENESS_CUSTOM_TYPE).map(([m]) => m.details),
		).toEqual([
			{ reason: "staleness", threshold: 4 },
			{ reason: "staleness", threshold: 4 },
		])
	})

	it("waits for the user when the final answer asks a question after work", async () => {
		const h = await harness()
		h.write([{ content: "Publish after approval", status: TODO_STATUS.PENDING }])
		await h.work()
		await h.end("stop", "Verification passed. Should I publish?")
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
		h.request()
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
		expect(reminders()).toEqual([4, 9, 17, 25].map((threshold) => ({ reason: "staleness", threshold })))
		expect(h.closure()).toHaveLength(1)
		h.write([{ content: "Long task", status: TODO_STATUS.IN_PROGRESS, note: "Progress recorded" }])
		for (let i = 0; i < 9; i++) await h.work("read")
		await h.end()
		expect(reminders()).toEqual([4, 9, 17, 25, 4, 9].map((threshold) => ({ reason: "staleness", threshold })))
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
