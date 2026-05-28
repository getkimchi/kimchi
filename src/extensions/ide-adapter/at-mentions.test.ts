import { describe, expect, it } from "vitest"
import {
	drainAtMentions,
	formatAtMention,
	getLatestSelection,
	hasPendingAtMentions,
	queueAtMention,
	setLatestSelection,
} from "./at-mentions.js"

describe("at-mentions", () => {
	describe("formatAtMention", () => {
		it("formats a mention with line range", () => {
			expect(formatAtMention({ filePath: "/a/b.ts", lineStart: 10, lineEnd: 20 })).toBe("@/a/b.ts:10-20")
		})

		it("formats a mention without line range (0 means none)", () => {
			expect(formatAtMention({ filePath: "/a/b.ts", lineStart: 0, lineEnd: 0 })).toBe("@/a/b.ts")
		})
	})

	describe("queueAtMention / drainAtMentions", () => {
		it("queues and drains mentions", () => {
			queueAtMention({ filePath: "/a.ts", lineStart: 1, lineEnd: 5 })
			queueAtMention({ filePath: "/b.ts", lineStart: 10, lineEnd: 15 })
			expect(hasPendingAtMentions()).toBe(true)
			const drained = drainAtMentions()
			expect(drained).toEqual(["@/a.ts:1-5", "@/b.ts:10-15"])
			expect(hasPendingAtMentions()).toBe(false)
		})
	})

	describe("setLatestSelection", () => {
		it("stores and retrieves the latest selection", () => {
			expect(getLatestSelection()).toBeNull()
			setLatestSelection({ filePath: "/x.ts", lineStart: 3, lineEnd: 7 })
			expect(getLatestSelection()).toEqual({ filePath: "/x.ts", lineStart: 3, lineEnd: 7 })
		})
	})
})
