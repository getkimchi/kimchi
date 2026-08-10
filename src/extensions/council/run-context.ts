import { createHash } from "node:crypto"
import type { Usage } from "@earendil-works/pi-ai"
import { PhysicalInvocationError } from "./physical-invoker.js"
import type {
	CouncilBudgetUsage,
	CouncilDegradedReason,
	CouncilRole,
	CouncilRunRecord,
	CouncilSchemaErrorCode,
	CouncilTransactionSnapshot,
	SafeCouncilFailureReason,
} from "./schemas.js"

type RunFailureCode = "aborted" | "budget_exceeded" | "deadline_exceeded"

export interface RunBudgetLimits {
	overallTimeoutMs: number
	maxLogicalCalls: number
	maxPhysicalAttempts: number
	maxConcurrentCalls: number
	maxAggregateInputTokens: number
	maxAggregateOutputTokens: number
	maxEvidenceBytes: number
	maxStructuredBytes: number
}

interface AttemptEstimate {
	inputTokens: number
	outputTokens: number
}

export interface RunBudgetSnapshot {
	logicalCalls: number
	physicalAttempts: number
	activeCalls: number
	peakConcurrentCalls: number
	inputTokens: number
	outputTokens: number
	evidenceBytes: number
	structuredBytes: number
}

interface RunBudgetAvailable {
	inputTokens: number
	outputTokens: number
}

export class RunFailure extends Error {
	constructor(
		readonly code: RunFailureCode,
		message: string,
		readonly limit?: keyof RunBudgetLimits,
	) {
		super(message)
		this.name = "RunFailure"
	}
}

interface AttemptReservation {
	reconcile(actual: AttemptEstimate): void
	release(): void
}

function nonNegative(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0
}

export class CouncilRunContext {
	readonly signal: AbortSignal
	readonly startedAt: number
	readonly deadlineAt: number

	private readonly controller = new AbortController()
	private readonly callerSignal?: AbortSignal
	private readonly callerAbort: () => void
	private readonly deadlineTimer?: ReturnType<typeof setTimeout>
	private failure?: RunFailure
	private closed = false
	private logicalCalls = 0
	private physicalAttempts = 0
	private activeCalls = 0
	private peakConcurrentCalls = 0
	private inputTokens = 0
	private outputTokens = 0
	private reservedInputTokens = 0
	private reservedOutputTokens = 0
	private evidenceBytes = 0
	private structuredBytes = 0

	constructor(
		readonly limits: RunBudgetLimits,
		options: {
			callerSignal?: AbortSignal
			callerTimeoutMs?: number
			now?: number
			startedAt?: number
			deadlineAt?: number
			initialSnapshot?: RunBudgetSnapshot
		} = {},
	) {
		const now = options.now ?? Date.now()
		this.startedAt = options.startedAt ?? now
		const callerTimeout = options.callerTimeoutMs && options.callerTimeoutMs > 0 ? options.callerTimeoutMs : Infinity
		const timeoutMs = Math.max(1, Math.min(limits.overallTimeoutMs, callerTimeout))
		this.deadlineAt = Math.min(options.deadlineAt ?? Infinity, this.startedAt + timeoutMs)
		if (options.initialSnapshot) {
			this.logicalCalls = nonNegative(options.initialSnapshot.logicalCalls)
			this.physicalAttempts = nonNegative(options.initialSnapshot.physicalAttempts)
			this.peakConcurrentCalls = nonNegative(options.initialSnapshot.peakConcurrentCalls)
			this.inputTokens = nonNegative(options.initialSnapshot.inputTokens)
			this.outputTokens = nonNegative(options.initialSnapshot.outputTokens)
			this.evidenceBytes = nonNegative(options.initialSnapshot.evidenceBytes)
			this.structuredBytes = nonNegative(options.initialSnapshot.structuredBytes)
		}
		this.signal = this.controller.signal
		this.callerSignal = options.callerSignal
		this.callerAbort = () => this.abort(new RunFailure("aborted", "Council request aborted by caller"))
		this.callerSignal?.addEventListener("abort", this.callerAbort, { once: true })
		if (this.callerSignal?.aborted) this.callerAbort()
		const remainingMs = this.deadlineAt - now
		if (remainingMs <= 0) {
			this.abort(new RunFailure("deadline_exceeded", "Council whole-run deadline exceeded"))
		} else {
			this.deadlineTimer = setTimeout(
				() => this.abort(new RunFailure("deadline_exceeded", "Council whole-run deadline exceeded")),
				remainingMs,
			)
		}
	}

