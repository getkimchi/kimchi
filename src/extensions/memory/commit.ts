/**
 * Shared commit-visible state: per-store dedupe snapshots and the captured
 * message hash ledger. A view is loaded once per store per drain wave, then
 * mutated in job order by the existing commit pipeline. This replaces each
 * job independently re-reading the full store/ledger and racing other jobs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { defaultMemoryDir } from "./backend.js"
import { type CaptureJobStore, getCaptureJobStore } from "./capture-jobs.js"
import { MEMORY_USER_ID } from "./config.js"
import { sqliteLedgerEnabled } from "./flags.js"
import type { MemoryMetadata } from "./metadata.js"
import { elapsedRequestMs, requestErrorStatus, timedStoreCall } from "./timing.js"
import type { TraceRecorder } from "./trace.js"

/** Store operations used by capture workers and commit-view loaders. */
export interface CaptureBackend {
	add(fact: string, options: { userId: string; infer: boolean; metadata?: MemoryMetadata }): Promise<unknown>
	delete(id: string): Promise<unknown>
	getAll(config: {
		filters: { user_id: string }
	}): Promise<{ results: Array<{ id: string; memory: string; metadata?: unknown }> }>
	search(query: string, config: { filters: { user_id: string }; topK: number }): Promise<unknown>
}

export interface CommitStoreView {
	/** Normalized text for exact duplicate detection. */
	texts: Set<string>
	/** Normalized text/token sets for attributed near-duplicate checks. */
	entries: Array<{ text: string; tokens: Set<string> }>
	/** Original stored texts, in store order, for valuation context. */
	rawTexts: string[]
}

/** Normalized comparison key for exact duplicate detection. */
export function normalizeFactText(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase()
}

const FACT_STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"of",
	"to",
	"for",
	"in",
	"on",
	"at",
	"by",
	"is",
	"are",
	"was",
	"were",
	"its",
	"this",
	"that",
	"these",
	"those",
	"i",
	"me",
	"my",
	"mine",
	"we",
	"us",
	"our",
	"ours",
	"you",
	"your",
	"they",
	"them",
	"their",
	"theirs",
	"he",
	"him",
	"his",
	"she",
	"her",
	"has",
	"have",
	"had",
	"do",
	"does",
	"did",
	"not",
	"no",
	"so",
	"if",
	"then",
	"else",
	"which",
	"who",
	"whom",
	"whose",
	"what",
	"when",
	"where",
	"why",
	"how",
	"about",
	"into",
	"over",
	"under",
	"up",
	"down",
	"than",
	"there",
	"here",
	"would",
	"could",
	"should",
	"will",
	"can",
	"may",
	"might",
	"must",
	"just",
	"only",
	"also",
	"even",
	"still",
	"already",
	"yet",
	"one",
	"two",
])

/** Lowercased alphanumeric tokens used by the attributed near-dup guard. */
export function factTokens(text: string): Set<string> {
	const tokens = new Set<string>()
	for (const match of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
		const token = match[0]
		if (token.length < 2 || FACT_STOPWORDS.has(token)) continue
		tokens.add(token)
	}
	return tokens
}

/** Load one full-store dedupe view, rather than one per job. On read failure,
 * preserve the existing fail-open behavior and return an empty view. */
export async function createCommitStoreView(
	backend: CaptureBackend,
	options?: { trace?: TraceRecorder | null; store?: string },
): Promise<CommitStoreView> {
	try {
		const { results } = await timedStoreCall(
			options?.trace,
			{ kind: "store-view", store: options?.store ?? "personal" },
			() => backend.getAll({ filters: { user_id: MEMORY_USER_ID } }),
		)
		const texts = new Set<string>()
		const entries: Array<{ text: string; tokens: Set<string> }> = []
		const rawTexts: string[] = []
		for (const item of results) {
			const normalized = normalizeFactText(item.memory)
			if (normalized.length === 0) continue
			texts.add(normalized)
			entries.push({ text: normalized, tokens: factTokens(normalized) })
			rawTexts.push(item.memory)
		}
		return { texts, entries, rawTexts }
	} catch (err) {
		console.error(
			"[memory-capture] duplicate guard unavailable, adding without dedupe:",
			err instanceof Error ? err.message : err,
		)
		return { texts: new Set(), entries: [], rawTexts: [] }
	}
}

/** Merge one newly committed fact into the shared store view. */
export function recordCommittedFact(view: CommitStoreView, fact: string): void {
	const normalized = normalizeFactText(fact)
	view.texts.add(normalized)
	view.entries.push({ text: normalized, tokens: factTokens(normalized) })
	view.rawTexts.push(fact)
}

function hashesPath(root = defaultMemoryDir()): string {
	return join(root, "captured-hashes.json")
}

