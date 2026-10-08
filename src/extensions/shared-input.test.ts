import { describe, expect, it } from "vitest"
import { claimRawInputCapture, isRawInputCaptureActive, withRawInputCapture } from "./shared-input.js"

describe("shared-input", () => {
	it("is inactive when no claim is held", () => {
		expect(isRawInputCaptureActive()).toBe(false)
	})

	it("activates while a claim is held and clears on release", () => {
		const release = claimRawInputCapture()
		expect(isRawInputCaptureActive()).toBe(true)
		release()
		expect(isRawInputCaptureActive()).toBe(false)
	})

	it("supports nested claims via refcount, releasing twice is a no-op", () => {
		const releaseA = claimRawInputCapture()
		const releaseB = claimRawInputCapture()
		expect(isRawInputCaptureActive()).toBe(true)
		releaseA()
		expect(isRawInputCaptureActive()).toBe(true)
		releaseA()
		expect(isRawInputCaptureActive()).toBe(true)
		releaseB()
		expect(isRawInputCaptureActive()).toBe(false)
	})

	describe("withRawInputCapture", () => {
		it("holds the claim for the duration of the async operation and releases after", async () => {
			let seenDuring: boolean | undefined
			const result = await withRawInputCapture(async () => {
				seenDuring = isRawInputCaptureActive()
				return 42
			})
			expect(seenDuring).toBe(true)
			expect(result).toBe(42)
			expect(isRawInputCaptureActive()).toBe(false)
		})

		it("releases the claim when the operation throws", async () => {
			await expect(
				withRawInputCapture(async () => {
					throw new Error("boom")
				}),
			).rejects.toThrow("boom")
			expect(isRawInputCaptureActive()).toBe(false)
		})
	})
})
