/**
 * Digest-value measurement — the evidence that auto-injection earns its
 * tokens. Seeds a real store with representative durable facts (remote
 * embeddings via the gateway), then runs related and unrelated queries
 * through the same value gate the extension uses.
 *
 * Reports per query: top score, facts kept, digest size, and whether the
 * value gate injected anything — plus the no-injection rate across
 * unrelated sessions, which is the number that must be high for automatic
 * injection to be acceptable.
 *
 * Usage: pnpm run memory:measure  (gateway key required, as memory:check)
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMemoryBackend, disableMem0Telemetry } from "./backend.js"
import { DIGEST_SCORE_THRESHOLD, MEMORY_USER_ID } from "./config.js"
import { buildMemoryDigest } from "./inject.js"

const SEED_FACTS = [
	"I always use pnpm, never npm or yarn",
	"My tests live beside the source files as *.test.ts",
	"I prefer vim keybindings in every editor",
	"I work on the kimchi coding agent at Cast AI",
	"My timezone is CET and I start work around 9am",
	"I never want emoji in commit messages",
]

const RELATED_QUERIES = [
	"which package manager does the user prefer?",
	"where do the user's tests live?",
	"what editor keybindings does the user like?",
	"where does the user work and on what?",
]

const UNRELATED_QUERIES = [
	"fix the failing login test in the auth module",
	"refactor the database connection pool",
	"write a bash script to rotate logs",
	"what does this dockerfile do?",
]

interface QueryResult {
	query: string
	related: boolean
	topScore: number | null
	facts: number
	tokensEstimated: number
}

async function main(): Promise<void> {
	disableMem0Telemetry()
	const dir = mkdtempSync(join(tmpdir(), "kimchi-memory-measure-"))
	try {
		const backend = await createMemoryBackend({ dbPath: join(dir, "memory.db") })
		console.log("seeding store…")
		for (const fact of SEED_FACTS) {
			await backend.add(fact, { userId: MEMORY_USER_ID, infer: false })
		}

		const results: QueryResult[] = []
		for (const [group, queries] of [
			["related", RELATED_QUERIES],
			["unrelated", UNRELATED_QUERIES],
		] as const) {
			for (const query of queries) {
				const search = await backend.search(query, { filters: { user_id: MEMORY_USER_ID }, topK: 8 })
				const list = (Array.isArray(search) ? search : (search?.results ?? [])) as Array<{
					memory?: string
					score?: number
				}>
				const digest = buildMemoryDigest(list)
				results.push({
					query,
					related: group === "related",
					topScore: list[0]?.score ?? null,
					facts: digest?.composition.facts ?? 0,
					tokensEstimated: digest?.composition.tokensEstimated ?? 0,
				})
			}
		}

		console.log(`\nvalue gate: threshold ${DIGEST_SCORE_THRESHOLD}\n`)
		for (const r of results) {
			const verdict = r.facts > 0 ? `INJECT (${r.facts} facts, ~${r.tokensEstimated} tok)` : "no injection"
			console.log(
				`${r.related ? "RELATED  " : "unrelated"} top=${r.topScore?.toFixed(3) ?? "-"} ${verdict}  "${r.query}"`,
			)
		}

		const related = results.filter((r) => r.related)
		const unrelated = results.filter((r) => !r.related)
		const injectedRate = related.filter((r) => r.facts > 0).length / related.length
		const noInjectionRate = unrelated.filter((r) => r.facts === 0).length / unrelated.length
		console.log(`\ninjection rate on related queries:    ${(injectedRate * 100).toFixed(0)}%`)
		console.log(`no-injection rate on unrelated:       ${(noInjectionRate * 100).toFixed(0)}%`)
		const relatedTop = related.map((r) => r.topScore ?? 0)
		const unrelatedTop = unrelated.map((r) => r.topScore ?? 0)
		console.log(
			`top-score range  related: ${Math.min(...relatedTop).toFixed(3)}–${Math.max(...relatedTop).toFixed(3)}  unrelated: ${Math.min(...unrelatedTop).toFixed(3)}–${Math.max(...unrelatedTop).toFixed(3)}`,
		)
		console.log(
			"\nhealth check: injection rate should be high, no-injection rate should be high, and the two score ranges should separate near the threshold. Re-tune DIGEST_SCORE_THRESHOLD in config.ts if they do not.",
		)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

main().catch((err: unknown) => {
	console.error("memory measure crashed:", err instanceof Error ? err.message : err)
	process.exitCode = 1
})
