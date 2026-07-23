import { randomUUID } from "node:crypto"
import type { ApplyReceipt, ChangeSet } from "../../agent-patch/index.js"
import { ChangeTransaction } from "../../agent-patch/index.js"
import type { RunBudgetLimits, RunBudgetSnapshot } from "./run-context.js"
import type { CouncilTransactionSnapshot } from "./types.js"

export interface CouncilTransactionLimits {
	maxFiles: number
	maxChangedLines: number
	maxPatchBytes: number
}

export const DEFAULT_COUNCIL_TRANSACTION_LIMITS: CouncilTransactionLimits = {
	maxFiles: 64,
	maxChangedLines: 12_000,
	maxPatchBytes: 512 * 1024,
}

interface AcceptanceCapability {
	token: string
	transactionId: string
	patchSha256: string
	used: boolean
}

interface SettlementCapability {
	token: string
	transactionId: string
	patchSha256: string
	used: boolean
}

export interface CouncilPromotionRequest {
	token: string
	transactionId: string
	patchSha256: string
}

export interface CouncilSettlementRequest extends CouncilPromotionRequest {
	action: "finalize" | "rollback"
}

export interface CouncilPostApplyCheck {
	toolName: string
	command: string
	ok: boolean
}

export interface CouncilRunBudgetState {
	limits: RunBudgetLimits
	startedAt: number
	deadlineAt: number
	snapshot: RunBudgetSnapshot
}

export interface CouncilRevisionObligation {
	id: string
	kind: "finding" | "requirement" | "missing_evidence"
	statement: string
	severity?: "critical" | "high"
}

export interface CouncilRevisionGate {
	reviewedPatchSha256: string
	obligations: CouncilRevisionObligation[]
}

export class CouncilTransactionRuntime {
	private transaction?: ChangeTransaction
	private acceptance?: AcceptanceCapability
	private settlement?: SettlementCapability
	private settlementEmitted = false
	private postApplyChecks: CouncilPostApplyCheck[] = []
	private requiredPostApplyChecks: string[] = []
	private revisionGate?: CouncilRevisionGate
	private runBudget?: CouncilRunBudgetState
	private reviewedResponse?: string
	private agreement?: "low" | "medium" | "high"
	private lastChangeSet?: ChangeSet
	private baseVerification: CouncilTransactionSnapshot["baseVerification"] = "not_run"
	private fullReviewCount = 0
	private revisionCount = 0
	private finalCheckCount = 0

	constructor(
		private readonly cwd: string,
		private readonly limits: CouncilTransactionLimits = DEFAULT_COUNCIL_TRANSACTION_LIMITS,
	) {}

	get current(): ChangeTransaction | undefined {
		return this.transaction
	}

	get hasStagedChanges(): boolean {
		return this.transaction?.hasChanges ?? false
	}

	get state(): ChangeTransaction["state"] | "idle" {
		return this.transaction?.state ?? "idle"
	}

	get checks(): readonly CouncilPostApplyCheck[] {
		return this.postApplyChecks
	}

	get pendingPostApplyCheck(): string | undefined {
		return this.requiredPostApplyChecks.find(
			(required) => !this.postApplyChecks.some(({ command, ok }) => ok && command === required),
		)
	}

	get postApplyChecksComplete(): boolean {
		if (this.postApplyChecks.some(({ ok }) => !ok)) return true
		if (this.requiredPostApplyChecks.length === 0) return this.postApplyChecks.length > 0
		return this.pendingPostApplyCheck === undefined
	}

	get postApplyChecksPassed(): boolean {
		return this.postApplyChecksComplete && this.postApplyChecks.every(({ ok }) => ok)
	}

	get savedRunBudget(): CouncilRunBudgetState | undefined {
		return this.runBudget ? structuredClone(this.runBudget) : undefined
	}

	get acceptedResponse(): string | undefined {
		return this.reviewedResponse
	}

	get reviewAgreement(): "low" | "medium" | "high" | undefined {
		return this.agreement
	}

	get pendingRevisionGate(): CouncilRevisionGate | undefined {
		return this.revisionGate ? structuredClone(this.revisionGate) : undefined
	}

