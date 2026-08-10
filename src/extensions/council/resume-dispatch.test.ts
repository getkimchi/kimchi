import type { AssistantMessage, Usage } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"
import { dispatchResumedTransaction } from "./resume-dispatch.js"

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function message(name: string, arguments_: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: name, name, arguments: arguments_ }],
		api: "kimchi-council",
		provider: "kimchi",
		model: "council",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	}
}

describe("dispatchResumedTransaction", () => {
	it("re-emits the settle tool call instead of abandoning when settlement was emitted but not executed", async () => {
		const finish = vi.fn()
		const fail = vi.fn()
		const handled = await dispatchResumedTransaction({
			transaction: {
				state: "post_apply_checks",
				postApplyChecksComplete: true,
				postApplyChecksPassed: true,
				settlementDeliveryExhausted: false,
				settlementRequest: vi.fn(() => ({
					transactionId: "tx_1",
					patchSha256: "patch_1",
					action: "finalize" as const,
				})),
				abandon: vi.fn(),
			} as never,
			run: { throwIfAborted: vi.fn(), remainingMs: vi.fn() } as never,
			virtualModel: { provider: "kimchi", id: "council" } as never,
			aggregate: usage,
			finish,
			fail,
			internalToolUse: (_model, _usage, name, arguments_) => message(name, arguments_),
			publicResponseMessage: vi.fn(),
		})

		expect(handled).toBe(true)
		expect(fail).not.toHaveBeenCalled()
		expect(finish.mock.calls[0]?.[0].content[0]).toMatchObject({
			name: "settle_agent_patch",
			arguments: { transaction_id: "tx_1", patch_sha256: "patch_1", action: "finalize" },
		})
	})

	it("rolls back with a clear reason once the settlement re-emission bound is exhausted", async () => {
		const abandon = vi.fn()
		const fail = vi.fn()
		const handled = await dispatchResumedTransaction({
			transaction: {
				state: "post_apply_checks",
				postApplyChecksComplete: true,
				postApplyChecksPassed: true,
				settlementDeliveryExhausted: true,
				settlementRequest: vi.fn(() => undefined),
				abandon,
			} as never,
			run: { throwIfAborted: vi.fn(), remainingMs: vi.fn() } as never,
			virtualModel: { provider: "kimchi", id: "council" } as never,
			aggregate: usage,
			finish: vi.fn(),
			fail,
			internalToolUse: (_model, _usage, name, arguments_) => message(name, arguments_),
			publicResponseMessage: vi.fn(),
		})

		expect(handled).toBe(true)
		expect(abandon).toHaveBeenCalled()
		expect(fail).toHaveBeenCalledWith(
			expect.stringContaining("Council settlement could not be delivered after repeated attempts"),
		)
	})

	it("re-emits the apply tool call instead of abandoning when apply was emitted but not executed", async () => {
		const finish = vi.fn()
		const fail = vi.fn()
		const handled = await dispatchResumedTransaction({
			transaction: {
				state: "accepted",
				applyDeliveryExhausted: false,
				applyRequest: vi.fn(() => ({ transactionId: "tx_1", patchSha256: "patch_1" })),
				abandon: vi.fn(),
			} as never,
			run: { throwIfAborted: vi.fn(), remainingMs: vi.fn() } as never,
			virtualModel: { provider: "kimchi", id: "council" } as never,
			aggregate: usage,
			finish,
			fail,
			internalToolUse: (_model, _usage, name, arguments_) => message(name, arguments_),
			publicResponseMessage: vi.fn(),
		})

		expect(handled).toBe(true)
		expect(fail).not.toHaveBeenCalled()
		expect(finish.mock.calls[0]?.[0].content[0]).toMatchObject({
			name: "apply_agent_patch",
			arguments: { transaction_id: "tx_1", patch_sha256: "patch_1" },
		})
	})

	it("discards the transaction with a clear reason once the apply re-emission bound is exhausted", async () => {
		const abandon = vi.fn()
		const fail = vi.fn()
		const handled = await dispatchResumedTransaction({
			transaction: {
				state: "accepted",
				applyDeliveryExhausted: true,
				applyRequest: vi.fn(() => undefined),
				abandon,
			} as never,
			run: { throwIfAborted: vi.fn(), remainingMs: vi.fn() } as never,
			virtualModel: { provider: "kimchi", id: "council" } as never,
			aggregate: usage,
			finish: vi.fn(),
			fail,
			internalToolUse: (_model, _usage, name, arguments_) => message(name, arguments_),
			publicResponseMessage: vi.fn(),
		})

		expect(handled).toBe(true)
		expect(abandon).toHaveBeenCalled()
		expect(fail).toHaveBeenCalledWith(
			expect.stringContaining("Council apply could not be delivered after repeated attempts"),
		)
	})

	it("fails without retry when a resumed transaction is in the failed state", async () => {
		const abandon = vi.fn()
		const fail = vi.fn()
		const handled = await dispatchResumedTransaction({
			transaction: {
				state: "failed",
				abandon,
			} as never,
			run: { throwIfAborted: vi.fn(), remainingMs: vi.fn() } as never,
			virtualModel: { provider: "kimchi", id: "council" } as never,
			aggregate: usage,
			finish: vi.fn(),
			fail,
			internalToolUse: (_model, _usage, name, arguments_) => message(name, arguments_),
			publicResponseMessage: vi.fn(),
		})

		expect(handled).toBe(true)
		expect(abandon).toHaveBeenCalled()
		expect(fail).toHaveBeenCalledWith("Council did not apply the candidate patch.")
	})

	it("debug-logs failed post-apply preparation and still asks for rollback", async () => {
		const previousDebug = process.env.KIMCHI_COUNCIL_DEBUG
		process.env.KIMCHI_COUNCIL_DEBUG = "1"
		const debug = vi.spyOn(console, "error").mockImplementation(() => {})
		const finish = vi.fn()
		try {
			const handled = await dispatchResumedTransaction({
				transaction: {
					state: "post_apply_checks",
					postApplyChecksComplete: false,
					preparePostApplyCheck: vi.fn(async () => {
						throw new Error("snapshot failed")
					}),
					settlementRequest: vi.fn(() => ({
						transactionId: "tx_1",
						patchSha256: "patch_1",
						action: "rollback" as const,
					})),
				} as never,
				run: { throwIfAborted: vi.fn(), remainingMs: vi.fn() } as never,
				virtualModel: { provider: "kimchi", id: "council" } as never,
				aggregate: usage,
				finish,
				fail: vi.fn(),
				internalToolUse: (_model, _usage, name, arguments_) => message(name, arguments_),
				publicResponseMessage: vi.fn(),
			})

			expect(handled).toBe(true)
			expect(debug).toHaveBeenCalledWith(
				expect.stringContaining("preparePostApplyCheck failed while resuming transaction"),
				expect.any(Error),
			)
			expect(finish.mock.calls[0]?.[0].content[0]).toMatchObject({
				name: "settle_agent_patch",
				arguments: { transaction_id: "tx_1", patch_sha256: "patch_1", action: "rollback" },
			})
		} finally {
			if (previousDebug === undefined) delete process.env.KIMCHI_COUNCIL_DEBUG
			else process.env.KIMCHI_COUNCIL_DEBUG = previousDebug
			debug.mockRestore()
		}
	})
})