	remainingMs(stageLimitMs: number): number {
		this.assertActive()
		const remaining = this.deadlineAt - Date.now()
		if (remaining <= 0) {
			const failure = new RunFailure("deadline_exceeded", "Council whole-run deadline exceeded")
			this.abort(failure)
			throw failure
		}
		return Math.max(1, Math.min(stageLimitMs, remaining))
	}

	beginLogicalCall(): void {
		this.assertActive()
		if (this.logicalCalls + 1 > this.limits.maxLogicalCalls) this.exhaust("maxLogicalCalls")
		this.logicalCalls += 1
	}

	reserveAttempt(estimate: AttemptEstimate): AttemptReservation {
		this.assertActive()
		const reserved = {
			inputTokens: nonNegative(estimate.inputTokens),
			outputTokens: nonNegative(estimate.outputTokens),
		}
		if (this.physicalAttempts + 1 > this.limits.maxPhysicalAttempts) this.exhaust("maxPhysicalAttempts")
		if (this.activeCalls + 1 > this.limits.maxConcurrentCalls) this.exhaust("maxConcurrentCalls")
		if (this.inputTokens + this.reservedInputTokens + reserved.inputTokens > this.limits.maxAggregateInputTokens) {
			this.exhaust("maxAggregateInputTokens")
		}
		if (this.outputTokens + this.reservedOutputTokens + reserved.outputTokens > this.limits.maxAggregateOutputTokens) {
			this.exhaust("maxAggregateOutputTokens")
		}
		this.physicalAttempts += 1
		this.activeCalls += 1
		this.peakConcurrentCalls = Math.max(this.peakConcurrentCalls, this.activeCalls)
		this.reservedInputTokens += reserved.inputTokens
		this.reservedOutputTokens += reserved.outputTokens
		let settled = false
		const settle = (actual: AttemptEstimate): void => {
			if (settled) return
			settled = true
			this.activeCalls -= 1
			this.reservedInputTokens -= reserved.inputTokens
			this.reservedOutputTokens -= reserved.outputTokens
			this.inputTokens += nonNegative(actual.inputTokens)
			this.outputTokens += nonNegative(actual.outputTokens)
			this.checkReconciledLimits()
		}
		return {
			reconcile: settle,
			release: () => settle({ inputTokens: 0, outputTokens: 0 }),
		}
	}

	available(): RunBudgetAvailable {
		return {
			inputTokens: Math.max(0, this.limits.maxAggregateInputTokens - this.inputTokens - this.reservedInputTokens),
			outputTokens: Math.max(0, this.limits.maxAggregateOutputTokens - this.outputTokens - this.reservedOutputTokens),
		}
	}

	reserveEvidence(bytes: number): void {
		this.assertActive()
		const next = nonNegative(bytes)
		if (next > this.limits.maxEvidenceBytes) this.exhaust("maxEvidenceBytes")
		this.evidenceBytes = Math.max(this.evidenceBytes, next)
	}

	reserveStructured(bytes: number): void {
		this.assertActive()
		const next = this.structuredBytes + nonNegative(bytes)
		if (next > this.limits.maxStructuredBytes) this.exhaust("maxStructuredBytes")
		this.structuredBytes = next
	}

	snapshot(): RunBudgetSnapshot {
		return {
			logicalCalls: this.logicalCalls,
			physicalAttempts: this.physicalAttempts,
			activeCalls: this.activeCalls,
			peakConcurrentCalls: this.peakConcurrentCalls,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			evidenceBytes: this.evidenceBytes,
			structuredBytes: this.structuredBytes,
		}
	}

	throwIfAborted(): void {
		this.assertActive()
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		clearTimeout(this.deadlineTimer)
		this.callerSignal?.removeEventListener("abort", this.callerAbort)
	}

