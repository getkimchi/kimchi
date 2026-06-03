import { describe, expect, it } from "vitest"
import { claimRawInputCapture, isRawInputCaptureActive } from "./shared-input.js"

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
})
