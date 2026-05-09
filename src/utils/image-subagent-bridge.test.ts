import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { writeImagesForSubagent } from "./image-subagent-bridge.js"

describe("writeImagesForSubagent", () => {
	it("returns empty result for empty input", () => {
		const result = writeImagesForSubagent([])
		expect(result.paths).toEqual([])
		expect(result.prefix).toBe("")
		expect(() => result.cleanup()).not.toThrow()
	})

	it("writes base64 image bytes to tmp files with correct extensions", () => {
		const images = [
			{ type: "image" as const, mimeType: "image/png", data: Buffer.from("PNG").toString("base64") },
			{ type: "image" as const, mimeType: "image/jpeg", data: Buffer.from("JPEG").toString("base64") },
		]
		const { paths, cleanup } = writeImagesForSubagent(images)
		try {
			expect(paths).toHaveLength(2)
			expect(paths[0]?.endsWith(".png")).toBe(true)
			expect(paths[1]?.endsWith(".jpg")).toBe(true)
			expect(existsSync(paths[0] ?? "")).toBe(true)
			expect(existsSync(paths[1] ?? "")).toBe(true)
		} finally {
			cleanup()
		}
		for (const p of paths) {
			expect(existsSync(p)).toBe(false)
		}
	})

	it("uses .bin for unknown mime types", () => {
		const images = [{ type: "image" as const, mimeType: "image/svg+xml", data: Buffer.from("<svg").toString("base64") }]
		const { paths, cleanup } = writeImagesForSubagent(images)
		try {
			expect(paths[0]?.endsWith(".bin")).toBe(true)
		} finally {
			cleanup()
		}
	})
})