	private checkReconciledLimits(): void {
		if (this.inputTokens > this.limits.maxAggregateInputTokens) this.exhaust("maxAggregateInputTokens")
		if (this.outputTokens > this.limits.maxAggregateOutputTokens) this.exhaust("maxAggregateOutputTokens")
	}

	private assertActive(): void {
		if (this.failure) throw this.failure
		if (this.closed) throw new RunFailure("aborted", "Council run is closed")
	}

	private exhaust(limit: keyof RunBudgetLimits): never {
		const failure = new RunFailure("budget_exceeded", `Council run budget exceeded: ${limit}`, limit)
		this.abort(failure)
		throw failure
	}

	private abort(failure: RunFailure): void {
		if (this.failure) return
		this.failure = failure
		this.controller.abort(failure)
	}
}

export interface CouncilCacheKey {
	patchHash: string
	baseSnapshotHash: string
	objectiveHash: string
	constraintsHash: string
	evidenceHash: string
	role: string
	modelId: string
	promptVersion: string
	schemaVersion: string
}

interface CouncilCacheStats {
	hits: number
	misses: number
	entries: number
	bytes: number
}

type CacheKind = "packet" | "result"

interface CacheEntry {
	value: unknown
	bytes: number
}

const DEFAULT_MAX_ENTRIES = 24
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024

export function hashCouncilCacheValue(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function cacheId(kind: CacheKind, key: CouncilCacheKey): string {
	return JSON.stringify([
		kind,
		key.patchHash,
		key.baseSnapshotHash,
		key.objectiveHash,
		key.constraintsHash,
		key.evidenceHash,
		key.role,
		key.modelId,
		key.promptVersion,
		key.schemaVersion,
	])
}

export class CouncilSessionCache {
	private readonly entries = new Map<string, CacheEntry>()
	private hits = 0
	private misses = 0
	private bytes = 0

	constructor(
		private readonly maxEntries = DEFAULT_MAX_ENTRIES,
		private readonly maxBytes = DEFAULT_MAX_BYTES,
		private readonly maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
	) {}

	getPacket<T>(key: CouncilCacheKey): T | undefined {
		return this.get("packet", key)
	}

	getResult<T>(key: CouncilCacheKey): T | undefined {
		return this.get("result", key)
	}

	setPacket(key: CouncilCacheKey, value: unknown): boolean {
		return this.set("packet", key, value)
	}

	setResult<T>(key: CouncilCacheKey, value: T, validate: (value: unknown) => boolean): boolean {
		if (!validate(value)) return false
		return this.set("result", key, value)
	}

	private get<T>(kind: CacheKind, key: CouncilCacheKey): T | undefined {
		const id = cacheId(kind, key)
		const entry = this.entries.get(id)
		if (!entry) {
			this.misses++
			return undefined
		}
		this.hits++
		this.entries.delete(id)
		this.entries.set(id, entry)
		return structuredClone(entry.value) as T
	}

	private set(kind: CacheKind, key: CouncilCacheKey, value: unknown): boolean {
		const serialized = JSON.stringify(value)
		const bytes = Buffer.byteLength(serialized)
		if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return false
		const id = cacheId(kind, key)
		const previous = this.entries.get(id)
		if (previous) {
			this.bytes -= previous.bytes
			this.entries.delete(id)
		}
		while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
			const oldest = this.entries.keys().next().value
			if (typeof oldest !== "string") break
			const evicted = this.entries.get(oldest)
			if (evicted) this.bytes -= evicted.bytes
			this.entries.delete(oldest)
		}
		this.entries.set(id, { value: JSON.parse(serialized), bytes })
		this.bytes += bytes
		return true
	}

	snapshot(): CouncilCacheStats {
		return { hits: this.hits, misses: this.misses, entries: this.entries.size, bytes: this.bytes }
	}
}

