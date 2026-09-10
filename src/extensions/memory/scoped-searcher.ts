/**
 * Scoped retrieval: search the personal store plus the current project's
 * store, merge by score, hand the existing digest value gate a single list.
 * Pure merge is extracted for unit testing under Node; construction is
 * Bun-only (SQLite backends), same split as backend.ts.
 */
import type { Memory as Mem0Memory } from "mem0ai/oss"
import { createMemoryBackend, memoryDbPath, projectDbPath } from "./backend.js"
import { MEMORY_USER_ID } from "./config.js"
import { resolveProjectScope } from "./scope.js"

export type MemoryScope = "personal" | "project"

export interface ScopedSearchResult {
	memory?: string
	score?: number
	/** Which store the fact came from — the tool labels provenance; the digest ignores it. */
	scope?: MemoryScope
}

export interface ScopedSearcher {
	search(query: string, topK?: number): Promise<ScopedSearchResult[]>
}

/** Merge two stores' results by score (descending), trimming to topK. Pure. */
export function mergeScopedResults(
	personal: ScopedSearchResult[],
	project: ScopedSearchResult[],
	topK: number,
): ScopedSearchResult[] {
	return [...personal, ...project].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, topK)
}

type Backend = Mem0Memory

async function searchOne(
	backend: Backend,
	tag: MemoryScope,
	query: string,
	topK: number,
): Promise<ScopedSearchResult[]> {
	const results = await backend.search(query, { filters: { user_id: MEMORY_USER_ID }, topK })
	const list = (Array.isArray(results) ? results : (results?.results ?? [])) as Array<{
		memory?: string
		score?: number
	}>
	return list.map((r) => ({ memory: r.memory, score: r.score, scope: tag }))
}

/**
 * Construct the scoped searcher: the personal store always, plus the project
 * store when the cwd resolves to a repository. A project-store failure
 * degrades to personal-only (logged once) — memory must never break a session.
 */
export async function createScopedSearcher(cwd: string): Promise<ScopedSearcher> {
	const project = resolveProjectScope(cwd)
	const personal = await createMemoryBackend({ dbPath: memoryDbPath("personal") })
	let projectBackend: Backend | null = null
	if (project) {
		try {
			projectBackend = await createMemoryBackend({ dbPath: projectDbPath(project.id) })
		} catch (err) {
			console.error(
				`[memory] project store unavailable (${project.id}), continuing personal-only:`,
				err instanceof Error ? err.message : err,
			)
		}
	}
	return {
		search: async (query, topK = 8) => {
			const [personalHits, projectHits] = await Promise.all([
				searchOne(personal, "personal", query, topK),
				projectBackend ? searchOne(projectBackend, "project", query, topK) : Promise.resolve([]),
			])
			return mergeScopedResults(personalHits, projectHits, topK)
		},
	}
}
