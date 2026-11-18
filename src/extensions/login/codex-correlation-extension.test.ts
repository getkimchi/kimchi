import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import codexCorrelationExtension from "./codex-correlation-extension.js"
import { codexRequestMetadata, resetCodexSession } from "./codex-request-context.js"

describe("codexCorrelationExtension", () => {
	it("registers Codex session handlers", () => {
		const on = vi.fn()
		codexCorrelationExtension({ on } as unknown as ExtensionAPI)
		const events = on.mock.calls.map(([event]) => event)
		for (const event of [
			"before_agent_start",
			"session_before_compact",
			"session_compact",
			"session_compact_failed",
			"session_shutdown",
		]) {
			expect(events).toContain(event)
		}
	})

	it("a turn's window number comes from the current branch", () => {
		const on = vi.fn()
		codexCorrelationExtension({ on } as unknown as ExtensionAPI)
		const beforeAgentStart = on.mock.calls.find(([event]) => event === "before_agent_start")?.[1]
		const ctxWith = (branch: { type: string }[]) => ({
			sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
		})
		resetCodexSession("s1")

		beforeAgentStart({}, ctxWith([{ type: "message" }, { type: "compaction" }, { type: "compaction" }]))
		expect(codexRequestMetadata("s1").windowNumber).toBe(2)

		beforeAgentStart({}, ctxWith([{ type: "compaction" }]))
		expect(codexRequestMetadata("s1").windowNumber).toBe(1)
		resetCodexSession("s1")
	})
})
