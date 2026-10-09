import { isWorkId } from "../../shared/work-id.js"
import { BEFORE_PAGE_TIMEOUT_MESSAGE } from "./billing-api.js"
import {
	type BillingSelector,
	type BillingSource,
	isBillingSelector,
	isBillingSource,
	LOOKUP_LEAD_MS,
	requestTagSelector,
	sameBillingSelector,
	sameBillingSource,
} from "./billing-source.js"
import type { RequestCostObservation } from "./costs.js"
import { object, type WorkRecord } from "./summary.js"

// What the journals prove about each request's bill, and what a pass may still look up.

export interface BillingLookup {
	status: "priced" | "no-charge" | "pending" | "unavailable" | "invalid" | "account-changed"
	checkedAt: string
	organizationId?: string
	userId?: string
	reason?: string
}

export interface RequestBilling {
	request: WorkRecord
	requestId: string
	source?: BillingSource
	selector?: BillingSelector
	tagSkipped?: string
	invalid: boolean
	lookup?: BillingLookup
	substantiveLookup?: BillingLookup
	lastCost?: WorkRecord
	organizationId?: string
	userId?: string
	observations: RequestCostObservation[]
}

/** What a pass needs to schedule, look up and record a request whose billing window is open. */
export interface OpenBilling {
	requestId: string
	workId: string
	sessionId: string
	cwd?: string
	source: BillingSource
	selector: BillingSelector
	lookup?: BillingLookup
	substantiveLookup?: BillingLookup
	/** Rows of the last journaled result, so an unchanged lookup is not journaled again. */
	lastRows?: unknown[]
	organizationId?: string
	userId?: string
	billed: boolean
}
/**
 * Without an exact identity there is no network work to retry; the report derives that state
 * from source records. The window closes once a lookup at or after its end reached the billing API.
 */

export function openBilling(item: RequestBilling): OpenBilling | undefined {
	const { source, selector } = item
	if (
		item.invalid ||
		!source ||
		!selector ||
		Date.parse(item.substantiveLookup?.checkedAt ?? "") >= Date.parse(selector.endTime)
	)
		return undefined
	return {
		requestId: item.requestId,
		workId: item.request.workId,
		sessionId: item.request.sessionId,
		...(typeof item.request.cwd === "string" ? { cwd: item.request.cwd } : {}),
		source,
		selector,
		lookup: item.lookup,
		substantiveLookup: item.substantiveLookup,
		lastRows: Array.isArray(item.lastCost?.billingRows) ? item.lastCost.billingRows : undefined,
		organizationId: item.organizationId,
		userId: item.userId,
		billed: item.observations.length > 0,
	}
}

/** What costs.json shows for a request besides its allocation. */
export interface BillingDisplay {
	/** The journal observation a poll entry must refer to. */
	lookupAt: string
	billingLookup: Partial<BillingLookup> & Pick<BillingLookup, "status">
	/** Only a request that can be looked up can show a failed refresh, with its verified account. */
	refresh?: { organizationId?: string; userId?: string }
	/** Why the request was sent without a billing tag; such a request cannot be priced. */
	tagSkipped?: string
}

export function billingDisplay(item: RequestBilling): BillingDisplay {
	const display = {
		lookupAt: item.lookup?.checkedAt ?? "",
		...(item.tagSkipped && !item.selector ? { tagSkipped: item.tagSkipped } : {}),
	}
	if (item.invalid) return { ...display, billingLookup: { status: "invalid", reason: "Conflicting billing evidence" } }
	if (!item.source || !item.selector)
		return {
			...display,
			billingLookup: {
				status: "pending",
				reason: item.tagSkipped
					? `Billing tag skipped: ${item.tagSkipped}`
					: "No captured billing source or request selector",
			},
		}
	return {
		...display,
		billingLookup: item.lookup ?? { status: "pending" },
		refresh: {
			...(item.organizationId ? { organizationId: item.organizationId } : {}),
			...(item.userId ? { userId: item.userId } : {}),
		},
	}
}

function storedLookup(value: unknown): value is BillingLookup {
	if (!object(value) || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)))
		return false
	return (
		(value.status === "priced" ||
			value.status === "no-charge" ||
			value.status === "pending" ||
			value.status === "unavailable" ||
			value.status === "invalid" ||
			value.status === "account-changed") &&
		(value.organizationId === undefined || isWorkId(value.organizationId)) &&
		(value.userId === undefined || isWorkId(value.userId)) &&
		(value.reason === undefined || typeof value.reason === "string")
	)
}

