import { describe, expect, it, vi } from "vitest"
import { promptForApproval, truncate } from "./prompts.js"

describe("truncate helper", () => {
	it("returns original string if under max length", () => {
		expect(truncate("short", 10)).toBe("short")
	})

	it("truncates strings exceeding max length", () => {
		expect(truncate("hello world", 5)).toBe("hell…")
	})

	it("handles exact length strings", () => {
		expect(truncate("hello", 5)).toBe("hello")
	})
})

describe("promptForApproval — withWorkingHidden", () => {
	function fakeCtx() {
		return {
			hasUI: true,
			ui: {
				select: vi.fn(async () => "Yes — just this call"),
				input: vi.fn(),
				setWorkingVisible: vi.fn(),
			},
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for test
		} as any
	}

	it("hides working indicator before select and shows it after", async () => {
		const ctx = fakeCtx()
		await promptForApproval({ toolName: "bash", input: { command: "echo hello" }, ctx })

		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(1, false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(2, true)
		// Should be called exactly twice: hide before, show after
		expect(ctx.ui.setWorkingVisible).toHaveBeenCalledTimes(2)
	})

	it("shows working indicator even if select throws", async () => {
		const ctx = fakeCtx()
		ctx.ui.select = vi.fn(async () => {
			throw new Error("select failed")
		})
		await expect(promptForApproval({ toolName: "bash", input: { command: "echo hello" }, ctx })).rejects.toThrow(
			"select failed",
		)

		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(1, false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(2, true)
	})

	it("hides working indicator before feedback input and shows it after", async () => {
		const ctx = fakeCtx()
		ctx.ui.select = vi.fn(async () => "No — tell the assistant what to do differently")
		ctx.ui.input = vi.fn(async () => "Changed my mind")

		const result = await promptForApproval({ toolName: "bash", input: { command: "echo hello" }, ctx })

		expect(result).toEqual({ kind: "deny-with-feedback", feedback: "Changed my mind" })
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(1, false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(2, true)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(3, false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenNthCalledWith(4, true)
	})
})
