import { describe, expect, it, vi } from "vitest"
import { createContext, sendTerminalInput } from "../__mocks__/context.js"
import { claimRawInputCapture } from "../shared-input.js"
import { watchEscalatedDialog, waitForEscalatedInput } from "./escalated-interaction.js"

const timing = { quietMs: 20, openingGuardMs: 40, pollMs: 5 }

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("escalated TUI input coordination", () => {
	it("preserves a draft and reports the wait once", async () => {
		let draft = "Continue the current draft"
		const ctx = createContext({ hasUI: true, mode: "tui", ui: { getEditorText: vi.fn(() => draft) } })
		const controller = new AbortController()
		const waiting = waitForEscalatedInput(ctx, () => Number.NEGATIVE_INFINITY, controller.signal, "Subagent waiting", timing)
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
		const waiting = waitForEscalatedInput(ctx, () => lastInputAt, controller.signal, "Subagent waiting", timing).then(() => {
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
			const waiting = waitForEscalatedInput(ctx, () => Number.NEGATIVE_INFINITY, controller.signal, "Subagent waiting", timing).then(() => {
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

	it("consumes an in-flight key at opening and withdraws for a raw-input dialog", async () => {
		const ctx = createContext({ hasUI: true, mode: "tui" })
		const controller = new AbortController()
		const stop = watchEscalatedDialog(ctx, controller, timing)
		const inputHandler = vi.mocked(ctx.ui.onTerminalInput).mock.calls[0]?.[0]
		expect(inputHandler).toBeDefined()
		expect(inputHandler!("2")).toEqual({ consume: true })
		await delay(50)
		expect(inputHandler!("2")).toBeUndefined()
		sendTerminalInput(ctx, "2")
		expect(controller.signal.aborted).toBe(false)
		const release = claimRawInputCapture()
		try {
			await vi.waitFor(() => expect(controller.signal.aborted).toBe(true))
			expect(ctx.ui.getEditorText()).toBe("")
		} finally {
			release()
			stop()
		}
	})

	it("aborts a selector immediately if a raw-input dialog already owns the keyboard", () => {
		const ctx = createContext({ hasUI: true, mode: "tui" })
		const controller = new AbortController()
		const release = claimRawInputCapture()
		try {
			const stop = watchEscalatedDialog(ctx, controller, timing)
			expect(controller.signal.aborted).toBe(true)
			stop()
		} finally {
			release()
		}
	})
})
