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

import { existsSync } from "node:fs"

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { CodeRagError, resolveEmbedModel } from "./embedder.js"
import { type IndexProgress, indexFilePath, MAX_STALE_FILES_PER_SEARCH, searchIndex, updateIndex } from "./indexer.js"

const DEFAULT_RESULT_LIMIT = 6
const STATUS_KEY = "code-rag"

/** Counterweight to the Tool Preferences block ("searching file contents →
 *  use grep"), which otherwise wins every code-finding decision. Rendered
 *  only when an index exists for the project. */
const CODE_RAG_SYSTEM_PROMPT = `## Semantic Code Search (code_search)

This project has a local semantic code index. For conceptual or exploratory code questions — "where is X handled", "how does Y work", locating code by behavior when you don't know the exact identifier — call \`code_search\` FIRST, before reaching for grep. It matches meaning, not just tokens, and returns file:line-range chunks ranked by relevance.

Use grep instead only when you already know the exact string, identifier, or symbol name. A typical exploration flow: code_search to find candidate locations → read for full context → grep to enumerate every occurrence of an identifier you discovered.`

function formatScore(score: number): string {
	return score.toFixed(3)
}

function formatIndexingStatus(progress: IndexProgress, startedAt: number): string {
	const base = `indexing ${progress.embeddedChunks}/${progress.totalChunks} chunks`
	if (progress.totalChunks === 0 || progress.embeddedChunks === 0) return base
	const percent = Math.floor((progress.embeddedChunks / progress.totalChunks) * 100)
	const elapsedSeconds = (Date.now() - startedAt) / 1000
	const remainingSeconds = (elapsedSeconds / progress.embeddedChunks) * (progress.totalChunks - progress.embeddedChunks)
	const eta =
		remainingSeconds < 90
			? `~${Math.max(1, Math.round(remainingSeconds / 5) * 5)}s`
			: `~${Math.round(remainingSeconds / 60)}m`
	return `${base} (${percent}%, ${eta} left)`
}

export default function codeRagExtension(pi: ExtensionAPI): void {
	createSystemPromptBlocks(pi, "code-rag").register({
		id: "code-rag-search",
		render: () => (existsSync(indexFilePath(process.cwd())) ? CODE_RAG_SYSTEM_PROMPT : undefined),
	})

	// Captured on session_start so code_search (whose execute() gets no ctx)
	// can surface refresh progress in the status line.
	let ui: ExtensionUIContext | undefined

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined
	})

	pi.on("session_shutdown", async () => {
		ui?.setStatus(STATUS_KEY, undefined)
		ui = undefined
	})

	// Non-null while an /index build is running. The build is intentionally not
	// awaited by the command handler so the session stays usable; code_search
	// consults this to avoid racing a second updateIndex against the build.
	let buildInFlight: Promise<void> | undefined

	pi.registerCommand("index", {
		description: "Build or update the local code-RAG embedding index (requires a local embedding server, e.g. oMLX)",
		handler: async (_args, ctx) => {
			if (buildInFlight) {
				ctx.ui.notify("An index build is already in progress", "info")
				return
			}
			const cwd = process.cwd()
			const model = resolveEmbedModel()
			ctx.ui.notify(`Indexing codebase with ${model} in the background…`, "info")
			const started = Date.now()
			buildInFlight = (async () => {
				try {
					const stats = await updateIndex(cwd, {
						onProgress: (p) => ctx.ui.setStatus(STATUS_KEY, formatIndexingStatus(p, started)),
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
					buildInFlight = undefined
				}
			})()
		},
	})

	pi.registerTool({
		name: "code_search",
		label: "Code Search",
		description:
			"Semantic search over a local embedding index of this codebase — the FIRST tool to reach for on any " +
			"conceptual or exploratory code question: 'where is X handled', 'how does Y work', 'which code decides Z'. " +
			"It matches meaning, not just tokens, so it works when you can only describe the behavior you're looking for " +
			"('where are permission prompts decided', 'retry logic for provider requests'). " +
			"Reach for grep only in the narrow case where you already know the exact string, identifier, or symbol name " +
			"and want every occurrence of it. " +
			"Results are file:line-range chunks ranked by relevance; follow up with Read for full context. " +
			"If no index exists yet, ask the user to run /index.",
		promptSnippet: "Semantic code search — use before grep for conceptual/exploratory queries",
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
			// While an /index build runs, search the existing snapshot instead of
			// racing a second refresh against it (two concurrent index writers).
			const buildRunning = buildInFlight !== undefined
			let outcome: Awaited<ReturnType<typeof searchIndex>>
			try {
				outcome = await searchIndex(process.cwd(), params.query, params.limit ?? DEFAULT_RESULT_LIMIT, {
					signal,
					skipRefresh: buildRunning,
					onProgress: buildRunning
						? undefined
						: (p) => ui?.setStatus(STATUS_KEY, `refreshing index ${p.embeddedChunks}/${p.totalChunks} chunks`),
				})
			} finally {
				// The /index build owns the status line while it runs.
				if (!buildRunning) ui?.setStatus(STATUS_KEY, undefined)
			}

			const sections = outcome.results.map(
				(r) => `${r.file}:${r.startLine}-${r.endLine} (score ${formatScore(r.score)})\n${r.text}`,
			)
			let text = sections.length > 0 ? sections.join("\n\n---\n\n") : "No matching code found in the index."
			if (buildRunning) {
				text += "\n\n[Note: an /index build is currently running; results may come from a partially stale index.]"
			} else if (outcome.pendingStaleFiles > 0) {
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
