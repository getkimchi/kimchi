import { describe, expect, it, vi } from "vitest"
import { createContext, sendTerminalInput } from "../__mocks__/context.js"
import { claimRawInputCapture, isRawInputCaptureActive } from "../shared-input.js"
import { waitForEscalatedInput, watchEscalatedDialog } from "./escalated-interaction.js"

const timing = { quietMs: 20, openingGuardMs: 40, pollMs: 5 }
const noOtherDialogs = () => false

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("escalated TUI input coordination", () => {
	it("preserves a draft and reports the wait once", async () => {
		let draft = "Continue the current draft"
		const ctx = createContext({ hasUI: true, mode: "tui", ui: { getEditorText: vi.fn(() => draft) } })
		const controller = new AbortController()
		const waiting = waitForEscalatedInput(
			ctx,
			() => Number.NEGATIVE_INFINITY,
			controller.signal,
			"Subagent waiting",
			noOtherDialogs,
			timing,
		)
		await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalledOnce())
		expect(ctx.ui.getEditorText()).toBe("Continue the current draft")
		expect(ctx.ui.select).not.toHaveBeenCalled()
		draft = ""
		await waiting
		expect(ctx.ui.notify).toHaveBeenCalledOnce()
	})

	it("waits for recent input to become quiet without changing the editor", async () => {
		const ctx = createContext({ hasUI: true, mode: "tui" })
		const controller = new AbortController()
		let lastInputAt = Date.now()
		let settled = false
		const waiting = waitForEscalatedInput(
			ctx,
			() => lastInputAt,
			controller.signal,
			"Subagent waiting",
			noOtherDialogs,
			timing,
		).then(() => {
			settled = true
		})
		await delay(8)
		expect(settled).toBe(false)
		lastInputAt = Date.now() - timing.quietMs
		await waiting
		expect(settled).toBe(true)
	})

	it("waits for a raw-input dialog instead of replacing it", async () => {
		const ctx = createContext({ hasUI: true, mode: "tui" })
		const controller = new AbortController()
		const release = claimRawInputCapture()
		try {
			let settled = false
			const waiting = waitForEscalatedInput(
				ctx,
				() => Number.NEGATIVE_INFINITY,
				controller.signal,
				"Subagent waiting",
				noOtherDialogs,
				timing,
			).then(() => {
				settled = true
			})
			await delay(12)
			expect(settled).toBe(false)
			expect(ctx.ui.notify).toHaveBeenCalledOnce()
			release()
			await waiting
			expect(settled).toBe(true)
		} finally {
			release()
		}
	})

	it("consumes an in-flight key and withdraws without aborting the selector", async () => {
		const ctx = createContext({ hasUI: true, mode: "tui" })
		const controller = new AbortController()
		const withdraw = vi.fn()
		const stop = watchEscalatedDialog(ctx, withdraw, isRawInputCaptureActive, controller.signal, timing)
		const inputHandler = vi.mocked(ctx.ui.onTerminalInput).mock.calls[0]?.[0]
		if (!inputHandler) throw new Error("expected an input guard listener")
		expect(inputHandler("2")).toEqual({ consume: true })
		await delay(50)
		expect(inputHandler("2")).toBeUndefined()
		sendTerminalInput(ctx, "2")
		expect(withdraw).not.toHaveBeenCalled()
		const release = claimRawInputCapture()
		try {
			await vi.waitFor(() => expect(withdraw).toHaveBeenCalledOnce())
			expect(controller.signal.aborted).toBe(false)
		} finally {
			release()
			stop()
		}
	})

	it("withdraws immediately when a raw-input dialog already owns the keyboard, without aborting", () => {
		const ctx = createContext({ hasUI: true, mode: "tui" })
		const controller = new AbortController()
		const withdraw = vi.fn()
		const release = claimRawInputCapture()
		try {
			const stop = watchEscalatedDialog(ctx, withdraw, isRawInputCaptureActive, controller.signal, timing)
			expect(withdraw).toHaveBeenCalledOnce()
			expect(controller.signal.aborted).toBe(false)
			stop()
		} finally {
			release()
		}
	})

	it("waits for an agent-driven blocked dialog", async () => {
		const ctx = createContext({ hasUI: true, mode: "tui" })
		const controller = new AbortController()
		let dialogActive = true
		let settled = false
		const waiting = waitForEscalatedInput(
			ctx,
			() => Number.NEGATIVE_INFINITY,
			controller.signal,
			"Subagent waiting",
			() => dialogActive,
			timing,
		).then(() => {
			settled = true
		})
		await delay(12)
		expect(settled).toBe(false)
		expect(ctx.ui.notify).toHaveBeenCalledOnce()
		dialogActive = false
		await waiting
		expect(settled).toBe(true)
	})

	it("does not guard the opening keys of a text box", async () => {
		// The feedback text box is watched with a guard time of zero: the keys
		// that arrive right after it opens are the user's typing.
		const ctx = createContext({ hasUI: true, mode: "tui" })
		const withdraw = vi.fn()
		let dialogActive = false
		const stop = watchEscalatedDialog(ctx, withdraw, () => dialogActive, undefined, { ...timing, openingGuardMs: 0 })
		try {
			expect(ctx.ui.onTerminalInput).not.toHaveBeenCalled()
			dialogActive = true
			await vi.waitFor(() => expect(withdraw).toHaveBeenCalledOnce())
		} finally {
			stop()
		}
	})

	it("uses a 500 ms opening guard", () => {
		const ctx = createContext({ hasUI: true, mode: "tui" })
		let now = 0
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
		const stop = watchEscalatedDialog(ctx, () => {}, noOtherDialogs)
		try {
			const handler = vi.mocked(ctx.ui.onTerminalInput).mock.calls[0]?.[0]
			if (!handler) throw new Error("expected an input guard listener")
			now = 499
			expect(handler("2")).toEqual({ consume: true })
			now = 500
			expect(handler("2")).toBeUndefined()
		} finally {
			stop()
			clock.mockRestore()
		}
	})
})
