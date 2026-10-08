import type { MessageEndEvent } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import budgetCorrectionExtension from "./budget-correction-extension.js"
import {
	__getBudgetCorrectionStateForTests,
	__resetBudgetCorrectionStoreForTests,
	recordOutgoingBudget,
	scheduleCorrection,
} from "./budget-correction-store.js"

function messageEndEvent(message: Record<string, unknown>): MessageEndEvent {
	return { type: "message_end", message } as unknown as MessageEndEvent
}

beforeEach(() => {
	__resetBudgetCorrectionStoreForTests()
})

describe("budgetCorrectionExtension", () => {
	it("clears state when an assistant message ends non-error (success or abort)", () => {
		const { api, getHandler } = createExtensionApi()
		budgetCorrectionExtension(api)
		recordOutgoingBudget("test-session", "auto", 512_000, false)
		scheduleCorrection("test-session", "auto", 512_000, 262_144)

		const handler = getHandler<MessageEndEvent, unknown>("message_end")
		handler(messageEndEvent({ role: "assistant", stopReason: "stop" }), createContext())

		expect(__getBudgetCorrectionStateForTests("test-session")?.pending).toBeUndefined()
		expect(__getBudgetCorrectionStateForTests("test-session")?.lastOutgoing).toBeDefined()
	})

	it("keeps state across an errored assistant message (the rejection is being handled)", () => {
		const { api, getHandler } = createExtensionApi()
		budgetCorrectionExtension(api)
		recordOutgoingBudget("test-session", "auto", 512_000, false)
		scheduleCorrection("test-session", "auto", 512_000, 262_144)

		const handler = getHandler<MessageEndEvent, unknown>("message_end")
		handler(messageEndEvent({ role: "assistant", stopReason: "error", errorMessage: "400" }), createContext())

		expect(__getBudgetCorrectionStateForTests("test-session")?.pending).toBeDefined()
	})

	it("does not clear pending state at agent_end (a transient retry may follow)", () => {
		// Settlement is owned by the retry patch's _handlePostAgentRun wrapper,
		// which knows whether the turn continues. An agent_end handler fires
		// BETWEEN the runs of a retry chain — clearing there would discard a
		// mid-flight correction exactly when upstream retries the corrected
		// request after a transient failure. The extension therefore registers
		// no agent_end handler at all.
		const { api } = createExtensionApi()
		budgetCorrectionExtension(api)
		scheduleCorrection("test-session", "auto", 512_000, 262_144)

		expect(api.on).not.toHaveBeenCalledWith("agent_end", expect.anything())
		expect(__getBudgetCorrectionStateForTests("test-session")?.pending).toBeDefined()
	})

	it("clears everything at session_shutdown", () => {
		const { api, getHandler } = createExtensionApi()
		budgetCorrectionExtension(api)
		recordOutgoingBudget("test-session", "auto", 512_000, false)
		scheduleCorrection("test-session", "auto", 512_000, 262_144)

		const handler = getHandler<unknown, unknown>("session_shutdown")
		void handler({ type: "session_shutdown" }, createContext())

		expect(__getBudgetCorrectionStateForTests("test-session")).toBeUndefined()
	})
})
