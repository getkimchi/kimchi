import { isWorkId } from "../../shared/work-id.js"
import { boundedResponse } from "../../utils/http.js"
import type { BillingSelector } from "./billing-source.js"
import { decimalNanos, time } from "./costs.js"
import { object } from "./summary.js"

// The billing API's request pages, reduced to exact prices and safe metadata.

export interface BillingRow {
	id: string
	costUsd: string | null
	/** Optional API observations, not estimates. Absent values remain unknown. */
	promptTokens?: string
	completionTokens?: string
	totalTokens?: string
	cacheReadInputTokens?: string
	cacheCreationFiveMinuteTokens?: string
	cacheCreationOneHourTokens?: string
	webSearchRequests?: string
	promptPrice?: string
	completionPrice?: string
	cacheReadPrice?: string
	cacheCreationPrice?: string
	originalTotalPrice?: string
	recommendedTotalPrice?: string
	createTime?: string
	provider?: string
	providerName?: string
	model?: string
	originalModel?: string
	recommendedModel?: string
	recommendedProvider?: string
	sessionId?: string
	parentSessionId?: string
	routed?: boolean
	recovered?: boolean
	responseStatusCode?: number
	messageCount?: number
	contextWindowSize?: number
	turnIndex?: number
	contextUtilizationPct?: number
	/** Names of malformed optional fields; never their raw values. */
	metadataUnavailable?: string[]
}

export const BEFORE_PAGE_TIMEOUT_MESSAGE = "Billing lookup time limit exceeded before receiving any billing page"
const MAX_PAGES = 5
const MAX_BODY_BYTES = 1_048_576
const PAGE_SIZE = 100

/** Bounded response body; do not copy server errors, prompts or unrelated fields to the ledger. */
export async function billingResponse(response: Response, signal: AbortSignal): Promise<Response> {
	if (!response.ok) {
		await response.body?.cancel()
		throw new Error(`Billing API returned HTTP ${response.status}`)
	}
	if (!response.body) throw new Error("Billing API returned no body")
	return boundedResponse(response, MAX_BODY_BYTES, signal, "Billing response exceeded the size limit")
}

/** Keep only safe, typed billing facts. Bad optional metadata does not erase a valid charge. */
function billingMetadata(item: Record<string, unknown>): Partial<BillingRow> {
	const result: Partial<BillingRow> = {}
	const unavailable: string[] = []
	for (const field of [
		"promptPrice",
		"completionPrice",
		"cacheReadPrice",
		"cacheCreationPrice",
		"originalTotalPrice",
		"recommendedTotalPrice",
	] as const) {
		const value = item[field]
		if (value == null) continue
		if (typeof value === "string" && decimalNanos(value) !== undefined) result[field] = value
		else unavailable.push(field)
	}
	for (const field of [
		"promptTokens",
		"completionTokens",
		"totalTokens",
		"cacheReadInputTokens",
		"cacheCreationFiveMinuteTokens",
		"cacheCreationOneHourTokens",
		"webSearchRequests",
	] as const) {
		const value = item[field]
		if (value == null) continue
		const exact =
			typeof value === "string"
				? value
				: typeof value === "number" && Number.isSafeInteger(value) && value >= 0
					? String(value)
					: ""
		if (/^(0|[1-9]\d{0,19})$/.test(exact) && BigInt(exact) <= 18_446_744_073_709_551_615n) result[field] = exact
		else unavailable.push(field)
	}
	for (const field of [
		"provider",
		"providerName",
		"model",
		"originalModel",
		"recommendedModel",
		"recommendedProvider",
	] as const) {
		const value = item[field]
		if (value == null || value === "") continue
		if (typeof value === "string" && value.length <= 200 && !/\p{Cc}/u.test(value)) result[field] = value
		else unavailable.push(field)
	}
	for (const field of ["sessionId", "parentSessionId"] as const) {
		const value = item[field]
		if (value == null || value === "") continue
		if (isWorkId(value)) result[field] = value
		else unavailable.push(field)
	}
	for (const field of ["routed", "recovered"] as const) {
		const value = item[field]
		if (value == null) continue
		if (typeof value === "boolean") result[field] = value
		else unavailable.push(field)
	}
	for (const field of ["responseStatusCode", "messageCount", "contextWindowSize", "turnIndex"] as const) {
		const value = item[field]
		if (value == null) continue
		const max = field === "responseStatusCode" ? 599 : 4_294_967_295
		if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max) result[field] = value
		else unavailable.push(field)
	}
	if (item.contextUtilizationPct != null) {
		const value = item.contextUtilizationPct
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) result.contextUtilizationPct = value
		else unavailable.push("contextUtilizationPct")
	}
	if (item.createTime != null) {
		const value = item.createTime
		if (typeof value === "string" && time(value) !== undefined) result.createTime = value
		else unavailable.push("createTime")
	}
	if (unavailable.length) result.metadataUnavailable = unavailable.sort()
	return result
}

