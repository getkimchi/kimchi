import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { classifyRunOutcome } from "../run-outcome.js"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { type AssistantMessage, createAssistantEntry } from "./__mocks__/session-entries.js"
import { runAsAgentWorker } from "./agent-worker-context.js"
import { createRunOutcomeTracker } from "./run-outcome.js"

function assistantEntry(id: string, text: string, stopReason: AssistantMessage["stopReason"] = "stop") {
	return createAssistantEntry(text ? [{ type: "text", text }] : [], { id, stopReason })
}

function setup(mode: ExtensionContext["mode"], branch: SessionEntry[] = [], sessionFile = "/tmp/s.jsonl") {
	const harness = createExtensionApi()
	const tracker = createRunOutcomeTracker()
	tracker.earlyObserver(harness.api)
	tracker.extension(harness.api)
	let current = branch
	const ctx = createContext({
		mode,
		sessionManager: { getBranch: () => current, getSessionFile: () => sessionFile },
	})
	return {
		harness,
		tracker,
		ctx,
		setBranch: (b: SessionEntry[]) => {
			current = b
		},
	}
}

const start = { type: "session_start", reason: "startup" }
const input = { type: "input", text: "hi", source: "interactive" }
const settled = (aborted = false) => ({ type: "agent_settled", aborted })
const toolCall = (toolCallId: string, toolName: string) => ({ type: "tool_call", toolCallId, toolName, input: {} })
const toolResultEvent = (toolCallId: string, toolName: string) => ({
	type: "tool_result",
	toolCallId,
	toolName,
	input: {},
	content: [],
	details: undefined,
	isError: true,
})
const executionEnd = (toolCallId: string, toolName: string, text: string, isError = true) => ({
	type: "tool_execution_end",
	toolCallId,
	toolName,
	result: { content: [{ type: "text", text }], details: {} },
	isError,
})

type Harness = ReturnType<typeof setup>["harness"]

/** pi emits `tool_call`, then (only when the call ran) `tool_result`, then `tool_execution_end`. */
async function blockedCall(harness: Harness, ctx: ExtensionContext, id: string, toolName: string, reason: string) {
	await harness.emit("tool_call", toolCall(id, toolName), ctx)
	await harness.emit("tool_execution_end", executionEnd(id, toolName, reason), ctx)
}

async function failedCall(harness: Harness, ctx: ExtensionContext, id: string, toolName: string, error: string) {
	await harness.emit("tool_call", toolCall(id, toolName), ctx)
	await harness.emit("tool_result", toolResultEvent(id, toolName), ctx)
	await harness.emit("tool_execution_end", executionEnd(id, toolName, error), ctx)
}

