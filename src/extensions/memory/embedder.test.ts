import { describe, expect, it, vi } from "vitest"
import { dedupeEmbedder, type UnderlyingEmbedder } from "./embedder.js"

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

	/** Deferred-controllable underlying: each call parks until the test resolves or rejects it. */
	function deferredUnderlying() {
		const calls: Array<{ text: string; resolve: (v: number[]) => void; reject: (e: Error) => void }> = []
		const underlying: UnderlyingEmbedder = {
			embed: (text) => new Promise((resolve, reject) => calls.push({ text, resolve, reject })),
			embedBatch: async (texts) => texts.map((t) => [t.length]),
		}
		return { calls, underlying }
	}

	it("a stale rejection does not evict a newer memoized entry", async () => {
		const { calls, underlying } = deferredUnderlying()
		const shared = dedupeEmbedder(underlying)
		const stale = shared.embedQuery("flaky")
		// 32 more distinct texts, all left in flight: every entry is pending, so
		// the overflow fallback evicts the oldest — "flaky" — while unresolved.
		for (let i = 0; i < 32; i++) void shared.embedQuery(`filler-${i}`)
		// A newer call re-memoizes "flaky" with a fresh promise.
		const fresh = shared.embedQuery("flaky")
		expect(calls).toHaveLength(34)
		// The stale promise now rejects; the newer entry must survive it.
		calls[0]?.reject(new Error("stale failure"))
		await expect(stale).rejects.toThrow("stale failure")
		calls[33]?.resolve([42])
		await expect(fresh).resolves.toEqual([42])
		// The newer entry survived: a repeat is served from the memo with no new call.
		await expect(shared.embedQuery("flaky")).resolves.toEqual([42])
		expect(calls).toHaveLength(34)
	})

	it("a burst of settled entries never evicts an in-flight promise", async () => {
		const { calls, underlying } = deferredUnderlying()
		const shared = dedupeEmbedder(underlying)
		const slow = shared.embedQuery("slow") // stays in flight throughout
		// More than the memo limit of distinct texts, each settled (and its settle
		// handler drained) before the next insert — eviction must keep skipping
		// the pending "slow" entry.
		for (let i = 0; i < 35; i++) {
			const filler = shared.embedQuery(`filler-${i}`)
			calls[calls.length - 1]?.resolve([i])
			await filler
		}
		calls[0]?.resolve([99])
		await expect(slow).resolves.toEqual([99])
		// "slow" was never evicted while pending: the repeat is served from the
		// memo — a burst that dropped in-flight entries would re-issue the call.
		await expect(shared.embedQuery("slow")).resolves.toEqual([99])
		expect(calls).toHaveLength(36)
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
