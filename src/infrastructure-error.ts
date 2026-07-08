import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export const KIMCHI_INFRA_ERROR_EXIT_CODE = 74
const KIMCHI_INFRA_ERROR_PREFIX = "KIMCHI_INFRA_ERROR"

// Provider verdicts (auth, quota, rate limits, context overflow) are checked
// first: they are answers from a working provider, not transport failures,
// even when the surrounding message also mentions a connection problem.
const NON_INFRA_PROVIDER_ERROR_RE =
	/unauthorized|authentication[_\s]?(?:error|failed)|invalid api key|\b401\b|\b403\b|permission denied|account.{0,40}\b(?:terminated|suspended|deactivated|disabled)\b|context window|context overflow|maximum context|prompt too long|quota|billing|insufficient_quota|out of budget|usage limit|rate.?limit|too many requests|\b429\b/i

// Transport and gateway failures: nothing (or garbage) came back from the
// provider, so the run can be retried by a supervisor. Shared with
// upstream-retry-patch.ts so retry and exit classification cannot drift.
const INFRA_PROVIDER_ERROR_RE =
	/\b5(?:00|02|03|04|24|29)\b|bad gateway|service unavailable|gateway timeout|internal server error|overloaded|cloudflare.*timeout|timeout.*cloudflare|socket(?: connection was)? closed|socket hang up|other side closed|connection closed|broken pipe|fetch failed|network.?error|connection.?error|connection.?refused|connection.?lost|upstream.?connect|reset before headers|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|\btimeout\b|\bterminated\b|unexpectedly|EPIPE|ERR_SOCKET_CLOSED|ERR_STREAM_PREMATURE_CLOSE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|connection reset/i

export interface InfrastructureFailure {
	errorMessage: string
	consecutiveInfraErrors: number
	sessionPath?: string
}

export function isInfrastructureProviderError(errorMessage: string): boolean {
	if (!errorMessage) return false
	if (NON_INFRA_PROVIDER_ERROR_RE.test(errorMessage)) return false
	return INFRA_PROVIDER_ERROR_RE.test(errorMessage)
}

export interface InfrastructureErrorTracker {
	/** Pi extension factory; register it with the session so failures are observed in-process. */
	extension: (pi: ExtensionAPI) => void
	/** The trailing infra failure, or undefined if the last assistant message recovered. */
	getFailure(): InfrastructureFailure | undefined
}

/**
 * Tracks provider transport failures as they happen, via message_end events.
 * A failure is only reported while it is trailing: any later assistant message
 * that is not an infra error (a successful turn, or a provider verdict such as
 * a rate limit) clears it, mirroring upstream's reset-on-success retry rule.
 */
export function createInfrastructureErrorTracker(): InfrastructureErrorTracker {
	let failure: InfrastructureFailure | undefined

	return {
		extension(pi: ExtensionAPI): void {
			pi.on("message_end", (event, ctx) => {
				const message = event.message
				if (message.role !== "assistant") return
				if (
					message.stopReason === "error" &&
					typeof message.errorMessage === "string" &&
					isInfrastructureProviderError(message.errorMessage)
				) {
					failure = {
						errorMessage: message.errorMessage,
						consecutiveInfraErrors: (failure?.consecutiveInfraErrors ?? 0) + 1,
						sessionPath: ctx.sessionManager.getSessionFile(),
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
	return `${KIMCHI_INFRA_ERROR_PREFIX}: provider transport failure${countText}; exiting with code ${KIMCHI_INFRA_ERROR_EXIT_CODE}. Last error: ${failure.errorMessage}${sessionText}`
}

/**
 * Reclassifies a failing run as an infrastructure failure: prints the
 * machine-readable marker and sets exit code 74 so supervisors (CI, Harbor)
 * can score the trial as infra instead of a real fail. Callers gate this on
 * the run already failing — it never turns a successful run into a failure.
 */
export function applyInfrastructureExitPolicy(failure: InfrastructureFailure | undefined): boolean {
	if (!failure) return false
	console.error(formatInfrastructureFailureMessage(failure))
	process.exitCode = KIMCHI_INFRA_ERROR_EXIT_CODE
	return true
}
