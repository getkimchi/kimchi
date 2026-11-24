import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import type { MessageLikeSessionEntry } from "../run-outcome.js"
import { classifyRunOutcome } from "../run-outcome.js"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { runAsAgentWorker } from "./agent-worker-context.js"
import { createRunOutcomeTracker } from "./run-outcome.js"

type AssistantMessage = Extract<Extract<SessionEntry, { type: "message" }>["message"], { role: "assistant" }>

function assistantEntry(id: string, text: string, stopReason: AssistantMessage["stopReason"] = "stop") {
	const message: AssistantMessage = {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	}
	const entry: MessageLikeSessionEntry = { type: "message", id, parentId: null, timestamp: "1", message }
	return entry
}

function setup(mode: ExtensionContext["mode"], branch: SessionEntry[] = [], sessionFile = "/tmp/s.jsonl") {
	const harness = createExtensionApi()
	const tracker = createRunOutcomeTracker()
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
const toolResult = (toolName: string, text: string, isError = true) => ({
	type: "tool_result",
	toolCallId: "c",
	toolName,
	input: {},
	content: [{ type: "text", text }],
	isError,
})

describe("createRunOutcomeTracker", () => {
	const savedSubagent = process.env.KIMCHI_SUBAGENT
	afterEach(() => {
		if (savedSubagent === undefined) delete process.env.KIMCHI_SUBAGENT
		else process.env.KIMCHI_SUBAGENT = savedSubagent
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
		await runAsAgentWorker(async () => {
			for (const e of [start, input, toolResult("write", "Denied by rule"), settled()]) {
				await harness.emit(e.type, e, ctx)
			}
		})
		expect(tracker.getSnapshot()).toMatchObject({ active: false, inputSeen: false, runSeen: false })
		expect(tracker.getSnapshot().deniedTool).toBeUndefined()
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

	it("does not classify an aborted agent_settled as no-result", async () => {
		const { harness, tracker, ctx } = setup("print", [assistantEntry("a", "")])
		await harness.emit("session_start", start, ctx)
		await harness.emit("agent_settled", settled(true), ctx)
		const snapshot = tracker.getSnapshot()
		expect(snapshot).toMatchObject({ runSeen: true, aborted: true })
		expect(classifyRunOutcome(snapshot, { messages: ["p"], fileArgs: [] })).toEqual({ kind: "ok" })
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

	it("records the latest denied or blocked tool name and reason", async () => {
		const { harness, tracker, ctx } = setup("print", [assistantEntry("secret-model-text", "model said this")])
		await harness.emit("session_start", start, ctx)
		await harness.emit("tool_result", toolResult("write", "Denied by rule Write(*)"), ctx)
		expect(tracker.getSnapshot().deniedTool).toEqual({ toolName: "write", reason: "Denied by rule Write(*)" })
		await harness.emit("tool_result", toolResult("bash", "Blocked: the session is in plan mode"), ctx)
		await harness.emit("tool_result", toolResult("read", "ENOENT: no such file"), ctx)
		await harness.emit("tool_result", toolResult("grep", "Denied but fine", false), ctx)
		await harness.emit("agent_settled", settled(), ctx)
		const snapshot = tracker.getSnapshot()
		expect(snapshot.deniedTool).toEqual({ toolName: "bash", reason: "Blocked: the session is in plan mode" })
		expect(JSON.stringify(snapshot.deniedTool)).not.toContain("model said this")
	})

	it("ignores an unrelated error that mentions denied and blocked in prose", async () => {
		const { harness, tracker, ctx } = setup("print")
		await harness.emit("session_start", start, ctx)
		await harness.emit(
			"tool_result",
			toolResult("bash", "curl: access denied by server; the port was blocked by a firewall"),
			ctx,
		)
		expect(tracker.getSnapshot().deniedTool).toBeUndefined()
	})

	it.each([
		["write", "Denied by rule Write(*) [user]"],
		["bash", "Blocked in yolo mode (hard-blocked command): rm -rf /"],
		["write", "Blocked: write inside the bundled skills directory is not allowed - it is the trust anchor."],
		["bash", "Blocked: the session is in plan mode (read-only). Do not retry writes."],
		["edit", "Blocked: the session is in plan mode (read-only) - tool edit is unavailable. Do not retry."],
		["bash", "Subcommand denied"],
		["bash", "Hard-blocked program in command: sudo ls"],
		["bash", "Command blocked by rule: ls && rm x"],
		["bash", "Subcommand blocked by rule: rm x"],
		["bash", "No UI to confirm permission"],
		["bash", "Classifier: looks risky (no UI to confirm)"],
	])("recognizes the permissions producer format for %s: %s", async (toolName, text) => {
		const { harness, tracker, ctx } = setup("print")
		await harness.emit("session_start", start, ctx)
		await harness.emit("tool_result", toolResult(toolName, text), ctx)
		expect(tracker.getSnapshot().deniedTool).toEqual({ toolName, reason: text })
	})

	it("returns defensive snapshots", async () => {
		const { harness, tracker, ctx } = setup("print")
		await harness.emit("session_start", start, ctx)
		await harness.emit("tool_result", toolResult("write", "Denied by rule Write(*)"), ctx)
		const snap = tracker.getSnapshot()
		snap.inputSeen = true
		if (snap.deniedTool) snap.deniedTool.reason = "mutated"
		expect(tracker.getSnapshot().inputSeen).toBe(false)
		expect(tracker.getSnapshot().deniedTool?.reason).toBe("Denied by rule Write(*)")
	})
})
