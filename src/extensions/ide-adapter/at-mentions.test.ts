import { describe, expect, it } from "vitest"
import { formatAtMention } from "./at-mentions.js"

describe("at-mentions", () => {
	describe("formatAtMention", () => {
		it("formats a mention with line range", () => {
			expect(formatAtMention({ filePath: "/a/b.ts", lineStart: 10, lineEnd: 20 })).toBe("@/a/b.ts:10-20")
		})

		it("formats a mention without line range (0 means none)", () => {
			expect(formatAtMention({ filePath: "/a/b.ts", lineStart: 0, lineEnd: 0 })).toBe("@/a/b.ts")
		})
	})
})
