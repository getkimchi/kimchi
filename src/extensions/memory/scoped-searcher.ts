/**
 * Scoped retrieval: search the personal store plus the current project's
 * store, merge by score, hand the existing digest value gate a single list.
 * Pure merge is extracted for unit testing under Node; construction is
 * Bun-only (SQLite backends), same split as backend.ts.
 */
import type { Memory as Mem0Memory } from "mem0ai/oss"
import { createMemoryBackend, type MemoryBackendOptions, normalizeMem0SearchResults, projectDbPath } from "./backend.js"
import { digestDbPath, MEMORY_USER_ID } from "./config.js"
import { currentRecallSignal } from "./deadline.js"
import { createSharedEmbedder, type SharedEmbedder } from "./embedder.js"
import { type MemoryMetadata, readMemoryMetadata } from "./metadata.js"
import { resolveProjectScope } from "./scope.js"

export type MemoryScope = "personal" | "project"

export interface ScopedSearchResult {
	/** Stable stored fact identifier (absent only on legacy/test hit shapes). */
	id?: string
	memory?: string
	score?: number
	/** Which store the fact came from — the tool labels provenance; the digest ignores it. */
	scope?: MemoryScope
	metadata?: MemoryMetadata
}

export type MemoryRetrievalScope = "all" | "current-working" | "durable-evidence"

export interface ScopedSearcher {
	search(query: string, topK?: number, scope?: MemoryRetrievalScope): Promise<ScopedSearchResult[]>
}

/** Merge two stores' results by score (descending), trimming to topK. Pure. */
export function mergeScopedResults(
	personal: ScopedSearchResult[],
	project: ScopedSearchResult[],
	topK: number,
	retrievalScope: MemoryRetrievalScope = "all",
): ScopedSearchResult[] {
	const matches = (hit: ScopedSearchResult): boolean => {
		if (retrievalScope === "all") return true
		const metadata = readMemoryMetadata(hit.metadata, hit.memory ?? "")
		if (retrievalScope === "current-working") return metadata.kind === "working" && metadata.canonical === true
		return metadata.kind !== "working"
	}
	const validOrder = (hit: ScopedSearchResult): number => hit.metadata?.validOrder ?? 0
	const latestByEpisode = new Map<string, number>()
	if (retrievalScope === "current-working") {
		// Only an explicit episode can define a validity series, and only a
		// supplied logical order can locate its current member. Ambiguous
		// history remains visible; current-working evidence stays separate.
		for (const hit of [...personal, ...project]) {
			const meta = hit.metadata
			if (meta?.kind === "working" && meta.canonical === true && meta.episode && validOrder(hit) > 0) {
				latestByEpisode.set(meta.episode, Math.max(latestByEpisode.get(meta.episode) ?? 0, validOrder(hit)))
			}
		}
	}
	return [...personal, ...project]
		.filter(matches)
		.filter((hit) => {
			if (retrievalScope !== "current-working") return true
			const episode = hit.metadata?.episode
			return !episode || validOrder(hit) === 0 || validOrder(hit) === latestByEpisode.get(episode)
		})
		.sort((a, b) => {
			if (
				retrievalScope === "current-working" &&
				a.metadata?.episode === b.metadata?.episode &&
				validOrder(a) !== validOrder(b)
			) {
				return validOrder(b) - validOrder(a)
			}
			return (b.score ?? 0) - (a.score ?? 0)
		})
		.slice(0, topK)
}

/** The narrow backend surface the searcher reads — narrower than Mem0Memory so tests can stub it. */
export type ScopedBackend = Pick<Mem0Memory, "search">

/** Test seams for createScopedSearcher — both external factories are injectable. */
export interface ScopedSearcherDeps {
	createSharedEmbedder?: () => Promise<SharedEmbedder>
	createMemoryBackend?: (options: MemoryBackendOptions) => Promise<ScopedBackend>
}

async function searchOne(
	backend: ScopedBackend,
	tag: MemoryScope,
	query: string,
	topK: number,
): Promise<ScopedSearchResult[]> {
	currentRecallSignal()?.throwIfAborted()
	const results = await backend.search(query, { filters: { user_id: MEMORY_USER_ID }, topK })
	return normalizeMem0SearchResults(results).map((r) => ({
		id: r.id,
		memory: r.memory,
		score: r.score,
		scope: tag,
		...(r.metadata ? { metadata: r.metadata } : {}),
	}))
}

/**
 * Construct the scoped searcher: the personal store always, plus the project
 * store when the cwd resolves to a repository. Both share one deduping
 * embedder, so each query is embedded once across the stores. A
 * project-store failure degrades to personal-only (logged once) — memory
 * must never break a session.
 */
export async function createScopedSearcher(cwd: string, deps: ScopedSearcherDeps = {}): Promise<ScopedSearcher> {
	const createEmbedder = deps.createSharedEmbedder ?? createSharedEmbedder
	const createBackend = deps.createMemoryBackend ?? createMemoryBackend
	const project = resolveProjectScope(cwd)
	const embedder = await createEmbedder()
	const personal = await createBackend({ dbPath: digestDbPath(), sharedEmbedder: embedder })
	let projectBackend: ScopedBackend | null = null
	if (project) {
		try {
			projectBackend = await createBackend({ dbPath: projectDbPath(project.id), sharedEmbedder: embedder })
		} catch (err) {
			console.error(
				`[memory] project store unavailable (${project.id}), continuing personal-only:`,
				err instanceof Error ? err.message : err,
			)
		}
	}
	return {
		search: async (query, topK = 8, retrievalScope = "all") => {
			// Scoped filters need a bounded wider candidate pool for the merge.
			const fetchTopK = retrievalScope === "all" ? topK : Math.max(topK, Math.min(128, topK * 4))
			const [personalHits, projectHits] = await Promise.all([
				searchOne(personal, "personal", query, fetchTopK),
				projectBackend ? searchOne(projectBackend, "project", query, fetchTopK) : Promise.resolve([]),
			])
			currentRecallSignal()?.throwIfAborted()
			return mergeScopedResults(personalHits, projectHits, topK, retrievalScope)
		},
	}
}
