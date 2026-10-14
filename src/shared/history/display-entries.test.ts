import { describe, expect, it } from "vitest"
import { tagDisplayEntries } from "./display-entries.js"

function entry(id: string, type = "message", extra: Record<string, unknown> = {}) {
	return { id, parentId: null, type, ...extra }
}

describe("tagDisplayEntries", () => {
	it("marks nothing when the path has no compaction", () => {
		const path = [entry("a"), entry("b"), entry("c")]
		const tagged = tagDisplayEntries(path)
		expect(tagged.map((t) => t.compactedBefore)).toEqual([false, false, false])
		expect(tagged[0].entry.id).toBe("a")
	})

	it("marks entries before the latest compaction's firstKeptEntryId", () => {
		const path = [
			entry("u1"),
			entry("a1"),
			entry("u2"),
			entry("u3"),
			entry("c1", "compaction", { firstKeptEntryId: "u3" }),
			entry("u3"),
			entry("a3"),
		]
		const tagged = tagDisplayEntries(path)
		expect(tagged.map((t) => t.compactedBefore)).toEqual([true, true, true, false, false, false, false])
	})

	it("uses the compaction position when firstKeptEntryId is absent from the path", () => {
		const path = [entry("u1"), entry("a1"), entry("c1", "compaction", { firstKeptEntryId: "gone" }), entry("u2")]
		const tagged = tagDisplayEntries(path)
		expect(tagged.map((t) => t.compactedBefore)).toEqual([true, true, false, false])
	})

	it("uses the LATEST compaction when several exist on the path", () => {
		const path = [
			entry("u1"),
			entry("c1", "compaction", { firstKeptEntryId: "u2" }),
			entry("u2"),
			entry("u3"),
			entry("c2", "compaction", { firstKeptEntryId: "u3" }),
			entry("u3"),
		]
		const tagged = tagDisplayEntries(path)
		// Only the latest compaction's cut matters for eviction/display tagging.
		expect(tagged.map((t) => t.compactedBefore)).toEqual([true, true, true, false, false, false])
	})
})
