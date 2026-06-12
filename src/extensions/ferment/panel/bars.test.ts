import type { Theme } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { phaseBarTone, segBar } from "./bars.js"

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme

describe("segBar", () => {
	it("renders fixed-width segmented progress", () => {
		expect(segBar(2, 4, 8, theme)).toBe("■■■■□□□□")
	})

	it("maps terminal phase states to tones", () => {
		expect(phaseBarTone("completed")).toBe("done")
		expect(phaseBarTone("abandoned")).toBe("abandoned")
		expect(phaseBarTone("active")).toBe("running")
	})
})