/** Read the shared JSON ledger, including the one-time legacy path migration. */
export function loadCapturedHashes(root = defaultMemoryDir()): Set<string> {
	const path = hashesPath(root)
	const legacy = join(root, "personal", "captured-hashes.json")
	if (!existsSync(path) && existsSync(legacy)) {
		try {
			renameSync(legacy, path)
		} catch {
			// Failed migration falls back to an empty ledger; supersede bounds the
			// duplicate work, never destroys the source jobs.
		}
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"))
		if (!Array.isArray(parsed)) return new Set()
		const legacy = new Set(parsed.filter((item): item is string => typeof item === "string"))
		if (!sqliteLedgerEnabled()) return legacy
		return new Set([...legacy, ...getCaptureJobStore(root).hashes()])
	} catch {
		return new Set()
	}
}

/** Wave-scoped ledger. `mark()` is cheap and only changes memory; `save()`
 * merges and writes once at a commit checkpoint, with unique temp paths. */
export class CapturedHashLedger {
	private readonly hashes: Set<string>
	private readonly newHashes = new Set<string>()
	private readonly incrementalStore?: CaptureJobStore
	private readonly incrementalRoot: string
	private readonly trace?: TraceRecorder
	private writeCount = 0
	private dirty = false
	private snapshotDirty = false

	constructor(hashes: Set<string>, trace?: TraceRecorder | null, incrementalStore?: CaptureJobStore, root?: string) {
		if (incrementalStore && !root) throw new Error("incremental ledger mode requires an explicit store root")
		this.hashes = new Set(hashes)
		this.incrementalStore = incrementalStore
		this.incrementalRoot = root ?? defaultMemoryDir()
		this.trace = trace ?? undefined
	}

	mark(hashes: Iterable<string>): void {
		for (const hash of hashes) {
			if (this.hashes.has(hash)) continue
			this.newHashes.add(hash)
			this.hashes.add(hash)
			this.dirty = true
			this.snapshotDirty = true
		}
	}

	exportSnapshot(): void {
		if (!this.incrementalStore || !this.snapshotDirty) return
		const startedAt = performance.now()
		const path = hashesPath(this.incrementalRoot)
		try {
			const snapshot = new Set([...loadCapturedHashes(this.incrementalRoot), ...this.incrementalStore.hashes()])
			mkdirSync(dirname(path), { recursive: true })
			this.writeCount += 1
			const tmp = `${path}.${process.pid}-${this.writeCount}.tmp`
			writeFileSync(tmp, `${JSON.stringify([...snapshot], null, 0)}\n`, "utf-8")
			renameSync(tmp, path)
			this.snapshotDirty = false
			this.trace?.emit({
				type: "store_timing",
				kind: "ledger-export",
				status: "completed",
				durationMs: elapsedRequestMs(startedAt),
				entries: snapshot.size,
			})
		} catch (error) {
			this.trace?.emit({
				type: "store_timing",
				kind: "ledger-export",
				status: requestErrorStatus(error),
				durationMs: elapsedRequestMs(startedAt),
			})
			throw error
		}
	}

	save(): void {
		if (!this.dirty) return
		const startedAt = performance.now()
		if (this.incrementalStore) {
			try {
				this.incrementalStore.markHashes(this.newHashes)
				this.newHashes.clear()
				this.dirty = false
				this.trace?.emit({
					type: "store_timing",
					kind: "ledger-save",
					status: "completed",
					durationMs: elapsedRequestMs(startedAt),
					entries: this.hashes.size,
				})
				return
			} catch (error) {
				this.trace?.emit({
					type: "store_timing",
					kind: "ledger-save",
					status: requestErrorStatus(error),
					durationMs: elapsedRequestMs(startedAt),
				})
				throw error
			}
		}
		const path = hashesPath(this.incrementalRoot)
		try {
			mkdirSync(dirname(path), { recursive: true })
			for (const hash of loadCapturedHashes(this.incrementalRoot)) this.hashes.add(hash)
			this.writeCount += 1
			const tmp = `${path}.${process.pid}-${this.writeCount}.tmp`
			writeFileSync(tmp, `${JSON.stringify([...this.hashes], null, 0)}\n`, "utf-8")
			renameSync(tmp, path)
			this.trace?.emit({
				type: "store_timing",
				kind: "ledger-save",
				status: "completed",
				durationMs: elapsedRequestMs(startedAt),
				entries: this.hashes.size,
			})
		} catch (error) {
			this.trace?.emit({
				type: "store_timing",
				kind: "ledger-save",
				status: requestErrorStatus(error),
				durationMs: elapsedRequestMs(startedAt),
			})
			throw error
		}
	}
}
