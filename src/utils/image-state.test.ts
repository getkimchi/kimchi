import { describe, expect, it } from "vitest"
import { clearCurrentTurnImages, getCurrentTurnImages, setCurrentTurnImages } from "./image-state.js"

describe("image-state", () => {
	it("returns empty array by default", () => {
		expect(getCurrentTurnImages()).toEqual([])
	})

	it("stores and retrieves images", () => {
		const images = [{ type: "image" as const, mimeType: "image/png", data: "abc123" }]
		setCurrentTurnImages(images)
		expect(getCurrentTurnImages()).toHaveLength(1)
		expect(getCurrentTurnImages()[0]?.mimeType).toBe("image/png")
	})

	it("clears images", () => {
		setCurrentTurnImages([{ type: "image", mimeType: "image/png", data: "abc" }])
		clearCurrentTurnImages()
		expect(getCurrentTurnImages()).toEqual([])
	})

	it("overwrites previous images on set", () => {
		setCurrentTurnImages([{ type: "image", mimeType: "image/png", data: "old" }])
		setCurrentTurnImages([{ type: "image", mimeType: "image/webp", data: "new" }])
		expect(getCurrentTurnImages()).toHaveLength(1)
		expect(getCurrentTurnImages()[0]?.mimeType).toBe("image/webp")
	})
})
