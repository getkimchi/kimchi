/**
 * Shared embedding generation: one deduping embedder instance across every
 * store a lookup touches. Without it, each mem0 backend embeds the same
 * query independently — the personal and project stores run in parallel,
 * so latency was one call but gateway usage and quota were doubled, and a
 * rate-limited gateway serialized the pair into two round-trips.
 *
 * The seam is mem0's `langchain` embedder provider: the factory accepts any
 * object with embedQuery/embedDocuments as `config.model` and delegates to
 * it (LangchainEmbedder). The underlying OpenAI embedder is still mem0's
 * own (EmbedderFactory "openai"), so the wire request — model, dimensions,
 * the usage-tracking tag — is byte-identical to before.
 *
 * Dedupe is safe because embeddings are deterministic for a fixed
 * (model, input) pair: caching by exact string is semantically transparent.
 * Pure — unit-tested under Node; construction requires the mem0 import and
 * is Bun-side, same split as backend.ts.
 */

import type { KimchiConfig } from "../../config.js"
import { loadConfig } from "../../config.js"
import { disableMem0Telemetry, resolveEmbeddingEndpoint, tagEmbeddingRequests } from "./backend.js"

/** The langchain-Embeddings shape mem0's LangchainEmbedder delegates to. */
export interface SharedEmbedder {
	embedQuery(text: string): Promise<number[]>
	embedDocuments(texts: string[]): Promise<number[][]>
}

/** The mem0 embedder surface the dedupe wrapper delegates to. */
export interface UnderlyingEmbedder {
	embed(text: string): Promise<number[]>
	embedBatch(texts: string[]): Promise<number[][]>
}

/** Exact-string memo entries kept before the oldest is evicted. */
const MEMO_LIMIT = 32

/**
 * Wrap an embedder so identical inputs share one gateway call: concurrent
 * calls with the same text (or the same batch of texts) await the same
 * in-flight promise, and the most recent MEMO_LIMIT results are reused
 * verbatim. Failures propagate to every awaiter and are never memoized —
 * the next call retries (guarded by identity: a stale rejection must not
 * evict a newer entry a burst re-memoized under the same key). Overflow
 * evicts the oldest SETTLED entry so a burst can never drop an in-flight
 * promise's dedupe window, falling back to the oldest overall only when
 * everything is still in flight. Batches dedupe as a unit: mem0's search
 * path embeds the query and its extracted entities separately, and both
 * stores extract the same entities from the same query, so the whole
 * batch is the natural key (one HTTP request either way).
 */
export function dedupeEmbedder(underlying: UnderlyingEmbedder): SharedEmbedder {
	const memo = new Map<string, Promise<number[]>>()
	const batchMemo = new Map<string, Promise<number[][]>>()
	// Unresolved promises across both memos (identity-keyed, so a query text
	// and a single-text batch cannot alias). Each promise removes itself on
	// settle, so the set is bounded by the in-flight count.
	const pending = new Set<Promise<unknown>>()
	const track = <T>(store: Map<string, Promise<T>>, key: string, call: () => Promise<T>): Promise<T> => {
		const inFlight = store.get(key)
		if (inFlight) return inFlight
		const promise = call()
		pending.add(promise)
		const settle = () => pending.delete(promise)
		promise.then(settle, settle)
		promise.catch(() => {
			// Evict on failure — but only while THIS promise is the memoized
			// entry: a burst may have evicted the key and a newer call re-set it,
			// and a stale rejection must not delete that newer entry.
			if (store.get(key) === promise) store.delete(key)
		})
		store.set(key, promise)
		if (store.size > MEMO_LIMIT) {
			// Map preserves insertion order. Evict the oldest SETTLED entry;
			// when everything is still in flight, the oldest overall.
			for (const candidate of store.keys()) {
				const entry = store.get(candidate)
				if (entry !== undefined && !pending.has(entry)) {
					store.delete(candidate)
					return promise
				}
			}
			store.delete(store.keys().next().value as string)
		}
		return promise
	}
	return {
		embedQuery: (text) => track(memo, text, () => underlying.embed(text)),
		embedDocuments: (texts) => track(batchMemo, texts.join("\u0000"), () => underlying.embedBatch(texts)),
	}
}

/**
 * Construct the shared embedder for a session's stores: one mem0 OpenAI
 * embedder against the resolved embedding endpoint, wrapped for dedupe.
 * Both backends created with `sharedEmbedder` in their options embed
 * through this single instance.
 */
export async function createSharedEmbedder(config: KimchiConfig = loadConfig()): Promise<SharedEmbedder> {
	const gateway = { baseURL: config.llmEndpoint, apiKey: config.apiKey }
	const endpoint = resolveEmbeddingEndpoint(undefined, gateway, config)
	if (!endpoint.apiKey) {
		throw new Error("memory backend embedder requires an API key — set KIMCHI_API_KEY or run `kimchi setup`")
	}
	// Both must run before the mem0 import / embedder construction: the
	// telemetry flag is read at module scope, and the OpenAI SDK captures
	// the fetch reference at client construction (backend.ts contract).
	disableMem0Telemetry()
	tagEmbeddingRequests(config.llmEndpoint)
	const { EmbedderFactory } = await import("mem0ai/oss")
	return dedupeEmbedder(
		EmbedderFactory.create("openai", {
			model: endpoint.model,
			apiKey: endpoint.apiKey,
			baseURL: endpoint.baseURL,
			embeddingDims: endpoint.dims,
		}),
	)
}
