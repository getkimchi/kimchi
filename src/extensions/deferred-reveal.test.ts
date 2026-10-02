// extensions/deferred-reveal.test.ts
//
// In-band reveal caching (addedToolNames stamping): every reveal must stamp
// the triggering toolResult so providers with native deferred-tool loading
// (deferredToolsMode: "kimi") keep the revealed tools OUT of the wire
// `tools` array — the cacheable prefix never changes mid-session.
//
// Covers:
//   - anchor tool_result reveals AND stamps that result's toolCallId
//   - explicit revealOnce(toolCallId) stamps; revealOnce() without an id
//     reveals without a stamp (documented loss of the in-band load point)
//   - the stamp is consumed exactly once (retries carry nothing)
//   - the stamp is dropped for non-toolResult messages and unknown call ids
//   - resetForSession clears pending stamps (no leak across /new)
//   - agent workers never stamp (full visibility, no reveal)

import type { ToolResultMessage } from "@earendil-works/pi-ai"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { createDeferredReveal } from "./deferred-reveal.js"
import { createToolVisibility } from "./prompt-construction/tool-visibility.js"

type MessageEndFn = (event: { type: "message_end"; message: unknown }, ctx: never) => unknown
type ToolResultFn = (
	event: { type: "tool_result"; toolName: string; toolCallId: string; isError: boolean },
	ctx: never,
) => unknown

const workerState = vi.hoisted(() => ({ isWorker: false }))
vi.mock("./agent-worker-context.js", () => ({
	isAgentWorker: () => workerState.isWorker,
}))

const TOOLS = ["tool_a", "tool_b"] as const

function makeToolResult(toolCallId: string, toolName = "anchor"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		details: {},
		isError: false,
		timestamp: Date.now(),
	}
}

function createHarness(toolNames: readonly string[], opts?: { anchorToolName?: string; hideOnReset?: boolean }) {
	const { api, getHandler, getHandlers, getActiveToolNames } = createExtensionApi()
	for (const name of toolNames) api.registerTool({ name } as never)
	const visibility = createToolVisibility(api)
	const reveal = createDeferredReveal(api, visibility, toolNames, opts)
	// Mimic session_start: the group starts hidden (workers stay visible).
	reveal.resetForSession()
	return {
		api,
		reveal,
		messageEnd: getHandler("message_end") as MessageEndFn,
		toolResult: (getHandlers("tool_result") as unknown as ToolResultFn[])[0] as ToolResultFn | undefined,
		getActiveToolNames,
	}
}

async function stampResult(messageEnd: MessageEndFn, message: ToolResultMessage): Promise<ToolResultMessage> {
	const result = (await messageEnd({ type: "message_end", message }, {} as never)) as
		| { message: ToolResultMessage }
		| undefined
	return result?.message ?? message
}

describe("deferred reveal — in-band addedToolNames stamping", () => {
	beforeEach(() => {
		workerState.isWorker = false
	})

	it("anchor reveal stamps the anchor toolResult's own toolCallId", async () => {
		const { messageEnd, toolResult, getActiveToolNames } = createHarness(TOOLS, { anchorToolName: "anchor" })
		if (!toolResult) throw new Error("anchor tool_result handler not registered")

		await toolResult({ type: "tool_result", toolName: "anchor", toolCallId: "c1", isError: false }, {} as never)
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))

		const stamped = await stampResult(messageEnd, makeToolResult("c1"))
		expect(stamped.addedToolNames).toEqual([...TOOLS])

		// A LATER toolResult from a different call carries nothing.
		const other = await stampResult(messageEnd, makeToolResult("c2"))
		expect(other).not.toHaveProperty("addedToolNames")
	})

	it("revealOnce(toolCallId) stamps that call's result; revealOnce() without an id reveals without a stamp", async () => {
		const withId = createHarness(TOOLS)
		withId.reveal.revealOnce("call-x")
		expect((await stampResult(withId.messageEnd, makeToolResult("call-x"))).addedToolNames).toEqual([...TOOLS])

		const withoutId = createHarness(TOOLS)
		withoutId.reveal.revealOnce()
		expect(withoutId.getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))
		expect((await stampResult(withoutId.messageEnd, makeToolResult("call-y"))).addedToolNames).toBeUndefined()
	})

	it("consumes the stamp exactly once — a repeat message carries nothing", async () => {
		const { messageEnd, reveal } = createHarness(TOOLS)
		reveal.revealOnce("c1")

		expect((await stampResult(messageEnd, makeToolResult("c1"))).addedToolNames).toEqual([...TOOLS])
		expect((await stampResult(messageEnd, makeToolResult("c1"))).addedToolNames).toBeUndefined()
	})

	it("merges with addedToolNames the message already carries", async () => {
		const { messageEnd, reveal } = createHarness(TOOLS)
		reveal.revealOnce("c1")

		const message = { ...makeToolResult("c1"), addedToolNames: ["preexisting"] }
		expect((await stampResult(messageEnd, message)).addedToolNames).toEqual(["preexisting", ...TOOLS])
	})

	it("ignores non-toolResult messages and unstamped call ids", async () => {
		const { messageEnd, reveal } = createHarness(TOOLS)
		reveal.revealOnce("c1")

		const unrelated = await stampResult(messageEnd, makeToolResult("other-call"))
		expect(unrelated).not.toHaveProperty("addedToolNames")

		expect(
			await messageEnd(
				{
					type: "message_end",
					message: { role: "assistant", content: [], api: "anthropic-messages", provider: "x", model: "y", usage: {} },
				} as never,
				{} as never,
			),
		).toBeUndefined()
	})

	it("resetForSession drops pending stamps and re-hides the group", async () => {
		const { reveal, messageEnd, getActiveToolNames } = createHarness(TOOLS)
		reveal.revealOnce("c1")
		reveal.resetForSession()

		expect(getActiveToolNames()).not.toContain("tool_a")
		// The stale stamp from the previous session must not fire.
		expect((await stampResult(messageEnd, makeToolResult("c1"))).addedToolNames).toBeUndefined()
	})

	it("stamps are per-session after re-reveal in a new session", async () => {
		const { reveal, messageEnd } = createHarness(TOOLS)
		reveal.revealOnce("c1")
		reveal.resetForSession()

		reveal.revealOnce("c2")
		expect((await stampResult(messageEnd, makeToolResult("c2"))).addedToolNames).toEqual([...TOOLS])
	})

	it("agent workers reveal nothing and stamp nothing", async () => {
		workerState.isWorker = true
		const { reveal, messageEnd, getActiveToolNames } = createHarness(TOOLS)

		reveal.revealOnce("c1")
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))
		expect((await stampResult(messageEnd, makeToolResult("c1"))).addedToolNames).toBeUndefined()
	})

	it("errored anchor results neither reveal nor stamp", async () => {
		const { messageEnd, toolResult, getActiveToolNames } = createHarness(TOOLS, { anchorToolName: "anchor" })
		if (!toolResult) throw new Error("anchor tool_result handler not registered")

		await toolResult({ type: "tool_result", toolName: "anchor", toolCallId: "c1", isError: true }, {} as never)
		expect(getActiveToolNames()).not.toContain("tool_a")
		expect((await stampResult(messageEnd, makeToolResult("c1"))).addedToolNames).toBeUndefined()
	})
})
