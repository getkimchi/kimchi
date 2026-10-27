import { describe, expect, it } from "vitest"
import { parseCommentLines } from "./github.ts"

describe("parseCommentLines", () => {
	it("reads one JSON comment per line across paginated gh output", () => {
		const out = `{"id":1,"body":"a"}\n{"id":2,"body":"multi\\nline"}\n\n{"id":31,"body":"page two"}\n`
		expect(parseCommentLines(out)).toEqual([
			{ id: 1, body: "a" },
			{ id: 2, body: "multi\nline" },
			{ id: 31, body: "page two" },
		])
	})
})