export async function lookupRows(
	apiUrl: string,
	organizationId: string,
	userId: string | undefined,
	requestSelector: BillingSelector,
	apiKey: string,
	fetchBounded: typeof fetch,
	rows: BillingRow[],
	onPage: () => void,
): Promise<void> {
	let cursor = ""
	const cursors = new Set<string>()
	const billingIds = new Set<string>()
	let expectedCount: number | undefined
	for (let page = 0; page < MAX_PAGES; page++) {
		const params = new URLSearchParams({ inferUserFromApiKey: "true", "page.limit": String(PAGE_SIZE) })
		params.set("tags", requestSelector.tag)
		params.set("startTime", requestSelector.startTime)
		params.set("endTime", requestSelector.endTime)
		if (cursor) params.set("page.cursor", cursor)
		const response = await fetchBounded(
			`${apiUrl}/ai-optimizer/v1beta/organizations/${encodeURIComponent(organizationId)}/llm-requests?${params}`,
			{
				headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			},
		).catch((error: unknown) => {
			if (cursor && error instanceof Error && error.message === BEFORE_PAGE_TIMEOUT_MESSAGE)
				throw new Error("Billing lookup time limit exceeded during pagination")
			throw error
		})

		const body: unknown = await response.json()
		if (!object(body) || !Array.isArray(body.items) || body.items.length > PAGE_SIZE)
			throw new Error("Invalid billing response")
		// From here on a failure concerns billing evidence: a page has arrived.
		onPage()
		if (body.totalCount !== undefined) {
			if (typeof body.totalCount !== "number" || !Number.isSafeInteger(body.totalCount) || body.totalCount < 0)
				throw new Error("Invalid billing result count")
			// New rows may arrive between pages. A changed count needs another complete lookup.
			if (expectedCount !== undefined && expectedCount !== body.totalCount)
				throw new Error("Billing result count changed during pagination")
			expectedCount = body.totalCount
		}
		for (const item of body.items) {
			if (!object(item) || !isWorkId(item.id)) throw new Error("Billing response has no valid row identity")
			if (userId && item.castaiApiKeyOwnerId !== undefined && item.castaiApiKeyOwnerId !== userId)
				throw new Error("Billing response belongs to another API key owner")
			if (item.totalPrice !== null && item.totalPrice !== undefined && typeof item.totalPrice !== "string")
				throw new Error("Billing response has no exact decimal price")
			const costUsd = item.totalPrice ?? null
			if (costUsd !== null && decimalNanos(costUsd) === undefined)
				throw new Error("Billing response has an invalid decimal price")
			rows.push({ id: item.id, costUsd, ...billingMetadata(item) })
			billingIds.add(item.id)
		}
		if (body.nextPageCursor === undefined || body.nextPageCursor === "") {
			if (expectedCount !== undefined && billingIds.size !== expectedCount)
				throw new Error("Billing response did not include every counted row")
			return
		}
		if (
			typeof body.nextPageCursor !== "string" ||
			body.nextPageCursor.length > 4096 ||
			cursors.has(body.nextPageCursor)
		)
			throw new Error("Invalid billing page cursor")
		cursor = body.nextPageCursor
		cursors.add(cursor)
	}
	throw new Error("Billing lookup exceeded the page limit")
}
