/**
 * Embedding client for the code-rag extension.
 *
 * Speaks the OpenAI-compatible /v1/embeddings protocol against a local
 * inference server — oMLX by default (port 8000), but any server exposing the
 * same shape works (llama.cpp, LM Studio, vLLM). Host and model come from
 * $KIMCHI_CODE_RAG_EMBED_HOST and $KIMCHI_CODE_RAG_EMBED_MODEL. All failures
 * surface as CodeRagError with actionable guidance.
 */

/** Qwen3-Embedding is Matryoshka-trained: truncating the native vector
 *  (2560 dims for 4B) to a prefix stays a valid embedding. 1024 dims cuts the
 *  on-disk index to ~40% with negligible retrieval loss. */
export const INDEX_DIMS = 1024

const DEFAULT_EMBED_HOST = "http://localhost:8000"
/** Benchmarked 2026-07 on M4 Pro via oMLX (eager path — its compiled path
 *  fails for all Qwen3-Embedding quants): 0.6B-8bit 402 chunks/min vs
 *  4B-4bit-DWQ 42 and 4B-mxfp8 48. The 4B models are ~9x slower for a modest
 *  retrieval gain the hybrid lexical leg mostly covers; override via env if
 *  the trade-off changes. */
const DEFAULT_EMBED_MODEL = "Qwen3-Embedding-0.6B-8bit"
/** Generous because servers that serialize embed requests (oMLX's eager path)
 *  make a request's latency scale with the number of in-flight batches. */
const EMBED_TIMEOUT_MS = 300_000
const START_SERVER_HINT =
	"start oMLX with: omlx serve --model-dir ~/models (or set KIMCHI_CODE_RAG_EMBED_HOST to another OpenAI-compatible embedding server)"

/** User-actionable failure (server down, no index yet). Messages are written
 *  to be shown verbatim in the TUI or to the model. */
export class CodeRagError extends Error {}

export function resolveEmbedHost(): string {
	const fromEnv = process.env.KIMCHI_CODE_RAG_EMBED_HOST?.trim()
	return (fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_EMBED_HOST).replace(/\/+$/, "")
}

export function resolveEmbedModel(): string {
	return process.env.KIMCHI_CODE_RAG_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL
}

/** Qwen3-Embedding is instruction-aware: queries carry a task instruction,
 *  documents are embedded raw. Mixing this up costs several points of nDCG. */
export function formatQueryForEmbedding(query: string): string {
	return `Instruct: Given a code search query, retrieve the most relevant code chunks from the codebase\nQuery: ${query}`
}

/** Truncate to the index dimensionality and L2-normalize so similarity is a
 *  plain dot product at search time. */
function truncateAndNormalize(vector: number[], dims: number): Float32Array {
	const out = new Float32Array(Math.min(dims, vector.length))
	let sumSquares = 0
	for (let i = 0; i < out.length; i++) {
		out[i] = vector[i]
		sumSquares += out[i] * out[i]
	}
	const norm = Math.sqrt(sumSquares)
	if (norm > 0) {
		for (let i = 0; i < out.length; i++) out[i] /= norm
	}
	return out
}

export interface EmbedOptions {
	signal?: AbortSignal
	fetch?: typeof fetch
}

interface OpenAiEmbeddingsResponse {
	data?: { embedding?: number[]; index?: number }[]
}

export async function embedTexts(texts: string[], options: EmbedOptions = {}): Promise<Float32Array[]> {
	if (texts.length === 0) return []
	const host = resolveEmbedHost()
	const model = resolveEmbedModel()
	const fetchImpl = options.fetch ?? fetch
	const timeout = AbortSignal.timeout(EMBED_TIMEOUT_MS)
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

	let response: Response
	try {
		response = await fetchImpl(`${host}/v1/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, input: texts }),
			signal,
		})
	} catch (error) {
		if (options.signal?.aborted) throw error
		const message = error instanceof Error ? error.message : String(error)
		throw new CodeRagError(`Cannot reach the embedding server at ${host} (${message}) — ${START_SERVER_HINT}`)
	}

	let payload: OpenAiEmbeddingsResponse
	// Body reads can also be interrupted by the timeout signal — map those to
	// CodeRagError too so the caller's retry path sees them.
	try {
		if (!response.ok) {
			const body = await response.text().catch(() => "")
			if (response.status === 404 && body.includes("model")) {
				throw new CodeRagError(
					`Embedding model "${model}" is not available on ${host}. ` +
						`Check GET ${host}/v1/models and set KIMCHI_CODE_RAG_EMBED_MODEL to a served embedding model.`,
				)
			}
			throw new CodeRagError(`Embedding request failed (${response.status}): ${body.slice(0, 200)}`)
		}
		payload = (await response.json()) as OpenAiEmbeddingsResponse
	} catch (error) {
		if (error instanceof CodeRagError || options.signal?.aborted) throw error
		const message = error instanceof Error ? error.message : String(error)
		throw new CodeRagError(`Embedding request to ${host} was interrupted (${message})`)
	}
	const data = payload.data
	if (!Array.isArray(data) || data.length !== texts.length) {
		throw new CodeRagError(`Embedding server at ${host} returned an unexpected /v1/embeddings payload`)
	}
	// The spec allows out-of-order rows; sort by index before trusting positions.
	const rows = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
	return rows.map((row) => {
		if (!Array.isArray(row.embedding)) {
			throw new CodeRagError(`Embedding server at ${host} returned a row without an embedding vector`)
		}
		return truncateAndNormalize(row.embedding, INDEX_DIMS)
	})
}
