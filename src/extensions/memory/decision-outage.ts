/**
 * Persist deferred supersession work and availability metadata across workers.
 * Short outages retain existing fail-open behavior; a sustained open circuit
 * pauses new extraction until the gate recovers instead of manufacturing facts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { defaultMemoryDir } from "./backend.js"
import { DECISION_OUTAGE_PAUSE_MS } from "./config.js"
import type { DecisionBreaker } from "./decision-gate.js"

export interface DeferredSupersedeRecord {
	newFacts: string[]
	/** Successfully cleaned prefix; legacy files omit it and start at zero. */
	completedPrefix: number
	deferredAt: number
	lastError?: string
}

export const DEFERRED_SUPERSEDE_BATCH_SIZE = 64

/** Default 64, optionally reduced to a smaller resumable pilot prefix. */
export function deferredSupersedeBatchSize(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.KIMCHI_MEMORY_DEFERRED_BATCH_SIZE
	if (!raw) return DEFERRED_SUPERSEDE_BATCH_SIZE
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed > 0
		? Math.min(DEFERRED_SUPERSEDE_BATCH_SIZE, Math.max(1, Math.floor(parsed)))
		: DEFERRED_SUPERSEDE_BATCH_SIZE
}

export function deferredSupersedePath(store: string, root = defaultMemoryDir()): string {
	return join(root, "deferred-supersede", `${store.replace(/[^a-z0-9_.-]/g, "_")}.json`)
}

export function readDeferredSupersede(store: string, root = defaultMemoryDir()): DeferredSupersedeRecord {
	const path = deferredSupersedePath(store, root)
	if (!existsSync(path)) return { newFacts: [], completedPrefix: 0, deferredAt: 0 }
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"))
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!Array.isArray((parsed as { newFacts?: unknown }).newFacts) ||
			typeof (parsed as { deferredAt?: unknown }).deferredAt !== "number" ||
			((parsed as { completedPrefix?: unknown }).completedPrefix !== undefined &&
				(!Number.isSafeInteger((parsed as { completedPrefix: number }).completedPrefix) ||
					(parsed as { completedPrefix: number }).completedPrefix < 0 ||
					(parsed as { completedPrefix: number }).completedPrefix >
						(parsed as { newFacts: unknown[] }).newFacts.length))
		) {
			console.error(`[memory-capture] invalid deferred supersede state, preserving it for review: ${path}`)
			quarantineCorruptDeferredState(path)
			return { newFacts: [], completedPrefix: 0, deferredAt: 0, lastError: "invalid-state" }
		}
		return {
			newFacts: (parsed as { newFacts: unknown[] }).newFacts.filter((fact): fact is string => typeof fact === "string"),
			completedPrefix: (parsed as { completedPrefix?: number }).completedPrefix ?? 0,
			deferredAt: (parsed as { deferredAt: number }).deferredAt,
			...(typeof (parsed as { lastError?: unknown }).lastError === "string"
				? { lastError: (parsed as { lastError: string }).lastError }
				: {}),
		}
	} catch (err) {
		console.error(
			`[memory-capture] deferred supersede state unreadable, keeping file for review: ${err instanceof Error ? err.message : err}`,
		)
		quarantineCorruptDeferredState(path)
		return { newFacts: [], completedPrefix: 0, deferredAt: 0, lastError: "unreadable-state" }
	}
}

/** Merge pending facts for a later recovery. Duplicate restatements collapse by text. */
export function deferSupersede(
	store: string,
	facts: readonly string[],
	root = defaultMemoryDir(),
	lastError?: string,
): void {
	if (facts.length === 0) return
	const existing = readDeferredSupersede(store, root)
	const newFacts = [...new Set([...existing.newFacts, ...facts])]
	const path = deferredSupersedePath(store, root)
	mkdirSync(join(path, ".."), { recursive: true })
	const record: DeferredSupersedeRecord = {
		newFacts,
		completedPrefix: Math.min(existing.completedPrefix, newFacts.length),
		deferredAt: existing.deferredAt || Date.now(),
		...(lastError ? { lastError } : {}),
	}
	writeDeferredSupersedeState(store, record, root)
}

/** Read at most one bounded cleanup prefix, preserving the order of remaining evidence. */
export function readDeferredSupersedeBatch(
	store: string,
	root = defaultMemoryDir(),
	limit = deferredSupersedeBatchSize(),
): { facts: string[]; cursor: number } {
	if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("deferred cleanup batch size must be positive")
	const record = readDeferredSupersede(store, root)
	return {
		facts: record.newFacts.slice(record.completedPrefix, record.completedPrefix + limit),
		cursor: record.completedPrefix,
	}
}

