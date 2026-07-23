export type RunFailureCode = "aborted" | "budget_exceeded" | "deadline_exceeded"

export interface RunBudgetLimits {
	overallTimeoutMs: number
	maxLogicalCalls: number
	maxPhysicalAttempts: number
	maxConcurrentCalls: number
	maxAggregateInputTokens: number
	maxAggregateOutputTokens: number
	maxEstimatedCostUsd: number
	maxEvidenceBytes: number
	maxStructuredBytes: number
}

export interface AttemptEstimate {
	inputTokens: number
	outputTokens: number
	costUsd: number
}

export interface RunBudgetSnapshot {
	logicalCalls: number
	physicalAttempts: number
	activeCalls: number
	peakConcurrentCalls: number
	inputTokens: number
	outputTokens: number
	estimatedCostUsd: number
	evidenceBytes: number
	structuredBytes: number
}

export interface RunBudgetAvailable {
	inputTokens: number
	outputTokens: number
	costUsd: number
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

export interface AttemptReservation {
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
	private estimatedCostUsd = 0
	private reservedInputTokens = 0
	private reservedOutputTokens = 0
	private reservedCostUsd = 0
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
			this.estimatedCostUsd = nonNegative(options.initialSnapshot.estimatedCostUsd)
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
		this.logicalCalls += 1
		if (this.logicalCalls > this.limits.maxLogicalCalls) this.exhaust("maxLogicalCalls")
	}

	reserveAttempt(estimate: AttemptEstimate): AttemptReservation {
		this.assertActive()
		const reserved = {
			inputTokens: nonNegative(estimate.inputTokens),
			outputTokens: nonNegative(estimate.outputTokens),
			costUsd: nonNegative(estimate.costUsd),
		}
		this.physicalAttempts += 1
		if (this.physicalAttempts > this.limits.maxPhysicalAttempts) this.exhaust("maxPhysicalAttempts")
		if (this.activeCalls + 1 > this.limits.maxConcurrentCalls) this.exhaust("maxConcurrentCalls")
		if (this.inputTokens + this.reservedInputTokens + reserved.inputTokens > this.limits.maxAggregateInputTokens) {
			this.exhaust("maxAggregateInputTokens")
		}
		if (this.outputTokens + this.reservedOutputTokens + reserved.outputTokens > this.limits.maxAggregateOutputTokens) {
			this.exhaust("maxAggregateOutputTokens")
		}
		if (this.estimatedCostUsd + this.reservedCostUsd + reserved.costUsd > this.limits.maxEstimatedCostUsd) {
			this.exhaust("maxEstimatedCostUsd")
		}
		this.activeCalls += 1
		this.peakConcurrentCalls = Math.max(this.peakConcurrentCalls, this.activeCalls)
		this.reservedInputTokens += reserved.inputTokens
		this.reservedOutputTokens += reserved.outputTokens
		this.reservedCostUsd += reserved.costUsd
		let settled = false
		const settle = (actual: AttemptEstimate): void => {
			if (settled) return
			settled = true
			this.activeCalls -= 1
			this.reservedInputTokens -= reserved.inputTokens
			this.reservedOutputTokens -= reserved.outputTokens
			this.reservedCostUsd -= reserved.costUsd
			this.inputTokens += nonNegative(actual.inputTokens)
			this.outputTokens += nonNegative(actual.outputTokens)
			this.estimatedCostUsd += nonNegative(actual.costUsd)
			this.checkReconciledLimits()
		}
		return {
			reconcile: settle,
			release: () => settle({ inputTokens: 0, outputTokens: 0, costUsd: 0 }),
		}
	}

	available(): RunBudgetAvailable {
		return {
			inputTokens: Math.max(0, this.limits.maxAggregateInputTokens - this.inputTokens - this.reservedInputTokens),
			outputTokens: Math.max(0, this.limits.maxAggregateOutputTokens - this.outputTokens - this.reservedOutputTokens),
			costUsd: Math.max(0, this.limits.maxEstimatedCostUsd - this.estimatedCostUsd - this.reservedCostUsd),
		}
	}

	reserveEvidence(bytes: number): void {
		this.assertActive()
		this.evidenceBytes += nonNegative(bytes)
		if (this.evidenceBytes > this.limits.maxEvidenceBytes) this.exhaust("maxEvidenceBytes")
	}

	reserveStructured(bytes: number): void {
		this.assertActive()
		this.structuredBytes += nonNegative(bytes)
		if (this.structuredBytes > this.limits.maxStructuredBytes) this.exhaust("maxStructuredBytes")
	}

	snapshot(): RunBudgetSnapshot {
		return {
			logicalCalls: this.logicalCalls,
			physicalAttempts: this.physicalAttempts,
			activeCalls: this.activeCalls,
			peakConcurrentCalls: this.peakConcurrentCalls,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			estimatedCostUsd: this.estimatedCostUsd,
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
		if (this.estimatedCostUsd > this.limits.maxEstimatedCostUsd) this.exhaust("maxEstimatedCostUsd")
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
