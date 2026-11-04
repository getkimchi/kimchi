// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { describe, expect, it } from "vitest"
import { createDebounce } from "./debounce.js"

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe("createDebounce", () => {
	it("coalesces a burst into a single trailing call", async () => {
		const calls: number[] = []
		const d = createDebounce(() => calls.push(calls.length), 40)
		d.schedule()
		await tick(20)
		d.schedule()
		await tick(20)
		d.schedule()
		await tick(60)
		expect(calls).toEqual([0])
	})

	it("cancel drops a pending call", async () => {
		let n = 0
		const d = createDebounce(() => n++, 10)
		d.schedule()
		d.cancel()
		await tick(30)
		expect(n).toBe(0)
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