	snapshot(): CouncilTransactionSnapshot | undefined {
		const transaction = this.transaction
		if (!transaction) return undefined
		const changeSet = transaction.hasChanges ? transaction.changeSet() : this.lastChangeSet
		const state = transaction.state
		return {
			transactionId: transaction.id,
			state,
			outcome: this.outcome(state),
			patchSha256: changeSet?.patchSha256,
			stats: changeSet ? { ...changeSet.stats } : undefined,
			baseVerification: this.baseVerification,
			revisionCount: this.revisionCount,
			postApplyChecks: this.postApplyChecks.map(({ toolName, ok }) => ({ toolName, ok })),
			rollbackState:
				state === "post_apply_checks"
					? "available"
					: state === "rolled_back"
						? "completed"
						: state === "hard_recovery"
							? "failed"
							: "not_available",
			hardRecoveryRequired: state === "hard_recovery",
		}
	}

	ensure(cwd = this.cwd): ChangeTransaction {
		if (cwd !== this.cwd) throw new Error("Council transaction workspace changed during the session")
		if (!this.transaction || this.isSafeTerminal(this.transaction.state)) {
			this.transaction = new ChangeTransaction(this.cwd)
			this.acceptance = undefined
			this.settlement = undefined
			this.settlementEmitted = false
			this.postApplyChecks = []
			this.requiredPostApplyChecks = []
			this.revisionGate = undefined
			this.reviewedResponse = undefined
			this.agreement = undefined
			this.lastChangeSet = undefined
			this.baseVerification = "not_run"
			this.fullReviewCount = 0
			this.revisionCount = 0
			this.finalCheckCount = 0
		}
		return this.transaction
	}

	async resetForNewTurn(): Promise<void> {
		try {
			await this.abandon()
		} finally {
			this.resetRunBudget()
		}
		if (this.transaction && this.isSafeTerminal(this.transaction.state)) {
			this.transaction = undefined
			this.ensure()
		}
	}

	propose(): ChangeSet {
		const changeSet = this.ensure().propose()
		this.assertWithinLimits(changeSet)
		this.lastChangeSet = changeSet
		return changeSet
	}

	markFullReview(): void {
		if (this.fullReviewCount >= 1) throw new Error("Council transaction already received its one full review")
		this.fullReviewCount++
	}

	setRevisionGate(reviewedPatchSha256: string, obligations: CouncilRevisionObligation[]): void {
		if (this.revisionGate) throw new Error("Council transaction revision gate is already set")
		this.revisionGate = { reviewedPatchSha256, obligations: structuredClone(obligations) }
	}

	reopenForRevision(expectedPatchSha256: string): void {
		if (this.revisionCount >= 1) throw new Error("Council transaction permits only one lead revision")
		this.requireCurrent().reopenForRevision(expectedPatchSha256)
		this.revisionCount++
		this.acceptance = undefined
		this.reviewedResponse = undefined
	}

	markFinalCheck(): CouncilRevisionGate {
		if (!this.revisionGate) throw new Error("Council transaction has no revision obligations")
		if (this.finalCheckCount >= 1) throw new Error("Council transaction permits only one focused final check")
		this.finalCheckCount++
		return structuredClone(this.revisionGate)
	}

	clearRevisionGate(): void {
		this.revisionGate = undefined
	}

	setRequiredPostApplyChecks(commands: string[]): void {
		if (!["proposed", "revision"].includes(this.state)) {
			throw new Error(`Council cannot set post-apply checks while ${this.state}`)
		}
		const normalized = [...new Set(commands.map((command) => command.trim()).filter(Boolean))]
		if (normalized.length > 3) throw new Error("Council permits at most three required post-apply checks")
		this.requiredPostApplyChecks = normalized
	}

	setReviewAgreement(agreement: "low" | "medium" | "high"): void {
		if (!["proposed", "revision"].includes(this.state)) {
			throw new Error(`Council cannot set review agreement while ${this.state}`)
		}
		this.agreement = agreement
	}

	saveRunBudget(state: CouncilRunBudgetState): void {
		this.runBudget = structuredClone(state)
	}

	resetRunBudget(): void {
		this.runBudget = undefined
	}

	accept(expectedPatchSha256: string, reviewedResponse?: string): CouncilPromotionRequest {
		const transaction = this.requireCurrent()
		transaction.accept(expectedPatchSha256)
		if (reviewedResponse !== undefined) {
			const normalized = reviewedResponse.trim()
			if (!normalized) throw new Error("Council reviewed response must not be empty")
			this.reviewedResponse = normalized
		}
		const capability: AcceptanceCapability = {
			token: randomUUID(),
			transactionId: transaction.id,
			patchSha256: expectedPatchSha256,
			used: false,
		}
		this.acceptance = capability
		return this.publicCapability(capability)
	}

