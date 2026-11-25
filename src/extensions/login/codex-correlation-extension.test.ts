import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import codexCorrelationExtension from "./codex-correlation-extension.js"
import { codexRequestMetadata, resetCodexSession } from "./codex-request-context.js"

describe("codexCorrelationExtension", () => {
	it("updates metadata during successful and failed compactions, then clears it on shutdown", async () => {
		const { api, emit } = createExtensionApi()
		codexCorrelationExtension(api)
		const ctx = createContext()
		ctx.sessionManager.getSessionId = () => "s1"
		resetCodexSession("s1")
		const branch = (entries: Array<"compaction">) => {
			ctx.sessionManager.getBranch = () =>
				entries.map((_, index) => ({
					type: "compaction" as const,
					id: `compaction-${index}`,
					parentId: index === 0 ? null : `compaction-${index - 1}`,
					timestamp: new Date(index).toISOString(),
					summary: `Summary ${index}`,
					firstKeptEntryId: "entry-1",
					tokensBefore: 64 + index,
				}))
		}

		branch(["compaction"])
		await emit("before_agent_start", {}, ctx)
		expect(codexRequestMetadata("s1")).toMatchObject({ windowNumber: 1, requestKind: "turn" })
		await emit("session_before_compact", {}, ctx)
		expect(codexRequestMetadata("s1")).toMatchObject({ windowNumber: 1, requestKind: "compaction" })
		await emit("session_compact", {}, ctx)
		expect(codexRequestMetadata("s1")).toMatchObject({ windowNumber: 1, requestKind: "turn" })

		branch([])
		await emit("before_agent_start", {}, ctx)
		expect(codexRequestMetadata("s1")).toMatchObject({ windowNumber: 0, requestKind: "turn" })
		branch(["compaction"])
		await emit("before_agent_start", {}, ctx)
		await emit("session_before_compact", {}, ctx)
		expect(codexRequestMetadata("s1")).toMatchObject({ windowNumber: 1, requestKind: "compaction" })
		await emit("session_compact_failed", {}, ctx)
		expect(codexRequestMetadata("s1")).toMatchObject({ windowNumber: 1, requestKind: "turn" })
		await emit("session_shutdown", {}, ctx)
		expect(codexRequestMetadata("s1")).toMatchObject({ windowNumber: 0, requestKind: "turn" })
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
