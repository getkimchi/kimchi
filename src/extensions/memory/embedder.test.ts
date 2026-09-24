import { describe, expect, it, vi } from "vitest"
import { dedupeEmbedder } from "./embedder.js"

/** A controllable underlying embedder counting its calls. */
function makeUnderlying() {
	const embed = vi.fn(async (text: string) => {
		// Deterministic per-text vector — asserts result identity too.
		return [...text].slice(0, 4).map((c) => c.charCodeAt(0))
	})
	const embedBatch = vi.fn(async (texts: string[]) => texts.map((t) => [...t].slice(0, 4).map((c) => c.charCodeAt(0))))
	return { embed, embedBatch }
}

describe("dedupeEmbedder", () => {
	it("concurrent embeds of the same text share one underlying call", async () => {
		const underlying = makeUnderlying()
		const shared = dedupeEmbedder(underlying)
		const [a, b] = await Promise.all([
			shared.embedQuery("the user's dog is named Fred"),
			shared.embedQuery("the user's dog is named Fred"),
		])
		expect(underlying.embed).toHaveBeenCalledTimes(1)
		expect(a).toEqual(b)
	})

	it("different texts each embed", async () => {
		const underlying = makeUnderlying()
		const shared = dedupeEmbedder(underlying)
		await Promise.all([shared.embedQuery("first"), shared.embedQuery("second")])
		expect(underlying.embed).toHaveBeenCalledTimes(2)
	})

	it("memoized results are reused verbatim without new calls", async () => {
		const underlying = makeUnderlying()
		const shared = dedupeEmbedder(underlying)
		const first = await shared.embedQuery("pnpm preference")
		const second = await shared.embedQuery("pnpm preference")
		expect(underlying.embed).toHaveBeenCalledTimes(1)
		expect(second).toEqual(first)
	})

	it("failures propagate to every awaiter and are not memoized", async () => {
		const underlying = makeUnderlying()
		underlying.embed.mockRejectedValueOnce(new Error("gateway 503"))
		const shared = dedupeEmbedder(underlying)
		const attempts = await Promise.allSettled([shared.embedQuery("flaky"), shared.embedQuery("flaky")])
		for (const attempt of attempts) {
			expect(attempt.status).toBe("rejected")
		}
		// One underlying call for the failed pair — then a retry succeeds.
		expect(underlying.embed).toHaveBeenCalledTimes(1)
		await expect(shared.embedQuery("flaky")).resolves.toBeDefined()
		expect(underlying.embed).toHaveBeenCalledTimes(2)
	})

	it("the memo is bounded — evicted texts re-embed", async () => {
		const underlying = makeUnderlying()
		const shared = dedupeEmbedder(underlying)
		await shared.embedQuery("first-text")
		// Fill the memo past its limit with distinct texts.
		for (let i = 0; i < 32; i++) {
			await shared.embedQuery(`filler-${i}`)
		}
		expect(underlying.embed).toHaveBeenCalledTimes(33)
		// "first-text" was evicted — embedding it again hits the gateway.
		await shared.embedQuery("first-text")
		expect(underlying.embed).toHaveBeenCalledTimes(34)
		// The newest entry is still memoized.
		await shared.embedQuery("filler-31")
		expect(underlying.embed).toHaveBeenCalledTimes(34)
	})

	it("embedDocuments dedupes concurrent identical batches as a unit", async () => {
		const underlying = makeUnderlying()
		const shared = dedupeEmbedder(underlying)
		const [a, b] = await Promise.all([
			shared.embedDocuments(["auth", "module"]),
			shared.embedDocuments(["auth", "module"]),
		])
		expect(underlying.embedBatch).toHaveBeenCalledTimes(1)
		expect(a).toEqual(b)
		// A different batch embeds separately.
		await shared.embedDocuments(["auth", "login"])
		expect(underlying.embedBatch).toHaveBeenCalledTimes(2)
	})

	it("a single-text batch does not alias the same text as a query", async () => {
		const underlying = makeUnderlying()
		const shared = dedupeEmbedder(underlying)
		// join(["a"]) === "a" — the batch key and the query key are the SAME
		// string; separation comes from the two distinct memo maps, not the
		// keys. This pins that: one query embed + one batch embed, no aliasing.
		await Promise.all([shared.embedQuery("a"), shared.embedDocuments(["a"])])
		expect(underlying.embed).toHaveBeenCalledTimes(1)
		expect(underlying.embedBatch).toHaveBeenCalledTimes(1)
	})
})
