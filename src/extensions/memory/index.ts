/**
 * Memory extension: persistent personal memory for chat sessions, backed by
 * Mem0 OSS with the SQLite store and remote embeddings (see backend.ts).
 *
 * Injection policy — auto-injected context must earn its tokens:
 *   - The retrieval query is grounded in the session's opening prompt (the
 *     first `before_agent_start`'s `event.prompt`), not a standing query.
 *   - Facts must clear the relevance threshold and the top-N / token caps
 *     (inject.ts). When nothing clears the bar, NOTHING is injected — an
 *     empty digest is the normal outcome for unrelated sessions.
 *   - The digest is appended to the system prompt on EVERY agent start of
 *     the session with identical bytes — a stable prefix from the first
 *     turn, zero mid-session cache breaks. It is recomputed only after a
 *     compaction (where the prefix already breaks) or on session restart.
 *   - `memory_search` is the pull-based supplement for anything the digest
 *     did not surface.
 *
 * Failures degrade to no-memory: store/search errors log once and leave
 * the session untouched. Memory must never break a session.
 *
 * Opt-in via the `--memory` CLI flag (see cli-args.ts CLI_OPTIONS).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "../../cli-args.js"
import {
	buildMemoryConfig,
	createMemoryBackend,
	type MemoryBackendOptions,
} from "./backend.js"
import { wireMemoryCapture } from "./capture.js"
import { DIGEST_SCORE_THRESHOLD, digestDbPath, MEMORY_USER_ID } from "./config.js"
import { buildMemoryDigest, type DigestComposition } from "./inject.js"
import { createMemorySearchTool } from "./tools.js"

/** What one search call returns after the value gate. */
interface DigestState {
	text: string
	composition: DigestComposition
	query: string
}

interface MemorySearcher {
	search(query: string): Promise<Array<{ memory?: string; score?: number }>>
}

function isMemoryEnabled(): boolean {
	return getParsedCliArgs().options.memory === true
}

export default function memoryExtension(pi: ExtensionAPI): void {
	if (!isMemoryEnabled()) return

	wireMemoryCapture(pi)

	// Per-runtime state (closure, like context-assembly's hash fields) — never
	// module-level: each session runtime gets a fresh extension instance.
	let searcher: MemorySearcher | undefined
	let searcherFailed = false
	let digest: DigestState | undefined

	const logOnce = (message: string, err: unknown): void => {
		// Degrade to no-memory; log enough to diagnose (skill: never swallow).
		console.error(`[memory] ${message}:`, err instanceof Error ? err.message : err)
	}

	const getSearcher = async (): Promise<MemorySearcher | undefined> => {
		if (searcher) return searcher
		if (searcherFailed) return undefined
		try {
			const backend = await createMemoryBackend({
				dbPath: digestDbPath(),
			} satisfies MemoryBackendOptions)
			searcher = {
				search: async (query: string) => {
					const results = await backend.search(query, {
						filters: { user_id: MEMORY_USER_ID },
						topK: 8,
					})
					const list = (Array.isArray(results) ? results : results?.results ?? []) as Array<{
						memory?: string
						score?: number
					}>
					return list
				},
			}
			return searcher
		} catch (err) {
			searcherFailed = true
			logOnce("memory backend unavailable, continuing without memory", err)
			return undefined
		}
	}

	// Compute the digest once per session (lazy: the grounding query is the
	// session's opening prompt, available at the first before_agent_start).
	const computeDigest = async (query: string): Promise<DigestState | undefined> => {
		try {
			const s = await getSearcher()
			if (!s) return undefined
			const hits = await s.search(query)
			const result = buildMemoryDigest(hits)
			if (!result) {
				// Nothing cleared the value bar — inject nothing. Record the
				// composition so the value measurement sees the no-injection rate.
				const empty: DigestComposition = { ...resultlessComposition(hits) }
				console.info(`[memory] no digest for query (${empty.belowThreshold} below threshold of ${DIGEST_SCORE_THRESHOLD})`)
				return undefined
			}
			console.info(`[memory] digest injected: ${JSON.stringify(result.composition)}`)
			return { text: result.text, composition: result.composition, query }
		} catch (err) {
			logOnce("memory search failed, continuing without digest", err)
			return undefined
		}
	}

	pi.on("before_agent_start", (event) => {
		// Async work cannot block the prompt — compute on the side and apply
		// from the settled state on the NEXT start. The first turn of a session
		// therefore runs without a digest; from the second turn on, the prefix
		// is byte-stable. Post-compaction resets trigger recomputation the
		// same way, keeping the stable-prefix contract: the digest bytes never
		// change mid-run, they only appear after a settle.
		if (!digest) {
			void computeDigest(event.prompt).then((next) => {
				digest = next
			})
			return undefined
		}
		return { systemPrompt: `${event.systemPrompt}${digest.text}` }
	})

	pi.on("session_compact", () => {
		// The prefix breaks at compaction anyway — recompute the digest against
		// the post-compaction state on the next agent start.
		digest = undefined
	})

	const searchForTool = async (query: string): Promise<Array<{ memory?: string; score?: number }>> => {
		const s = await getSearcher()
		if (!s) return []
		return s.search(query)
	}

	pi.registerTool(createMemorySearchTool({ search: searchForTool }))
}

function resultlessComposition(hits: Array<{ memory?: string; score?: number }>): DigestComposition {
	const considered = hits.filter((h) => (h.memory ?? "").trim()).length
	return {
		facts: 0,
		considered,
		belowThreshold: considered,
		overCap: 0,
		overBudget: 0,
		tokensEstimated: 0,
	}
}
