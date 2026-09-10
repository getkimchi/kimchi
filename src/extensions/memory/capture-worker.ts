/**
 * Memory capture worker — a detached process that turns session messages
 * into stored memories without blocking the harness.
 *
 * Spawned by capture.ts (session_before_compact / session_shutdown) with a
 * job file; also routed as the `kimchi memory-capture` subcommand in
 * compiled binaries (cli.ts), where process.execPath is the kimchi binary
 * itself rather than the bun runtime.
 *
 * Pipeline per job: dedupe against captured-hashes → window (≤4 messages,
 * the gateway 524 mitigation from the spike) → extraction LLM (tuned to
 * durable user facts) → conservative force-DELETE+ADD supersede →
 * add(infer: false) → mark hashes → delete the job file.
 *
 * Idempotence: message hashes are recorded only after a window fully
 * processes, so a crashed run resumes where it stopped and a re-spawned
 * duplicate job is a no-op.
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createMemoryBackend, disableMem0Telemetry } from "./backend.js"
import { MEMORY_USER_ID } from "./config.js"
import { findSupersededIds } from "./supersede.js"

export interface CaptureMessage {
	role: "user" | "assistant"
	content: string
}

export interface CaptureJob {
	messages: CaptureMessage[]
}

/** Max messages per extraction window — the spike's gateway 524 mitigation. */
export const WINDOW_SIZE = 4

export function messageHash(message: CaptureMessage): string {
	return createHash("sha1").update(`${message.role}:${message.content}`).digest("hex")
}

export function windowMessages(messages: CaptureMessage[], max = WINDOW_SIZE): CaptureMessage[][] {
	const windows: CaptureMessage[][] = []
	for (let i = 0; i < messages.length; i += max) {
		windows.push(messages.slice(i, i + max))
	}
	return windows
}

/**
 * Extract the JSON fact array from an LLM response. The model is instructed
 * to return only the array, but parsing stays defensive: code fences and
 * stray prose are tolerated, and a non-array parse is an error.
 */
