import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai"
import { debugLog } from "./debug.js"
import type { CouncilRunContext } from "./run-context.js"
import type { CouncilTransactionRuntime } from "./transaction-runtime.js"
import { COUNCIL_APPLY_TOOL, COUNCIL_SETTLE_TOOL } from "./transaction-tools.js"
import type { CouncilDegradedReason } from "./types.js"

export interface ResumeDispatchContext {
	transaction: CouncilTransactionRuntime | undefined
	run: CouncilRunContext
	virtualModel: Model<Api>
	aggregate: Usage
	finish: (
		message: AssistantMessage,
		finalOutcome: "accepted" | "tool_use" | "degraded",
		reason?: CouncilDegradedReason,
	) => void
	fail: (
		errorMessage: string,
		aborted?: boolean,
		reason?: CouncilDegradedReason,
		progressReason?: import("./types.js").SafeCouncilFailureReason,
	) => void
	internalToolUse: (
		virtualModel: Model<Api>,
		usage: AssistantMessage["usage"],
		name: string,
		arguments_: Record<string, unknown>,
	) => AssistantMessage
	publicResponseMessage: (virtualModel: Model<Api>, text: string) => AssistantMessage
}

/**
 * Resumes an in-flight council transaction before the normal pipeline starts.
 * Returns `true` when the request was fully handled; otherwise returns `false` for the normal council pipeline.
 */
export async function dispatchResumedTransaction(ctx: ResumeDispatchContext): Promise<boolean> {
	const { transaction, run, virtualModel, aggregate, finish, fail, internalToolUse, publicResponseMessage } = ctx

	if (transaction?.state === "post_apply_checks") run.throwIfAborted()

	if (transaction?.state === "post_apply_checks" && transaction.postApplyChecksComplete) {
		const action = transaction.postApplyChecksPassed ? "finalize" : "rollback"
		const settlement = transaction.settlementRequest(action)
		if (!settlement) {
			const exhausted = transaction.settlementDeliveryExhausted
			debugLog(`settlement request denied while resuming transaction (action=${action}, exhausted=${exhausted})`)
			await transaction.abandon()
			fail(
				exhausted
					? "Council settlement could not be delivered after repeated attempts. The candidate patch was rolled back."
					: "Council settlement was not completed. The candidate patch was rolled back.",
			)
			return true
		}
		finish(
			internalToolUse(virtualModel, aggregate, COUNCIL_SETTLE_TOOL, {
				transaction_id: settlement.transactionId,
				patch_sha256: settlement.patchSha256,
				action: settlement.action,
			}),
			"tool_use",
		)
		return true
	}

	if (transaction?.state === "rolled_back") {
		debugLog("resuming a transaction that is already rolled back")
		fail("Council post-apply check failed. The candidate patch was rolled back.")
		return true
	}

	if (transaction?.state === "hard_recovery") {
		debugLog("resuming a transaction stuck in hard recovery")
		fail("Council could not safely restore the workspace. Manual recovery is required.")
		return true
	}

	if (transaction?.state === "post_apply_checks") {
		let validation: Awaited<ReturnType<CouncilTransactionRuntime["preparePostApplyCheck"]>>
		try {
			validation = await transaction.preparePostApplyCheck()
		} catch (error) {
			debugLog("preparePostApplyCheck failed while resuming transaction", error)
			validation = undefined
		}
		if (!validation) {
			const settlement = transaction.settlementRequest("rollback")
			if (!settlement) {
				const exhausted = transaction.settlementDeliveryExhausted
				debugLog(`rollback settlement request denied after failed post-apply preparation (exhausted=${exhausted})`)
				await transaction.abandon()
				fail(
					exhausted
						? "Council settlement could not be delivered after repeated attempts. The candidate patch was rolled back."
						: "Council could not prepare a deterministic post-apply check. The candidate patch was rolled back.",
				)
				return true
			}
			finish(
				internalToolUse(virtualModel, aggregate, COUNCIL_SETTLE_TOOL, {
					transaction_id: settlement.transactionId,
					patch_sha256: settlement.patchSha256,
					action: settlement.action,
				}),
				"tool_use",
			)
			return true
		}
		const validationTimeoutSeconds = run.remainingMs(validation.timeoutSeconds * 1_000) / 1_000
		finish(
			internalToolUse(virtualModel, aggregate, "bash", {
				command: validation.command,
				timeout: validationTimeoutSeconds,
				council_check_id: validation.id,
			}),
			"tool_use",
		)
		return true
	}

	if (transaction?.state === "applied") {
		const acceptedResponse = transaction.acceptedResponse
		if (!acceptedResponse) {
			debugLog("resumed an applied transaction with no accepted public response")
			fail("Council applied the candidate patch but its public response is unavailable.")
			return true
		}
		const degradedReason = transaction.acceptedDegradedReason
		const text =
			degradedReason === "no_validation_checks"
				? `${acceptedResponse}\n\nCouncil applied the patch without deterministic validation checks because none were available.`
				: acceptedResponse
		finish(publicResponseMessage(virtualModel, text), degradedReason ? "degraded" : "accepted", degradedReason)
		return true
	}

	if (transaction?.state === "accepted") {
		const request = transaction.applyRequest()
		if (!request) {
			const exhausted = transaction.applyDeliveryExhausted
			debugLog(`apply request denied while resuming transaction (exhausted=${exhausted})`)
			await transaction.abandon()
			fail(
				exhausted
					? "Council apply could not be delivered after repeated attempts. The candidate patch was discarded."
					: "Council did not apply the candidate patch.",
			)
			return true
		}
		finish(
			internalToolUse(virtualModel, aggregate, COUNCIL_APPLY_TOOL, {
				transaction_id: request.transactionId,
				patch_sha256: request.patchSha256,
			}),
			"tool_use",
		)
		return true
	}

	if (transaction?.state === "failed") {
		debugLog("resuming a transaction that never applied (transaction state=failed)")
		await transaction.abandon()
		fail("Council did not apply the candidate patch.")
		return true
	}

	return false
}
