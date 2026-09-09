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
 *   - Cache contract: the digest is computed on the first agent start
 *     (turn 1 awaits it) and appended with identical bytes on EVERY start —
 *     the provider-facing prefix is stable from the very first request,
 *     so memory causes zero mid-session cache breaks. It is recomputed
 *     only after a compaction, where the prefix breaks anyway. A session
 *     whose digest came back empty injects nothing at all, ever.
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
import { createMemoryBackend, type MemoryBackendOptions } from "./backend.js"
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

export interface MemorySearcher {
	search(query: string): Promise<Array<{ memory?: string; score?: number }>>
}

export interface MemoryExtensionDeps {
	/** Flag gate — tests force it on without touching process.argv. */
	isEnabled?: () => boolean
	/** Searcher factory — tests inject a stub; default builds the real backend. */
	createSearcher?: () => Promise<MemorySearcher | undefined>
}

export function createMemoryExtension(deps: MemoryExtensionDeps = {}): (pi: ExtensionAPI) => void {
	const isEnabled = deps.isEnabled ?? (() => getParsedCliArgs().options.memory === true)

	return function memoryExtension(pi: ExtensionAPI): void {
		// Registered unconditionally — pi rejects unknown extension flags at
		// startup (applyExtensionFlagValues), so "memory" must be known even
		// when the feature is off. Dual-declared with CLI_OPTIONS in
		// cli-args.ts (the kimchi-side parser + help text), same as --yolo/--plan.
		pi.registerFlag("memory", {
			description: "Enable persistent personal memory (capture + recall across sessions, local-only storage).",
			type: "boolean",
			default: false,
		})
		if (!isEnabled()) return

		wireMemoryCapture(pi)

		// Per-runtime state (closure, like context-assembly's hash fields) —
		// never module-level: each session runtime gets a fresh instance.
		// Three states: undefined = not computed yet, null = computed and
		// nothing cleared the value bar (or the store failed — logged once),
		// set = inject these bytes on every start.
		let digest: DigestState | null | undefined
		let searcher: MemorySearcher | undefined
		let searcherFailed = false

		const logOnce = (message: string, err: unknown): void => {
			// Degrade to no-memory; log enough to diagnose (skill: never swallow).
			console.error(`[memory] ${message}:`, err instanceof Error ? err.message : err)
		}

		const getSearcher = async (): Promise<MemorySearcher | undefined> => {
			if (searcher) return searcher
			if (searcherFailed) return undefined
			if (deps.createSearcher) {
				searcher = await deps.createSearcher()
				if (!searcher) searcherFailed = true
				return searcher
			}
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
						const list = (Array.isArray(results) ? results : (results?.results ?? [])) as Array<{
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

		const computeDigest = async (query: string): Promise<DigestState | null> => {
			try {
				const s = await getSearcher()
				if (!s) return null
				const hits = await s.search(query)
				const result = buildMemoryDigest(hits)
				if (!result) {
					// Nothing cleared the value bar — inject nothing this session.
					// Recorded so the value measurement sees the no-injection rate.
					const considered = hits.filter((h) => (h.memory ?? "").trim()).length
					const composition: DigestComposition = {
						facts: 0,
						considered,
						belowThreshold: considered,
						overCap: 0,
						overBudget: 0,
						tokensEstimated: 0,
					}
					console.info(
						`[memory] no digest for this session (belowThreshold=${composition.belowThreshold} of threshold ${DIGEST_SCORE_THRESHOLD})`,
					)
					return null
				}
				console.info(`[memory] digest injected: ${JSON.stringify(result.composition)}`)
				return { text: result.text, composition: result.composition, query }
			} catch (err) {
				logOnce("memory search failed, continuing without digest", err)
				return null
			}
		}

		pi.on("before_agent_start", async (event) => {
			// Awaited on the first start: the prefix carries the digest from the
			// very first request, so later turns never see a prompt change.
			if (digest === undefined) {
				digest = await computeDigest(event.prompt)
			}
			if (digest === null) return undefined
			return { systemPrompt: `${event.systemPrompt}${digest.text}` }
		})

		pi.on("session_compact", () => {
			// The prefix breaks at compaction anyway — recompute the digest
			// against the post-compaction state on the next agent start.
			digest = undefined
		})

		pi.registerTool(
			createMemorySearchTool({
				search: async (query) => {
					const s = await getSearcher()
					if (!s) return []
					return s.search(query)
				},
			}),
		)
	}
}

export default function memoryExtension(pi: ExtensionAPI): void {
	createMemoryExtension()(pi)
}
