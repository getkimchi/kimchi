import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
	classifyLLMGatewayError,
	LLM_GATEWAY_INFRASTRUCTURE_EXIT_CODE,
	type LLMGatewayError,
} from "./llm-gateway-error.js"

export const KIMCHI_INFRA_ERROR_EXIT_CODE = LLM_GATEWAY_INFRASTRUCTURE_EXIT_CODE
const KIMCHI_INFRA_ERROR_PREFIX = "KIMCHI_INFRA_ERROR"

/** Session-log entry type carrying the audit trail of each gateway-error classification. */
export const GATEWAY_CLASSIFICATION_AUDIT_TYPE = "kimchi_error_classification"

/**
 * Append an audit-trail entry to the session log recording what the classifier
 * was given (the raw provider error) and what it decided. Best-effort by design:
 * audit logging must never break a run, so a failure to persist the entry is
 * logged and swallowed rather than propagated.
 */
function recordClassificationAudit(pi: ExtensionAPI, rawMessage: string, error: LLMGatewayError | undefined): void {
	try {
		pi.appendEntry(GATEWAY_CLASSIFICATION_AUDIT_TYPE, {
			rawMessage,
			reason: error?.reason ?? "unclassified",
			retryable: error?.retryable ?? false,
			isInfrastructure: error?.isInfrastructure ?? false,
			exitCode: error?.exitCode() ?? null,
			httpStatusCode: error?.httpStatusCode ?? null,
		})
	} catch (cause) {
		console.error(`KIMCHI: failed to record gateway classification audit entry: ${cause}`)
	}
}

export interface InfrastructureFailure {
	error: LLMGatewayError
	consecutiveInfraErrors: number
	sessionPath?: string
}

export function isInfrastructureProviderError(errorMessage: string): boolean {
	return classifyLLMGatewayError(errorMessage)?.isInfrastructure ?? false
}

export interface InfrastructureErrorTracker {
	/** Pi extension factory; register it with the session so failures are observed in-process. */
	extension: (pi: ExtensionAPI) => void
	/** The trailing infra failure, or undefined if the last assistant message recovered. */
	getFailure(): InfrastructureFailure | undefined
}

/**
 * Tracks provider failures as they happen, via message_end events.
 * A failure is only reported while it is trailing: any later assistant message
 * that is not an infra exit error clears it, mirroring upstream's
 * reset-on-success retry rule.
 */
export function createInfrastructureErrorTracker(): InfrastructureErrorTracker {
	let failure: InfrastructureFailure | undefined

	return {
		extension(pi: ExtensionAPI): void {
			pi.on("message_end", (event, ctx) => {
				const message = event.message
				if (message.role !== "assistant") return

				let error: LLMGatewayError | undefined
				if (message.stopReason === "error" && typeof message.errorMessage === "string") {
					error = classifyLLMGatewayError(message.errorMessage)
					recordClassificationAudit(pi, message.errorMessage, error)
				}

				if (error?.isInfrastructure) {
					const sessionPath = ctx.sessionManager?.getSessionFile?.()
					failure = {
						error,
						consecutiveInfraErrors: (failure?.consecutiveInfraErrors ?? 0) + 1,
						...(sessionPath ? { sessionPath } : {}),
					}
				} else {
					failure = undefined
				}
			})
		},
		getFailure: () => failure,
	}
}

function formatInfrastructureFailureMessage(failure: InfrastructureFailure): string {
	const countText =
		failure.consecutiveInfraErrors > 1 ? ` after ${failure.consecutiveInfraErrors} consecutive infra errors` : ""
	const sessionText = failure.sessionPath ? ` Session: ${failure.sessionPath}` : ""
	return `${KIMCHI_INFRA_ERROR_PREFIX}: provider infrastructure failure${countText}; exiting with code ${failure.error.exitCode()}. Last error: ${failure.error.rawMessage}${sessionText}`
}

/**
 * Reclassifies a failing run as an infrastructure failure: prints the
 * machine-readable marker and sets exit code 74 so supervisors (CI, Harbor)
 * can score the trial as infra instead of a real fail. Callers gate this on
 * the run already failing — it never turns a successful run into a failure.
 */
export function applyInfrastructureExitPolicy(failure: InfrastructureFailure | undefined): boolean {
	if (!failure) return false
	if (!failure.error.isInfrastructure) return false
	console.error(formatInfrastructureFailureMessage(failure))
	process.exitCode = KIMCHI_INFRA_ERROR_EXIT_CODE
	return true
}