	promotionRequest(): CouncilPromotionRequest | undefined {
		if (!this.acceptance || this.acceptance.used) return undefined
		return this.publicCapability(this.acceptance)
	}

	async apply(request: CouncilPromotionRequest): Promise<ApplyReceipt> {
		const capability = this.acceptance
		if (
			!capability ||
			capability.used ||
			capability.token !== request.token ||
			capability.transactionId !== request.transactionId ||
			capability.patchSha256 !== request.patchSha256
		) {
			throw new Error("Council apply capability is invalid or already consumed")
		}
		capability.used = true
		let receipt: ApplyReceipt
		try {
			receipt = await this.requireCurrent().applyExact(request.patchSha256)
			this.baseVerification = "passed"
		} catch (error) {
			this.baseVerification = this.state === "failed" ? "failed" : "passed"
			throw error
		}
		this.settlement = {
			token: randomUUID(),
			transactionId: request.transactionId,
			patchSha256: request.patchSha256,
			used: false,
		}
		this.settlementEmitted = false
		this.postApplyChecks = []
		return receipt
	}

	recordPostApplyCheck(toolName: string, command: string, ok: boolean): void {
		if (this.state !== "post_apply_checks") return
		this.postApplyChecks.push({ toolName, command: command.trim(), ok })
	}

	settlementRequest(action: "finalize" | "rollback"): CouncilSettlementRequest | undefined {
		if (!this.settlement || this.settlement.used || this.settlementEmitted) return undefined
		this.settlementEmitted = true
		return { ...this.publicCapability(this.settlement), action }
	}

	async settle(request: CouncilSettlementRequest): Promise<void> {
		const capability = this.settlement
		if (
			!capability ||
			capability.used ||
			capability.token !== request.token ||
			capability.transactionId !== request.transactionId ||
			capability.patchSha256 !== request.patchSha256
		) {
			throw new Error("Council settlement capability is invalid or already consumed")
		}
		capability.used = true
		if (request.action === "finalize") await this.requireCurrent().finalizeApplied()
		else await this.requireCurrent().rollbackApplied()
	}

	async abandon(): Promise<void> {
		if (!this.transaction) return
		if (this.transaction.hasChanges) this.lastChangeSet = this.transaction.changeSet()
		if (this.transaction.state === "post_apply_checks") await this.transaction.rollbackApplied()
		else if (!this.isTerminal(this.transaction.state)) await this.transaction.discard()
		this.acceptance = undefined
		this.settlement = undefined
		this.settlementEmitted = false
		this.revisionGate = undefined
		this.reviewedResponse = undefined
		this.agreement = undefined
	}

	private requireCurrent(): ChangeTransaction {
		if (!this.transaction) throw new Error("Council transaction is unavailable")
		return this.transaction
	}

	private assertWithinLimits(changeSet: ChangeSet): void {
		const changedLines = changeSet.stats.addedLines + changeSet.stats.removedLines
		if (changeSet.stats.files > this.limits.maxFiles) {
			throw new Error(`Council candidate exceeds the ${this.limits.maxFiles}-file transaction limit`)
		}
		if (changedLines > this.limits.maxChangedLines) {
			throw new Error(`Council candidate exceeds the ${this.limits.maxChangedLines}-line transaction limit`)
		}
		if (changeSet.stats.patchBytes > this.limits.maxPatchBytes) {
			throw new Error(`Council candidate exceeds the ${this.limits.maxPatchBytes}-byte transaction limit`)
		}
	}

	private publicCapability(capability: AcceptanceCapability | SettlementCapability): CouncilPromotionRequest {
		return {
			token: capability.token,
			transactionId: capability.transactionId,
			patchSha256: capability.patchSha256,
		}
	}

	private isTerminal(state: ChangeTransaction["state"]): boolean {
		return this.isSafeTerminal(state) || state === "hard_recovery"
	}

	private isSafeTerminal(state: ChangeTransaction["state"]): boolean {
		return ["applied", "discarded", "rolled_back", "failed"].includes(state)
	}

	private outcome(state: ChangeTransaction["state"]): CouncilTransactionSnapshot["outcome"] {
		if (this.isTerminal(state)) return state as CouncilTransactionSnapshot["outcome"]
		return "pending"
	}
}