export function cacheStatsDelta(before: CouncilCacheStats, after: CouncilCacheStats): CouncilCacheStats {
	return {
		hits: Math.max(0, after.hits - before.hits),
		misses: Math.max(0, after.misses - before.misses),
		entries: after.entries,
		bytes: after.bytes,
	}
}

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const SAFE_STAGE_ERRORS = new Set([
	"aborted",
	"auth_failed",
	"budget_exceeded",
	"deadline_exceeded",
	"invalid_output",
	"model_incompatible",
	"model_not_found",
	"output_limit",
	"provider_error",
	"timeout",
])
const SAFE_SCHEMA_ERROR_CODES: ReadonlySet<CouncilSchemaErrorCode> = new Set([
	"missing_json",
	"ambiguous_json",
	"invalid_json",
	"invalid_shape",
	"unsupported_reference",
])

export function addUsage(total: Usage, next: Usage): Usage {
	return {
		input: total.input + next.input,
		output: total.output + next.output,
		cacheRead: total.cacheRead + next.cacheRead,
		cacheWrite: total.cacheWrite + next.cacheWrite,
		cacheWrite1h: (total.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0),
		totalTokens: total.totalTokens + next.totalTokens,
		cost: {
			input: total.cost.input + next.cost.input,
			output: total.cost.output + next.cost.output,
			cacheRead: total.cost.cacheRead + next.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
			total: total.cost.total + next.cost.total,
		},
	}
}

export function toCouncilBudgetUsage(
	snapshot: RunBudgetSnapshot,
	cache: Pick<CouncilCacheStats, "hits" | "misses"> = { hits: 0, misses: 0 },
): CouncilBudgetUsage {
	return {
		logicalCalls: snapshot.logicalCalls,
		physicalAttempts: snapshot.physicalAttempts,
		maxObservedConcurrency: snapshot.peakConcurrentCalls,
		aggregateInputTokens: snapshot.inputTokens,
		aggregateOutputTokens: snapshot.outputTokens,
		evidenceBytes: snapshot.evidenceBytes,
		structuredBytes: snapshot.structuredBytes,
		cacheHits: cache.hits,
		cacheMisses: cache.misses,
	}
}

export function sanitizeRunRecord(record: CouncilRunRecord): CouncilRunRecord {
	return {
		...record,
		stages: record.stages.map((stage) => ({
			...stage,
			...(stage.error ? { error: SAFE_STAGE_ERRORS.has(stage.error) ? stage.error : "unknown" } : {}),
			...(stage.schemaErrorCode
				? { schemaErrorCode: SAFE_SCHEMA_ERROR_CODES.has(stage.schemaErrorCode) ? stage.schemaErrorCode : undefined }
				: {}),
		})),
		transaction: record.transaction ? sanitizeCouncilTransactionSnapshot(record.transaction) : undefined,
	}
}

export function safeFailureReason(error: unknown, role?: CouncilRole): SafeCouncilFailureReason {
	const code = error instanceof RunFailure || error instanceof PhysicalInvocationError ? error.code : undefined
	if (code === "aborted") return "cancelled"
	if (code === "timeout" || code === "deadline_exceeded") return "timed_out"
	if (code === "budget_exceeded") return "limit_reached"
	if (role === "solver" || role === "analyst" || role === "repair") {
		return "panel_unavailable"
	}
	return "validation_failed"
}

export function safeDegradedReason(reason: CouncilDegradedReason | undefined): SafeCouncilFailureReason {
	if (reason === "deadline_exceeded") return "timed_out"
	if (reason === "budget_exhausted" || reason === "budget_exceeded") return "limit_reached"
	if (reason === "panel_unavailable" || reason === "analyst_failed") {
		return "panel_unavailable"
	}
	return "validation_failed"
}

export function sanitizeCouncilTransactionSnapshot(
	transaction: CouncilTransactionSnapshot,
): CouncilTransactionSnapshot {
	return {
		transactionId: transaction.transactionId,
		state: transaction.state,
		outcome: transaction.outcome,
		patchSha256: transaction.patchSha256,
		stats: transaction.stats ? { ...transaction.stats } : undefined,
		baseVerification: transaction.baseVerification,
		selectedValidationCheckIds: [...transaction.selectedValidationCheckIds],
		postApplyChecks: transaction.postApplyChecks.map((check) => ({
			...check,
			command: `sha256:${createHash("sha256").update(check.command).digest("hex")}`,
		})),
		rollbackState: transaction.rollbackState,
		hardRecoveryRequired: transaction.hardRecoveryRequired,
	}
}
