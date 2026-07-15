/**
 * code-rag extension — local semantic code search backed by Ollama embeddings.
 *
 * Registers:
 *  - /index         build or incrementally update the embedding index
 *  - code_search    semantic + lexical hybrid search over the index
 *
 * Requires a local OpenAI-compatible embedding server — oMLX by default —
 * serving a Qwen3-Embedding model (override host/model via
 * $KIMCHI_CODE_RAG_EMBED_HOST / $KIMCHI_CODE_RAG_EMBED_MODEL). All state
 * lives in .kimchi/code-rag/index.json, which is gitignored.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import { CodeRagError, resolveEmbedModel } from "./embedder.js"
import { MAX_STALE_FILES_PER_SEARCH, searchIndex, updateIndex } from "./indexer.js"

const DEFAULT_RESULT_LIMIT = 6
const STATUS_KEY = "code-rag"

function formatScore(score: number): string {
	return score.toFixed(3)
}

export default function codeRagExtension(pi: ExtensionAPI): void {
	pi.registerCommand("index", {
		description: "Build or update the local code-RAG embedding index (requires a local embedding server, e.g. oMLX)",
		handler: async (_args, ctx) => {
			const cwd = process.cwd()
			const model = resolveEmbedModel()
			ctx.ui.notify(`Indexing codebase with ${model}…`, "info")
			try {
				const started = Date.now()
				const stats = await updateIndex(cwd, {
					onProgress: (p) => ctx.ui.setStatus(STATUS_KEY, `indexing ${p.embeddedChunks}/${p.totalChunks} chunks`),
				})
				const seconds = ((Date.now() - started) / 1000).toFixed(1)
				ctx.ui.notify(
					`Indexed ${stats.files} files / ${stats.chunks} chunks in ${seconds}s ` +
						`(${stats.changedFiles} files re-embedded, ${stats.removedFiles} removed)`,
					"info",
				)
			} catch (error) {
				const message = error instanceof CodeRagError ? error.message : `Indexing failed: ${String(error)}`
				ctx.ui.notify(message, "error")
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined)
			}
		},
	})

	pi.registerTool({
		name: "code_search",
		label: "Code Search",
		description:
			"Semantic search over a local embedding index of this codebase. " +
			"Use it to locate code by meaning — 'where are permission prompts decided', 'retry logic for provider requests' — " +
			"when you don't know the exact identifier or file. For exact strings or symbol names you already know, prefer grep. " +
			"Results are file:line-range chunks ranked by relevance; follow up with Read for full context. " +
			"If no index exists yet, ask the user to run /index.",
		promptSnippet: "Semantic code search over the local embedding index",
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language or code description of what to find" }),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 20,
					description: `Maximum chunks to return (default: ${DEFAULT_RESULT_LIMIT})`,
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const started = Date.now()
			const outcome = await searchIndex(process.cwd(), params.query, params.limit ?? DEFAULT_RESULT_LIMIT, signal)

			const sections = outcome.results.map(
				(r) => `${r.file}:${r.startLine}-${r.endLine} (score ${formatScore(r.score)})\n${r.text}`,
			)
			let text = sections.length > 0 ? sections.join("\n\n---\n\n") : "No matching code found in the index."
			if (outcome.pendingStaleFiles > 0) {
				text += `\n\n[Note: ${outcome.pendingStaleFiles} changed files exceeded the per-search refresh budget (${MAX_STALE_FILES_PER_SEARCH}) and were searched with stale embeddings. Suggest running /index.]`
			}

			return {
				content: [{ type: "text" as const, text }],
				details: {
					durationMs: Date.now() - started,
					results: outcome.results.length,
					totalChunks: outcome.totalChunks,
					pendingStaleFiles: outcome.pendingStaleFiles,
				},
			}
		},
	})
}