/** Advancing a prefix requires the whole batch to finish successfully. */
export function completeDeferredSupersedePrefix(store: string, count: number, root = defaultMemoryDir()): void {
	if (!Number.isSafeInteger(count) || count < 1) throw new Error("completed deferred cleanup count must be positive")
	const record = readDeferredSupersede(store, root)
	const completedPrefix = Math.min(record.completedPrefix + count, record.newFacts.length)
	if (completedPrefix === record.completedPrefix) return
	if (completedPrefix >= record.newFacts.length) {
		clearDeferredSupersede(store, root)
		return
	}
	writeDeferredSupersedeState(store, { ...record, completedPrefix }, root)
}

function writeDeferredSupersedeState(store: string, record: DeferredSupersedeRecord, root: string): void {
	const path = deferredSupersedePath(store, root)
	mkdirSync(join(path, ".."), { recursive: true })
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(record, null, 0)}\n`, "utf-8")
	renameSync(tmp, path)
}

export function clearDeferredSupersede(store: string, root = defaultMemoryDir()): void {
	const path = deferredSupersedePath(store, root)
	if (!existsSync(path)) return
	try {
		rmSync(path, { force: true })
	} catch (err) {
		console.error(
			`[memory-capture] unable to clear deferred supersede work (will retry): ${err instanceof Error ? err.message : err}`,
		)
	}
}

export const OUTAGE_DEFER_REASON = "d3-sustained-outage"

export function outageDeferralActive(breaker: DecisionBreaker, now = Date.now()): boolean {
	const snapshot = breaker.snapshot()
	return snapshot.open && now - snapshot.degradedAt >= DECISION_OUTAGE_PAUSE_MS
}

function quarantineCorruptDeferredState(path: string): void {
	try {
		// Do not leave a .json suffix: valid files under that suffix will be
		// parsed again and repeatedly quarantined on the next poll.
		const corrupt = `${path.replace(/\.json$/, "")}.corrupt-${Date.now()}.quarantined`
		renameSync(path, corrupt)
		console.error(`[memory-capture] quarantined corrupt deferred supersede state: ${corrupt}`)
	} catch (err) {
		console.error(
			`[memory-capture] could not quarantine corrupt deferred supersede state: ${err instanceof Error ? err.message : err}`,
		)
	}
}

export interface DeferredOutageSummary {
	degradedAt: number
	deferredSupersedes: number
	deferredStores: number
	invalidFiles: number
}

const summaryCache = new Map<string, { signature: string; value: DeferredOutageSummary | undefined }>()

/** Queue/degradation reporting is read-tolerant: malformed files are visible
 * but do not prevent the rest of the management overview from loading. The
 * complete filename+mtime fingerprint catches removal of an older store and
 * replacement of its latest file without false cache hits. */
export function deferredOutageSummary(root = defaultMemoryDir()): DeferredOutageSummary | undefined {
	const dir = join(root, "deferred-supersede")
	if (!existsSync(dir)) return undefined
	const prior = summaryCache.get(dir)
	try {
		const files = readdirSync(dir).filter((name) => name.endsWith(".json") || name.endsWith(".quarantined"))
		const signature = files
			.map((name) => `${name}:${statSync(join(dir, name)).mtimeMs}`)
			.sort()
			.join("|")
		if (prior?.signature === signature) return prior.value
		const value = computeDeferredOutageSummary(root, files)
		summaryCache.set(dir, { signature, value })
		return value
	} catch (err) {
		const code = err instanceof Error && "code" in err ? err.code : undefined
		if (code !== "ENOENT")
			console.warn(
				`[memory] deferred summary read failed; using the previous summary: ${err instanceof Error ? err.message : err}`,
			)
		return prior?.value
	}
}

function computeDeferredOutageSummary(root: string, files: readonly string[]): DeferredOutageSummary | undefined {
	let degradedAt = 0
	let deferredSupersedes = 0
	let deferredStores = 0
	let invalidFiles = files.filter((name) => name.endsWith(".quarantined")).length
	for (const name of files.filter((name) => name.endsWith(".json"))) {
		const record = readDeferredSupersede(name.slice(0, -5), root)
		if (record.lastError) {
			invalidFiles += 1
			continue
		}
		degradedAt = degradedAt === 0 ? record.deferredAt : Math.min(degradedAt, record.deferredAt)
		deferredSupersedes += record.newFacts.length
		deferredStores += 1
	}
	if (deferredSupersedes === 0 && invalidFiles === 0) return undefined
	return { degradedAt, deferredSupersedes, deferredStores, invalidFiles }
}