export function parseFactsResponse(text: string): string[] {
	const start = text.indexOf("[")
	const end = text.lastIndexOf("]")
	if (start === -1 || end === -1 || end < start) {
		throw new Error(`extraction response has no JSON array: ${text.slice(0, 200)}`)
	}
	const parsed: unknown = JSON.parse(text.slice(start, end + 1))
	if (!Array.isArray(parsed)) {
		throw new Error("extraction response is not an array")
	}
	return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

interface GatewayLlmOptions {
	baseURL: string
	apiKey: string
	model: string
	/** Injectable for tests. */
	fetchImpl?: typeof fetch
}

/**
 * One chat-completion call with the gateway reliability contract: retry
 * 429/5xx/network errors with retry-after honoring backoff (the Cloudflare
 * edge at llm.kimchi.dev times out around 100s — spike finding). Other 4xx
 * errors throw without retry.
 */
export async function chatJson(
	options: GatewayLlmOptions,
	system: string,
	user: string,
	maxAttempts = 4,
): Promise<string> {
	const fetchImpl = options.fetchImpl ?? fetch
	let lastError: unknown
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetchImpl(
				// Relative join (no leading slash) so the gateway's base path
				// (https://llm.kimchi.dev/openai/v1) is preserved.
				new URL("chat/completions", options.baseURL.endsWith("/") ? options.baseURL : `${options.baseURL}/`),
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${options.apiKey}`,
					},
					body: JSON.stringify({
						model: options.model,
						// Deterministic extraction: needle facts must not appear or
						// disappear between runs of the same haystack (validated: the
						// gateway default temperature changed captured facts per run).
						temperature: 0,
						messages: [
							{ role: "system", content: system },
							{ role: "user", content: user },
						],
					}),
				},
			)
			if (response.ok) {
				const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
				const content = body.choices?.[0]?.message?.content
				if (typeof content !== "string") throw new Error("completion response has no message content")
				return content
			}
			if (response.status !== 429 && response.status < 500) {
				throw new Error(`gateway rejected the request: HTTP ${response.status}`)
			}
			lastError = new Error(`HTTP ${response.status}`)
			if (attempt < maxAttempts) {
				const retryAfter = Number(response.headers.get("retry-after"))
				await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt))
			}
		} catch (err) {
			lastError = err
			// Non-retryable gateway rejection — surface immediately.
			if (err instanceof Error && err.message.startsWith("gateway rejected")) throw err
			if (attempt < maxAttempts) await sleep(backoffMs(attempt))
		}
	}
	throw new Error(`gateway call failed after ${maxAttempts} attempts`, { cause: lastError })
}

function backoffMs(attempt: number): number {
	return Math.min(2 ** attempt * 1000, 30_000)
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

const EXTRACTION_SYSTEM_PROMPT = `You maintain the user's persistent memory store.
Extract durable facts about the user from the conversation snippet below.
Include: stable preferences (tools, workflow, style), decisions and their rationale, corrections of earlier statements, and personal context the user shares (role, projects, constraints).
ALWAYS extract itemized values as their own facts: counts ("I have 38 pre-1920 American coins"), prices and valuations ("the necklace appraised at $5,000"), assignments ("Admon covers the 8am-4pm Sunday shift"), dates and years, and measurements.
Exclude: transient task details, file or code contents, small talk, and anything only the assistant said.
Write each fact as a short self-contained sentence from the user's perspective. When a value CHANGES from one stated earlier, emit the updated fact explicitly stating the change ("I now have 38 pre-1920 coins, up from 37") — never silently keep the old value.
Respond with ONLY a JSON array of fact strings; [] when nothing durable appears.`

const SUPERSEDE_SYSTEM_PROMPT = `You maintain a memory store and must decide which stored memories a set of NEW facts replaces.
Rules: delete an existing memory only when a new fact explicitly changes, reverses, or updates it (same subject, different value). Complementary details are not replacements. When unsure, keep the old memory.
Respond with ONLY a JSON array of memory ids to delete; [] when nothing is replaced.`

/** Appended on retry when the model ignored the format (seen in the benchmark:
 * the model answered the session's question instead of following the format). */
const STRICT_JSON_RETRY_SUFFIX = `\n\nCRITICAL FORMAT REMINDER: Respond with ONLY a JSON array — no prose, no headings, no markdown, no code fences. The first character of your response must be "[" and the last must be "]".`

/** Parse a JSON array of string ids from a response (the supersede judge contract). */
export function parseIdArray(text: string): string[] {
	const start = text.indexOf("[")
	const end = text.lastIndexOf("]")
	if (start === -1 || end === -1 || end < start) throw new Error(`response has no JSON array: ${text.slice(0, 120)}`)
	const parsed: unknown = JSON.parse(text.slice(start, end + 1))
	if (!Array.isArray(parsed)) throw new Error("response is not an array")
	return parsed.filter((id): id is string => typeof id === "string")
}

/**
 * One chat call whose response must parse; an unparseable (prose) response
 * is retried once with the strict-format suffix before giving up. Bounded:
 * two attempts total, then the error propagates and the job stays for a
 * later retry.
 */
export async function chatWithRetry<T>(
	llm: GatewayLlmOptions,
	system: string,
	user: string,
	parse: (text: string) => T,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		const text = await chatJson(llm, attempt === 0 ? system : system + STRICT_JSON_RETRY_SUFFIX, user)
		try {
			return parse(text)
		} catch (err) {
			if (attempt >= 1) {
				throw new Error(`unparseable response after strict retry: ${text.slice(0, 120)}`, { cause: err })
			}
			console.error("[memory-capture] response not parseable, retrying with strict prompt:", text.slice(0, 80))
		}
	}
}

async function extractFacts(llm: GatewayLlmOptions, window: CaptureMessage[]): Promise<string[]> {
	const transcript = window.map((m) => `${m.role}: ${m.content}`).join("\n\n")
	return chatWithRetry(llm, EXTRACTION_SYSTEM_PROMPT, transcript, parseFactsResponse)
}

function hashesPath(dbPath: string): string {
	return join(dirname(dbPath), "captured-hashes.json")
}

function loadHashes(dbPath: string): Set<string> {
	const path = hashesPath(dbPath)
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"))
		if (!Array.isArray(parsed)) return new Set()
		return new Set(parsed.filter((item): item is string => typeof item === "string"))
	} catch {
		// Missing or corrupt file — start with an empty set (worst case:
		// duplicate extraction, never data loss).
		return new Set()
	}
}

function saveHashes(dbPath: string, hashes: Set<string>): void {
	const path = hashesPath(dbPath)
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify([...hashes], null, 0)}\n`, "utf-8")
	renameSync(tmp, path)
}

export interface RunCaptureWorkerOptions {
	/** Injectable for tests. */
	fetchImpl?: typeof fetch
	/** Injectable for tests — defaults to process.exit semantics via return value. */
}

/**
 * Worker entrypoint. Returns the number of newly captured facts.
 * Throws on unrecoverable errors — the caller (cli.ts routing) exits
 * nonzero and the job file remains for a later retry.
 */
export async function runCaptureWorker(argv: string[], options: RunCaptureWorkerOptions = {}): Promise<number> {
	disableMem0Telemetry()
	const jobIndex = argv.indexOf("--job")
	const dbIndex = argv.indexOf("--db")
	if (jobIndex === -1 || !argv[jobIndex + 1] || dbIndex === -1 || !argv[dbIndex + 1]) {
		throw new Error("usage: memory-capture --job <job-file> --db <memory.db>")
	}
	const jobFile = argv[jobIndex + 1]
	const dbPath = argv[dbIndex + 1]

	const job = JSON.parse(readFileSync(jobFile, "utf-8")) as CaptureJob
	if (!Array.isArray(job.messages)) throw new Error(`job file ${jobFile} has no messages array`)

	const hashes = loadHashes(dbPath)
	const fresh = job.messages.filter((m) => m.content.trim() && !hashes.has(messageHash(m)))
	if (fresh.length === 0) {
		rmSync(jobFile, { force: true })
		return 0
	}

	const backend = await createMemoryBackend({ dbPath })
	const searchAll = async (query: string) => {
		const results = await backend.search(query, { filters: { user_id: MEMORY_USER_ID }, topK: 5 })
		const list = (Array.isArray(results) ? results : (results?.results ?? [])) as Array<{
			id?: string
			memory?: string
			score?: number
		}>
		return list.filter(
			(r): r is { id: string; memory: string; score?: number } =>
				typeof r.id === "string" && typeof r.memory === "string",
		)
	}
	const config = (await import("../../config.js")).loadConfig()
	const llm = {
		baseURL: config.llmEndpoint,
		apiKey: config.apiKey,
		model: (await import("./backend.js")).MEMORY_EXTRACTION_MODEL,
		fetchImpl: options.fetchImpl,
	}

	let captured = 0
	for (const window of windowMessages(fresh)) {
		const facts = await extractFacts(llm, window)
		if (facts.length > 0) {
			const superseded = await findSupersededIds(
				facts,
				async (fact) => searchAll(fact),
				async (newFacts, candidates) => {
					const prompt = `NEW FACTS:\n${newFacts.map((f) => `- ${f}`).join("\n")}\n\nEXISTING MEMORIES:\n${candidates
						.map((c) => `${c.id}: ${c.memory}`)
						.join("\n")}`
					return chatWithRetry(llm, SUPERSEDE_SYSTEM_PROMPT, prompt, parseIdArray)
				},
			)
			for (const id of superseded) {
				await backend.delete(id)
			}
			for (const fact of facts) {
				await backend.add(fact, { userId: MEMORY_USER_ID, infer: false })
				captured += 1
			}
		}
		// Mark only after the window fully processes — a crash resumes here.
		for (const message of window) hashes.add(messageHash(message))
		saveHashes(dbPath, hashes)
	}

	rmSync(jobFile, { force: true })
	return captured
}

// Executed directly via `bun run .../capture-worker.ts` (dev spawn path).
if (import.meta.main) {
	runCaptureWorker(process.argv.slice(2))
		.then((captured) => {
			console.log(`[memory-capture] captured ${captured} facts`)
			process.exit(0)
		})
		.catch((err: unknown) => {
			console.error("[memory-capture] failed:", err instanceof Error ? err.message : err)
			process.exit(1)
		})
}