export function billingRequests(records: WorkRecord[]): Map<string, RequestBilling> {
	const requests = new Map<string, RequestBilling>()
	for (const row of records) {
		if (row.type !== "request" || typeof row.requestId !== "string") continue
		const previous = requests.get(row.requestId)
		if (previous) {
			previous.invalid ||= previous.request.workId !== row.workId || previous.request.sessionId !== row.sessionId
			continue
		}
		requests.set(row.requestId, { request: row, requestId: row.requestId, invalid: false, observations: [] })
	}
	for (const row of records) {
		if (row.type !== "request_dispatch" && row.type !== "request_response") continue
		const item = requests.get(String(row.requestId))
		if (!item) continue
		if (row.workId !== item.request.workId || row.sessionId !== item.request.sessionId) {
			item.invalid = true
			continue
		}
		if (row.billingSource !== undefined) {
			if (!isBillingSource(row.billingSource)) {
				item.invalid = true
				continue
			}
			if (item.source && !sameBillingSource(item.source, row.billingSource)) item.invalid = true
			item.source = row.billingSource
		}
		if (row.type === "request_dispatch") {
			if (typeof row.billingTagSkipped === "string") item.tagSkipped = row.billingTagSkipped
			if (row.billingSelector === undefined) continue
			const { dispatchedAt } = row
			const saved = row.billingSelector
			// Selectors saved before the wider window began five minutes before dispatch.
			const expected =
				typeof dispatchedAt === "string"
					? [LOOKUP_LEAD_MS, 5 * 60_000].map((lead) => requestTagSelector(item.requestId, dispatchedAt, lead))
					: []
			if (
				!isBillingSelector(saved) ||
				!expected.some((value) => value && sameBillingSelector(value, saved)) ||
				!isBillingSource(row.billingSource)
			) {
				item.invalid = true
				continue
			}
			if (item.selector && !sameBillingSelector(item.selector, saved)) item.invalid = true
			item.selector = saved
		}
	}

	const evidence = new Map<RequestBilling, BillingLookup[]>()
	for (const row of records) {
		if (row.type !== "request_cost") continue
		const item = requests.get(String(row.requestId))
		// Rows without a tag selector came from the removed prompt-ID lookup and prove nothing.
		if (!item || !isBillingSelector(row.billingSelector)) continue
		if (
			!storedLookup(row.billingLookup) ||
			!item.source ||
			!isBillingSource(row.billingSource) ||
			!sameBillingSource(item.source, row.billingSource) ||
			!item.selector ||
			!sameBillingSelector(item.selector, row.billingSelector) ||
			row.sessionId !== item.request.sessionId ||
			row.workId !== item.request.workId ||
			!Array.isArray(row.billingRows)
		) {
			item.invalid = true
			continue
		}

		const lookup = row.billingLookup
		if (
			(!lookup.organizationId &&
				(row.billingRows.length || lookup.status === "priced" || lookup.status === "no-charge")) ||
			(lookup.status === "no-charge" && row.billingRows.length > 0)
		) {
			item.invalid = true
			continue
		}
		if (lookup.organizationId) {
			if (item.organizationId && item.organizationId !== lookup.organizationId) item.invalid = true
			item.organizationId = lookup.organizationId
		}
		if (lookup.userId) {
			if (item.userId && item.userId !== lookup.userId) item.invalid = true
			item.userId = lookup.userId
		}
		if (!item.lookup || Date.parse(lookup.checkedAt) >= Date.parse(item.lookup.checkedAt)) {
			item.lookup = lookup
			item.lastCost = row
		}

		// Earlier versions journaled timeouts before any billing page; they add no evidence.
		// Older generic timeout records may contain incomplete pages.
		const beforePageTimeout =
			lookup.status === "unavailable" && lookup.reason === BEFORE_PAGE_TIMEOUT_MESSAGE && row.billingRows.length === 0
		if (!beforePageTimeout) {
			const lookups = evidence.get(item)
			if (lookups) lookups.push(lookup)
			else evidence.set(item, [lookup])
		}
		for (const bill of row.billingRows) {
			if (!object(bill) || !isWorkId(bill.id) || (bill.costUsd !== null && typeof bill.costUsd !== "string")) {
				item.invalid = true
				continue
			}
			item.observations.push({
				requestId: item.requestId,
				billingRecordId: bill.id,
				costUsd: bill.costUsd,
				account:
					lookup.organizationId && lookup.userId
						? { apiUrl: item.source.apiUrl, organizationId: lookup.organizationId, userId: lookup.userId }
						: undefined,
			})
		}
	}
	for (const [item, lookups] of evidence)
		for (const lookup of lookups.sort((left, right) => Date.parse(left.checkedAt) - Date.parse(right.checkedAt))) {
			// A changed key or account stops refreshes; it cannot withdraw a verified complete price.
			if (lookup.status === "account-changed" && item.substantiveLookup?.status === "priced") continue
			item.substantiveLookup = lookup
		}
	return requests
}
