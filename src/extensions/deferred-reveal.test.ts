// extensions/deferred-reveal.test.ts
//
// Deferred tool-group reveal semantics. upstream pi removed the
// `addedToolNames` in-band load marker (tool availability is now declared on
// system messages by the agent session itself), so this suite no longer
// covers stamping — only the reveal lifecycle:
//
//   - anchor tool_result reveals the group (errored results do not)
//   - revealOnce() is idempotent
//   - resetForSession re-hides the group (no leak across /new)
//   - agent workers never reveal (full visibility)

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { createDeferredReveal } from "./deferred-reveal.js"
import { createToolVisibility } from "./prompt-construction/tool-visibility.js"

type ToolResultFn = (
	event: { type: "tool_result"; toolName: string; toolCallId: string; isError: boolean },
	ctx: never,
) => unknown

const workerState = vi.hoisted(() => ({ isWorker: false }))
vi.mock("./agent-worker-context.js", () => ({
	isAgentWorker: () => workerState.isWorker,
}))

const TOOLS = ["tool_a", "tool_b"] as const

function createHarness(toolNames: readonly string[], opts?: { anchorToolName?: string; hideOnReset?: boolean }) {
	const { api, getHandlers, getActiveToolNames } = createExtensionApi()
	for (const name of toolNames) api.registerTool({ name } as never)
	const visibility = createToolVisibility(api)
	const reveal = createDeferredReveal(api, visibility, toolNames, opts)
	// Mimic session_start: the group starts hidden (workers stay visible).
	reveal.resetForSession()
	return {
		api,
		reveal,
		toolResult: (getHandlers("tool_result") as unknown as ToolResultFn[])[0] as ToolResultFn | undefined,
		getActiveToolNames,
	}
}

describe("deferred reveal — group lifecycle", () => {
	beforeEach(() => {
		workerState.isWorker = false
	})

	it("anchor tool_result reveals; error results do not", async () => {
		const { reveal, toolResult, getActiveToolNames } = createHarness(TOOLS, { anchorToolName: "anchor" })
		if (!toolResult) throw new Error("anchor tool_result handler not registered")

		expect(getActiveToolNames()).not.toContain("tool_a")

		await toolResult({ type: "tool_result", toolName: "anchor", toolCallId: "c1", isError: true }, {} as never)
		expect(getActiveToolNames()).not.toContain("tool_a")

		await toolResult({ type: "tool_result", toolName: "anchor", toolCallId: "c2", isError: false }, {} as never)
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))

		// Idempotent.
		reveal.revealOnce()
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))
	})

	it("revealOnce reveals the group once", () => {
		const { reveal, getActiveToolNames } = createHarness(TOOLS)
		reveal.revealOnce("call-x")
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))
		reveal.revealOnce("call-y")
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))
	})

	it("resetForSession re-hides the group; the next reveal works", () => {
		const { reveal, getActiveToolNames } = createHarness(TOOLS)
		reveal.revealOnce()
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))

		reveal.resetForSession()
		expect(getActiveToolNames()).not.toContain("tool_a")

		reveal.revealOnce()
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))
	})

	it("hideOnReset: false leaves the reveal flag reset without re-hiding", () => {
		const { reveal, getActiveToolNames } = createHarness(TOOLS, { hideOnReset: false })
		reveal.revealOnce()
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))
		reveal.resetForSession()
		// Caller casts its own vote — visibility is not touched on reset.
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))
	})

	it("agent workers start revealed and never re-hide on reset", () => {
		workerState.isWorker = true
		const { reveal, getActiveToolNames } = createHarness(TOOLS)
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))
		reveal.revealOnce()
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))
		reveal.resetForSession()
		expect(getActiveToolNames()).toEqual(expect.arrayContaining([...TOOLS]))
	})
})