describe("createRunOutcomeTracker", () => {
	const savedSubagent = process.env.KIMCHI_SUBAGENT
	afterEach(() => {
		if (savedSubagent === undefined) delete process.env.KIMCHI_SUBAGENT
		else process.env.KIMCHI_SUBAGENT = savedSubagent
	})

	it("observes input and tool_call only from the early observer, which cli.ts registers first", () => {
		const early = createExtensionApi()
		const late = createExtensionApi()
		const tracker = createRunOutcomeTracker()
		tracker.earlyObserver(early.api)
		tracker.extension(late.api)
		expect(early.getHandlers("input")).toHaveLength(1)
		expect(early.getHandlers("tool_call")).toHaveLength(1)
		expect(late.getHandlers("input")).toHaveLength(0)
		expect(late.getHandlers("tool_call")).toHaveLength(0)
		expect(late.getHandlers("agent_settled")).toHaveLength(1)
	})

	it("does not record a TUI session", async () => {
		const { harness, tracker, ctx } = setup("tui", [assistantEntry("a", "x")])
		for (const e of [start, input, settled()]) await harness.emit(e.type, e, ctx)
		expect(tracker.getSnapshot()).toMatchObject({ active: false, inputSeen: false, runSeen: false })
	})

	it("does not record an RPC ACP session", async () => {
		const { harness, tracker, ctx } = setup("rpc", [assistantEntry("a", "x")])
		for (const e of [start, input, settled()]) await harness.emit(e.type, e, ctx)
		expect(tracker.getSnapshot()).toMatchObject({ active: false, inputSeen: false, runSeen: false })
	})

	it("ignores events inside runAsAgentWorker", async () => {
		const { harness, tracker, ctx } = setup("print", [assistantEntry("a", "x")])
		await harness.emit("session_start", start, ctx)
		await runAsAgentWorker(async () => {
			await harness.emit("input", input, ctx)
			await blockedCall(harness, ctx, "c", "write", "Denied by rule")
			await harness.emit("agent_settled", settled(), ctx)
		})
		expect(tracker.getSnapshot()).toMatchObject({ active: true, inputSeen: false, runSeen: false })
		expect(tracker.getSnapshot().blockedTool).toBeUndefined()
	})

	it("reports promptSeen after notePrompt in print mode", async () => {
		const { harness, tracker, ctx } = setup("print")
		await harness.emit("session_start", start, ctx)

		tracker.notePrompt()

		expect(tracker.getSnapshot().promptSeen).toBe(true)
	})

	it("notes a prompt even when its text is whitespace", async () => {
		const { harness, tracker, ctx } = setup("print")
		await harness.emit("session_start", start, ctx)

		tracker.notePrompt()

		expect(classifyRunOutcome(tracker.getSnapshot())).not.toEqual({ kind: "no-prompt" })
	})

	it("ignores prompts from agent workers", async () => {
		const { harness, tracker, ctx } = setup("print")
		await harness.emit("session_start", start, ctx)

		await runAsAgentWorker(async () => {
			tracker.notePrompt()
		})

		expect(tracker.getSnapshot().promptSeen).toBe(false)
		expect(classifyRunOutcome(tracker.getSnapshot())).toEqual({ kind: "no-prompt" })
	})

	it("ignores events when KIMCHI_SUBAGENT is set", async () => {
		process.env.KIMCHI_SUBAGENT = "1"
		for (const mode of ["print", "json"] as const) {
			const { harness, tracker, ctx } = setup(mode, [assistantEntry("a", "x")])
			for (const e of [start, input, settled()]) await harness.emit(e.type, e, ctx)
			expect(tracker.getSnapshot()).toMatchObject({ active: false, inputSeen: false, runSeen: false })
		}
	})

	it.each(["print", "json"] as const)("records a %s outcome on agent_settled", async (mode) => {
		const final = assistantEntry("a", "answer")
		const { harness, tracker, ctx } = setup(mode, [final], "/tmp/x.jsonl")
		await harness.emit("session_start", start, ctx)
		expect(tracker.getSnapshot()).toMatchObject({ active: true, runSeen: false })
		await harness.emit("input", input, ctx)
		await harness.emit("agent_settled", settled(), ctx)
		expect(tracker.getSnapshot()).toMatchObject({
			active: true,
			inputSeen: true,
			runSeen: true,
			aborted: false,
			finalEntry: final,
			sessionPath: "/tmp/x.jsonl",
		})
	})

	it("records input that never reaches a run", async () => {
		const { harness, tracker, ctx } = setup("print")
		await harness.emit("session_start", start, ctx)
		await harness.emit("input", input, ctx)
		expect(tracker.getSnapshot()).toMatchObject({ inputSeen: true, runSeen: false })
		tracker.notePrompt()
		expect(classifyRunOutcome(tracker.getSnapshot())).toMatchObject({
			kind: "no-result",
			lastEvent: { kind: "input-handled" },
		})
	})

	it("does not classify an aborted agent_settled as no-result", async () => {
		const { harness, tracker, ctx } = setup("print", [assistantEntry("a", "")])
		await harness.emit("session_start", start, ctx)
		await harness.emit("agent_settled", settled(true), ctx)
		tracker.notePrompt()
		const snapshot = tracker.getSnapshot()
		expect(snapshot).toMatchObject({ runSeen: true, aborted: true })
		expect(classifyRunOutcome(snapshot)).toEqual({ kind: "ok" })
	})

	it("does not let a subagent session overwrite the top-level outcome", async () => {
		const top = assistantEntry("top", "answer")
		const { harness, tracker, ctx } = setup("print", [top], "/tmp/top.jsonl")
		await harness.emit("session_start", start, ctx)
		await harness.emit("agent_settled", settled(), ctx)
		const before = tracker.getSnapshot()
		const workerCtx = createContext({
			mode: "print",
			sessionManager: { getBranch: () => [assistantEntry("sub", "")], getSessionFile: () => "/tmp/sub.jsonl" },
		})
		await runAsAgentWorker(async () => {
			await harness.emit("agent_settled", settled(true), workerCtx)
		})
		expect(tracker.getSnapshot()).toEqual(before)
		expect(tracker.getSnapshot().finalEntry).toBe(top)
	})

	it("uses only the latest settled outcome for multiple prompts", async () => {
		const first = assistantEntry("a", "real answer")
		const second = assistantEntry("b", "")
		const { harness, tracker, ctx, setBranch } = setup("print", [first], "/tmp/one.jsonl")
		await harness.emit("session_start", start, ctx)
		await harness.emit("input", input, ctx)
		await harness.emit("agent_settled", settled(), ctx)
		const ctx2 = createContext({
			mode: "print",
			sessionManager: { getBranch: () => [first, second], getSessionFile: () => "/tmp/two.jsonl" },
		})
		setBranch([first, second])
		await harness.emit("agent_settled", settled(), ctx2)
		const snapshot = tracker.getSnapshot()
		expect(snapshot.finalEntry).toBe(second)
		expect(snapshot.sessionPath).toBe("/tmp/two.jsonl")
		expect(snapshot.inputSeen).toBe(true)
	})

	describe("blocked tool calls", () => {
		it.each([
			["write", "Denied by rule Write(*) [user]"],
			["bash", "Classifier: no model available for classifier"],
			["write", "write is disabled in Kimchi resources. Enable tool:write from /resources."],
			["bash", "Permission mode changed too many times during prompt"],
			["edit", "Plan persona: edits are not allowed"],
		])("records a block from any producer for %s: %s", async (toolName, reason) => {
			const { harness, tracker, ctx } = setup("print")
			await harness.emit("session_start", start, ctx)
			await blockedCall(harness, ctx, "c1", toolName, reason)
			expect(tracker.getSnapshot().blockedTool).toEqual({ toolName, reason })
		})

		it("ignores a tool that ran and failed, even when its error mentions denied or blocked", async () => {
			const { harness, tracker, ctx } = setup("print")
			await harness.emit("session_start", start, ctx)
			await failedCall(harness, ctx, "c1", "bash", "Denied by rule: curl got access denied, port blocked")
			expect(tracker.getSnapshot().blockedTool).toBeUndefined()
		})

		it("ignores an error that never had a tool_call, such as an unknown tool", async () => {
			const { harness, tracker, ctx } = setup("print")
			await harness.emit("session_start", start, ctx)
			await harness.emit("tool_execution_end", executionEnd("c1", "nope", "Tool nope not found"), ctx)
			expect(tracker.getSnapshot().blockedTool).toBeUndefined()
		})

		it("records the latest block and never copies model text", async () => {
			const { harness, tracker, ctx } = setup("print", [assistantEntry("secret-model-text", "model said this")])
			await harness.emit("session_start", start, ctx)
			await blockedCall(harness, ctx, "c1", "write", "Denied by rule Write(*)")
			await blockedCall(harness, ctx, "c2", "bash", "Blocked: the session is in plan mode")
			await failedCall(harness, ctx, "c3", "read", "ENOENT: no such file")
			await harness.emit("agent_settled", settled(), ctx)
			const snapshot = tracker.getSnapshot()
			expect(snapshot.blockedTool).toEqual({ toolName: "bash", reason: "Blocked: the session is in plan mode" })
			expect(JSON.stringify(snapshot.blockedTool)).not.toContain("model said this")
		})

		it("does not report a block from an earlier prompt for a later prompt", async () => {
			const first = assistantEntry("a", "")
			const second = assistantEntry("b", "")
			const { harness, tracker, ctx, setBranch } = setup("print", [first])
			await harness.emit("session_start", start, ctx)
			await harness.emit("input", input, ctx)
			await blockedCall(harness, ctx, "c1", "write", "Denied by rule Write(*)")
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().blockedTool).toEqual({ toolName: "write", reason: "Denied by rule Write(*)" })

			setBranch([first, second])
			await harness.emit("input", input, ctx)
			expect(tracker.getSnapshot().blockedTool).toBeUndefined()
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().blockedTool).toBeUndefined()
		})

		it("still records a block that arrives after the second prompt input", async () => {
			const { harness, tracker, ctx } = setup("print", [assistantEntry("a", "")])
			await harness.emit("session_start", start, ctx)
			await harness.emit("input", input, ctx)
			await blockedCall(harness, ctx, "c1", "write", "Denied by rule Write(*)")
			await harness.emit("input", input, ctx)
			await blockedCall(harness, ctx, "c2", "bash", "Blocked: plan mode")
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().blockedTool).toEqual({ toolName: "bash", reason: "Blocked: plan mode" })
		})
	})

	describe("Ferment V2 ownership", () => {
		const journal = (id: string, data: unknown): SessionEntry => ({
			type: "custom",
			id,
			parentId: null,
			timestamp: "1",
			customType: "kimchi_ferment_v2_state",
			data,
		})
		const put = journal("j1", { schemaVersion: 1, op: "put", fermentV2: { status: "completed" } })
		const laterPut = journal("j3", { schemaVersion: 1, op: "put", fermentV2: { status: "completed" } })
		const clear = journal("j2", { schemaVersion: 1, op: "clear", fermentV2Id: "f", revision: 1, clearedAt: "1" })

		it("marks a run during which Ferment V2 wrote a live put record", async () => {
			const { harness, tracker, ctx, setBranch } = setup("print")
			await harness.emit("session_start", start, ctx)
			setBranch([put, assistantEntry("a", "")])
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().fermentV2Owned).toBe(true)
		})

		it("does not mark a follow-up prompt on a resumed session with a live record from an earlier process", async () => {
			const { harness, tracker, ctx, setBranch } = setup("print", [put])
			await harness.emit("session_start", start, ctx)
			setBranch([put, assistantEntry("a", "")])
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().fermentV2Owned).toBeUndefined()
		})

		it("marks a resumed session once Ferment V2 writes a new put record", async () => {
			const { harness, tracker, ctx, setBranch } = setup("print", [put])
			await harness.emit("session_start", start, ctx)
			setBranch([put, laterPut, assistantEntry("a", "")])
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().fermentV2Owned).toBe(true)
		})

		it("does not mark a later prompt in the same process when Ferment V2 wrote nothing during it", async () => {
			const { harness, tracker, ctx, setBranch } = setup("print")
			await harness.emit("session_start", start, ctx)
			await harness.emit("input", input, ctx)
			setBranch([put, assistantEntry("a", "")])
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().fermentV2Owned).toBe(true)

			await harness.emit("input", input, ctx)
			setBranch([put, assistantEntry("a", ""), assistantEntry("b", "")])
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().fermentV2Owned).toBeUndefined()
		})

		it("marks a later prompt in the same process when Ferment V2 writes a new put record during it", async () => {
			const { harness, tracker, ctx, setBranch } = setup("print")
			await harness.emit("session_start", start, ctx)
			await harness.emit("input", input, ctx)
			setBranch([put, assistantEntry("a", "")])
			await harness.emit("agent_settled", settled(), ctx)

			await harness.emit("input", input, ctx)
			setBranch([put, assistantEntry("a", ""), laterPut, assistantEntry("b", "")])
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().fermentV2Owned).toBe(true)
		})

		it("keeps the mark for Ferment V2 continuation runs, which emit no input", async () => {
			const { harness, tracker, ctx, setBranch } = setup("print")
			await harness.emit("session_start", start, ctx)
			await harness.emit("input", input, ctx)
			setBranch([put, assistantEntry("a", "")])
			await harness.emit("agent_settled", settled(), ctx)

			setBranch([put, assistantEntry("a", ""), assistantEntry("b", "")])
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().fermentV2Owned).toBe(true)
		})

		it("does not mark a run whose latest Ferment V2 record is a clear", async () => {
			const { harness, tracker, ctx, setBranch } = setup("print")
			await harness.emit("session_start", start, ctx)
			setBranch([put, clear, assistantEntry("a", "")])
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().fermentV2Owned).toBeUndefined()
		})

		it("does not mark an ordinary run", async () => {
			const { harness, tracker, ctx } = setup("print", [assistantEntry("a", "")])
			await harness.emit("session_start", start, ctx)
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().fermentV2Owned).toBeUndefined()
		})

		it("drops the mark when a later settlement no longer has a live record", async () => {
			const { harness, tracker, ctx, setBranch } = setup("print")
			await harness.emit("session_start", start, ctx)
			setBranch([put, assistantEntry("a", "")])
			await harness.emit("agent_settled", settled(), ctx)
			setBranch([put, clear, assistantEntry("b", "")])
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().fermentV2Owned).toBeUndefined()
		})

		it("ignores malformed journal data", async () => {
			const { harness, tracker, ctx, setBranch } = setup("print")
			await harness.emit("session_start", start, ctx)
			setBranch([journal("j", "nope"), assistantEntry("a", "")])
			await harness.emit("agent_settled", settled(), ctx)
			expect(tracker.getSnapshot().fermentV2Owned).toBeUndefined()
		})

		it("never marks a worker settlement", async () => {
			const { harness, tracker, ctx, setBranch } = setup("print")
			await harness.emit("session_start", start, ctx)
			setBranch([put])
			await runAsAgentWorker(async () => {
				await harness.emit("agent_settled", settled(), ctx)
			})
			expect(tracker.getSnapshot().fermentV2Owned).toBeUndefined()
		})
	})

	it("returns defensive snapshots", async () => {
		const { harness, tracker, ctx } = setup("print")
		await harness.emit("session_start", start, ctx)
		await blockedCall(harness, ctx, "c1", "write", "Denied by rule Write(*)")
		const snap = tracker.getSnapshot()
		snap.inputSeen = true
		if (snap.blockedTool) snap.blockedTool.reason = "mutated"
		expect(tracker.getSnapshot().inputSeen).toBe(false)
		expect(tracker.getSnapshot().blockedTool?.reason).toBe("Denied by rule Write(*)")
	})
})
