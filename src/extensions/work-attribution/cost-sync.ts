import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { type VerifyApiKeyResponse, verifyApiKey } from "../../api/organizations.js"
import { loadConfig, resolveEndpoints } from "../../config.js"
import { isWorkId } from "../../shared/work-id.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"
import { appendWorkRecord } from "../work-attribution.js"
import { calculatePullRequestCosts, decimalNanos, type RequestCostObservation } from "./costs.js"
import { isWorkAccount } from "./scope.js"
import { readWorkRecords, type WorkRecord } from "./summary.js"

export interface BillingSource {
	apiUrl: string
	gatewayUrl: string
	/** One-way fingerprint of the credential actually sent; never the credential itself. */
	credentialHash: string
}
export type BillingSelector =
	| { type: "tag"; tag: string; startTime: string; endTime: string }
	| { type: "prompt"; promptId: string }

/** Billing timestamps describe completed reports, so retain a broad fixed window. */
export function requestTagSelector(requestId: string, dispatchedAt: string): BillingSelector | undefined {
	if (!isWorkId(requestId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(dispatchedAt)) return undefined
	const timestamp = Date.parse(dispatchedAt)
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== dispatchedAt) return undefined
	return {
		type: "tag",
		tag: `kimchi-request:${requestId}`,
		startTime: new Date(timestamp - 5 * 60_000).toISOString(),
		endTime: new Date(timestamp + 32 * 24 * 60 * 60_000).toISOString(),
	}
}
interface BillingRow {
	id: string
	promptId?: string
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
interface BillingLookup {
	status: "priced" | "pending" | "unavailable" | "invalid" | "account-changed"
	checkedAt: string
	organizationId?: string
	userId?: string
	reason?: string
}
interface RequestBilling {
	request: WorkRecord
	requestId: string
	source?: BillingSource
	promptId?: string
	selector?: BillingSelector
	tagSkipped?: string
	invalid: boolean
	lookup?: BillingLookup
	substantiveLookup?: BillingLookup
	organizationId?: string
	userId?: string
	observations: RequestCostObservation[]
}
const PASS_MS = 5000
const BEFORE_PAGE_TIMEOUT_MESSAGE = "Billing lookup time limit exceeded before receiving any billing page"
const MAX_CALLS = 30
const MAX_PROCESSED_REQUESTS = 30
const MAX_PAGES = 5
const MAX_BODY_BYTES = 1_048_576
const PAGE_SIZE = 100
const PENDING_REFRESH_MS = 30_000
const PRICED_REFRESH_MS = 5 * 60_000

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
function httpUrl(value: unknown): value is string {
	if (typeof value !== "string") return false
	try {
		const url = new URL(value)
		return /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash
	} catch {
		return false
	}
}
function fingerprint(key: string): string {
	return createHash("sha256").update(key).digest("hex")
}
function source(value: unknown): value is BillingSource {
	return (
		object(value) &&
		httpUrl(value.apiUrl) &&
		httpUrl(value.gatewayUrl) &&
		typeof value.credentialHash === "string" &&
		/^[a-f\d]{64}$/.test(value.credentialHash)
	)
}
function sameSource(left: BillingSource, right: BillingSource): boolean {
	return (
		left.apiUrl === right.apiUrl && left.gatewayUrl === right.gatewayUrl && left.credentialHash === right.credentialHash
	)
}
function storedLookup(value: unknown): value is BillingLookup {
	if (!object(value) || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)))
		return false
	return (
		(value.status === "priced" ||
			value.status === "pending" ||
			value.status === "unavailable" ||
			value.status === "invalid" ||
			value.status === "account-changed") &&
		(value.organizationId === undefined || isWorkId(value.organizationId)) &&
		(value.userId === undefined || isWorkId(value.userId)) &&
		(value.reason === undefined || typeof value.reason === "string")
	)
}
/** Capture at dispatch, after provider auth has supplied the actual outgoing headers. */
export function captureBillingSource(headers: Headers, url: string, cwd: string): BillingSource | undefined {
	const key = headers.get("x-api-key") ?? /^Bearer (\S+)$/i.exec(headers.get("authorization") ?? "")?.[1]
	if (!key) return undefined
	let gatewayUrl: string
	try {
		const parsed = new URL(url)
		parsed.search = ""
		parsed.hash = ""
		gatewayUrl = parsed.toString()
	} catch {
		return undefined
	}
	if (!httpUrl(gatewayUrl)) return undefined
	const endpoints = resolveEndpoints({ cwd })
	const configured = [
		endpoints.llmEndpoint,
		endpoints.openAiBaseUrl,
		endpoints.anthropicBaseUrl,
		endpoints.experimentalOpenAiBaseUrl,
	]
	if (!configured.some((base) => gatewayUrl.startsWith(`${base.replace(/\/+$/, "")}/`))) return undefined
	if (!httpUrl(endpoints.platformApiUrl)) return undefined
	return { apiUrl: endpoints.platformApiUrl.replace(/\/+$/, ""), gatewayUrl, credentialHash: fingerprint(key) }
}

function selector(value: unknown): value is BillingSelector {
	if (!object(value)) return false
	if (value.type === "prompt") return isWorkId(value.promptId)
	return (
		value.type === "tag" &&
		typeof value.tag === "string" &&
		typeof value.startTime === "string" &&
		typeof value.endTime === "string"
	)
}
function sameSelector(left: BillingSelector, right: BillingSelector): boolean {
	if (left.type === "prompt") return right.type === "prompt" && left.promptId === right.promptId
	return (
		right.type === "tag" &&
		left.tag === right.tag &&
		left.startTime === right.startTime &&
		left.endTime === right.endTime
	)
}
function billingRequests(records: WorkRecord[]): Map<string, RequestBilling> {
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
			if (!source(row.billingSource)) {
				item.invalid = true
				continue
			}
			if (item.source && !sameSource(item.source, row.billingSource)) item.invalid = true
			item.source = row.billingSource
		}
		if (row.type === "request_dispatch") {
			if (typeof row.billingTagSkipped === "string") item.tagSkipped = row.billingTagSkipped
			if (row.billingSelector === undefined) continue
			const expected =
				typeof row.dispatchedAt === "string" ? requestTagSelector(item.requestId, row.dispatchedAt) : undefined
			if (
				!expected ||
				!selector(row.billingSelector) ||
				!sameSelector(expected, row.billingSelector) ||
				!source(row.billingSource)
			) {
				item.invalid = true
				continue
			}
			if (item.selector && !sameSelector(item.selector, row.billingSelector)) item.invalid = true
			item.selector = row.billingSelector
		} else if (object(row.response) && isWorkId(row.response.promptId)) {
			if (item.promptId && item.promptId !== row.response.promptId) item.invalid = true
			item.promptId = row.response.promptId
		}
	}
	const owners = new Map<string, RequestBilling>()
	for (const item of requests.values()) {
		if (!item.selector && item.promptId) item.selector = { type: "prompt", promptId: item.promptId }
		if (!item.source || !item.selector) continue
		const identity = item.selector.type === "tag" ? item.selector.tag : item.selector.promptId
		const key = JSON.stringify([item.source.apiUrl, item.source.credentialHash, item.selector.type, identity])
		const other = owners.get(key)
		if (other) {
			other.invalid = true
			item.invalid = true
		}
		owners.set(key, item)
	}
	for (const row of records) {
		if (row.type !== "request_cost") continue
		const item = requests.get(String(row.requestId))
		if (!item) continue
		// Earlier ledgers stored only promptId. New ones retain the exact dispatched selector.
		const savedSelector = row.billingSelector ?? { type: "prompt", promptId: row.promptId }
		if (
			!storedLookup(row.billingLookup) ||
			!item.source ||
			!source(row.billingSource) ||
			!sameSource(item.source, row.billingSource) ||
			!item.selector ||
			!selector(savedSelector) ||
			!sameSelector(item.selector, savedSelector) ||
			row.sessionId !== item.request.sessionId ||
			row.workId !== item.request.workId ||
			!Array.isArray(row.billingRows)
		) {
			item.invalid = true
			continue
		}
		const lookup = row.billingLookup
		if (!lookup.organizationId && (row.billingRows.length || lookup.status === "priced")) {
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
		if (!item.lookup || Date.parse(lookup.checkedAt) >= Date.parse(item.lookup.checkedAt)) item.lookup = lookup
		// A timeout before any billing page adds no evidence. Retain its retry timing
		// and diagnostics. Older generic timeout records may contain incomplete pages.
		const beforePageTimeout =
			lookup.status === "unavailable" && lookup.reason === BEFORE_PAGE_TIMEOUT_MESSAGE && row.billingRows.length === 0
		if (
			!beforePageTimeout &&
			(!item.substantiveLookup || Date.parse(lookup.checkedAt) >= Date.parse(item.substantiveLookup.checkedAt))
		)
			item.substantiveLookup = lookup
		for (const bill of row.billingRows) {
			if (
				!object(bill) ||
				!isWorkId(bill.id) ||
				(item.selector.type === "prompt" && bill.promptId !== item.selector.promptId) ||
				(bill.costUsd !== null && typeof bill.costUsd !== "string")
			) {
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
	return requests
}
function displayedLookup(item: RequestBilling | undefined) {
	if (item?.invalid) return { status: "invalid", reason: "Conflicting billing evidence" }
	if (!item?.source || !item.selector)
		return {
			status: "pending",
			reason: item?.tagSkipped
				? `Billing tag skipped: ${item.tagSkipped}`
				: "No captured billing source or request selector",
		}
	return item.lookup ?? { status: "pending" }
}

/** Bounded response body; do not copy server errors, prompts or unrelated fields to the ledger. */
async function boundedResponse(response: Response, signal: AbortSignal): Promise<Response> {
	if (!response.ok) {
		await response.body?.cancel()
		throw new Error(`Billing API returned HTTP ${response.status}`)
	}
	const reader = response.body?.getReader()
	if (!reader) throw new Error("Billing API returned no body")
	const chunks: Uint8Array[] = []
	let size = 0
	const cancel = () => {
		void reader.cancel().catch(() => {})
	}
	signal.addEventListener("abort", cancel, { once: true })
	try {
		for (;;) {
			signal.throwIfAborted()
			const { done, value } = await reader.read()
			signal.throwIfAborted()
			if (done) break
			size += value.byteLength
			if (size > MAX_BODY_BYTES) throw new Error("Billing response exceeded the size limit")
			chunks.push(value)
		}
		return new Response(Buffer.concat(chunks))
	} finally {
		signal.removeEventListener("abort", cancel)
		await reader.cancel().catch(() => {})
		reader.releaseLock()
	}
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
	for (const field of ["promptId", "sessionId", "parentSessionId"] as const) {
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
		const parts =
			typeof value === "string" ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value) : null
		const timestamp = typeof value === "string" ? Date.parse(value) : NaN
		if (
			typeof value === "string" &&
			parts &&
			Number.isFinite(timestamp) &&
			new Date(timestamp).toISOString() === `${parts[1]}.${(parts[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`
		)
			result.createTime = value
		else unavailable.push("createTime")
	}
	if (unavailable.length) result.metadataUnavailable = unavailable.sort()
	return result
}

async function lookupRows(
	apiUrl: string,
	organizationId: string,
	userId: string | undefined,
	requestSelector: BillingSelector,
	apiKey: string,
	fetchBounded: typeof fetch,
	rows: BillingRow[],
): Promise<void> {
	let cursor = ""
	const cursors = new Set<string>()
	const billingIds = new Set<string>()
	let expectedCount: number | undefined
	for (let page = 0; page < MAX_PAGES; page++) {
		const params = new URLSearchParams({ inferUserFromApiKey: "true", "page.limit": String(PAGE_SIZE) })
		if (requestSelector.type === "tag") {
			params.set("tags", requestSelector.tag)
			params.set("startTime", requestSelector.startTime)
			params.set("endTime", requestSelector.endTime)
		} else params.set("promptId", requestSelector.promptId)
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
			if (requestSelector.type === "prompt" && item.promptId !== requestSelector.promptId)
				throw new Error("Billing response has no matching prompt identity")
			if (item.totalPrice !== null && item.totalPrice !== undefined && typeof item.totalPrice !== "string")
				throw new Error("Billing response has no exact decimal price")
			const costUsd = item.totalPrice ?? null
			if (costUsd !== null && decimalNanos(costUsd) === undefined)
				throw new Error("Billing response has an invalid decimal price")
			rows.push({
				id: item.id,
				...(requestSelector.type === "prompt" ? { promptId: requestSelector.promptId } : {}),
				costUsd,
				...billingMetadata(item),
			})
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

/** One validated source for local summaries and opt-in reporting; never merge per-work caches. */
export function readWorkCostReport(agentDir: string, checkBudget: () => void = () => {}) {
	let historyComplete = true
	const records = readWorkRecords(agentDir, undefined, checkBudget, () => {
		historyComplete = false
	})
	const requests = billingRequests(records)
	const incomplete = new Set(
		[...requests.values()]
			.filter((item) => item.invalid || item.substantiveLookup?.status !== "priced")
			.map((item) => item.requestId),
	)
	const report = calculatePullRequestCosts(
		records,
		[...requests.values()].flatMap((item) => (item.invalid ? [] : item.observations)),
		incomplete,
	)
	const costRefreshes = new Map(
		[...requests.values()].flatMap((item) =>
			!item.invalid && item.substantiveLookup?.status === "priced"
				? [[item.requestId, item.substantiveLookup.checkedAt] as const]
				: [],
		),
	)
	return { records, report, requests, historyComplete, costRefreshes }
}
async function publishReports(agentDir: string, assertLease: () => void): Promise<void> {
	const { records, report, requests } = readWorkCostReport(agentDir, assertLease)
	trackPRCostMetric({
		kind: "unpriced",
		value: report.requests.filter((request) => request.priceStatus !== "priced").length,
	})
	const workIds = new Set(records.map((row) => row.workId))
	for (const workId of workIds) {
		assertLease()
		const directory = join(agentDir, "work", workId)
		await mkdir(directory, { recursive: true, mode: 0o700 })
		const value = {
			version: 1,
			workId,
			pullRequests: report.pullRequests.filter((row) => row.workIds.includes(workId)),
			requests: report.requests
				.filter((row) => row.workIds.includes(workId) || row.linkedWorkIds?.includes(workId))
				.map((row) => ({ ...row, billingLookup: displayedLookup(requests.get(row.requestId)) })),
		}
		const content = `${JSON.stringify(value, null, 2)}\n`
		try {
			if (readFileSync(join(directory, "costs.json"), "utf8") === content) continue
		} catch {}
		const temporary = join(directory, `.costs-${randomUUID()}.tmp`)
		try {
			const file = await open(temporary, "wx", 0o600)
			try {
				await file.writeFile(content)
				await file.sync()
			} finally {
				await file.close()
			}
			assertLease()
			await rename(temporary, join(directory, "costs.json"))
		} finally {
			await rm(temporary, { force: true })
		}
	}
}

/** Called by the shared supervisor's lease holder; model inference never waits for this pass. */
export async function reconcileWorkCosts(
	agentDir: string,
	signal: AbortSignal,
	assertLease: () => void = () => {},
): Promise<void> {
	const requests = billingRequests(readWorkRecords(agentDir))
	const deadline = Date.now() + PASS_MS
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(new Error(BEFORE_PAGE_TIMEOUT_MESSAGE)), PASS_MS)
	timeout.unref()
	const boundedSignal = AbortSignal.any([signal, controller.signal])
	let calls = 0
	let processed = 0
	const fetchBounded: typeof fetch = async (input, init) => {
		assertLease()
		boundedSignal.throwIfAborted()
		if (Date.now() >= deadline) throw new Error(BEFORE_PAGE_TIMEOUT_MESSAGE)
		if (++calls > MAX_CALLS) throw new Error("Billing lookup request limit exceeded")
		const response = await fetch(input, { ...init, signal: boundedSignal, redirect: "error" })
		return boundedResponse(response, boundedSignal)
	}
	const organizations = new Map<string, Promise<VerifyApiKeyResponse>>()
	const credentials = new Map<string, { key: string; source?: BillingSource }>()
	try {
		const ordered = [...requests.values()].sort((left, right) =>
			(left.lookup?.checkedAt ?? "").localeCompare(right.lookup?.checkedAt ?? ""),
		)
		for (const item of ordered) {
			signal.throwIfAborted()
			assertLease()
			if (boundedSignal.aborted || Date.now() >= deadline || calls >= MAX_CALLS || processed >= MAX_PROCESSED_REQUESTS)
				break
			// Without an exact identity there is no network work to retry. The report derives
			// this state from source records instead of appending the same event every tick.
			if (item.invalid || !item.source || !item.selector) continue
			const refresh = item.lookup?.status === "priced" ? PRICED_REFRESH_MS : PENDING_REFRESH_MS
			if (item.lookup && Date.now() - Date.parse(item.lookup.checkedAt) < refresh) continue
			const lookup: BillingLookup = {
				status: "pending",
				checkedAt: new Date(Date.now()).toISOString(),
				organizationId: item.organizationId,
				userId: item.userId,
			}
			const rows: BillingRow[] = []
			try {
				{
					const cwd = typeof item.request.cwd === "string" ? item.request.cwd : undefined
					const credentialKey = JSON.stringify([cwd, item.source.gatewayUrl])
					let credential = credentials.get(credentialKey)
					if (!credential) {
						const key = cwd ? loadConfig({ cwd }).apiKey : ""
						credential = {
							key,
							source: cwd
								? captureBillingSource(new Headers({ Authorization: `Bearer ${key}` }), item.source.gatewayUrl, cwd)
								: undefined,
						}
						credentials.set(credentialKey, credential)
					}
					const { key, source: current } = credential
					// An unchanged key/endpoint mismatch has no work to retry. It must not
					// consume the budget ahead of current-account or restored credentials.
					if (item.lookup?.status === "account-changed" && (!current || !sameSource(current, item.source))) continue
					processed++
					// Cached auth failures settle in a microtask; let UI and cancellation run.
					await setImmediate()
					signal.throwIfAborted()
					if (!current || !sameSource(current, item.source)) {
						lookup.status = "account-changed"
						lookup.reason = "Original credential or endpoint is no longer configured"
					} else {
						const account = JSON.stringify([current.apiUrl, current.credentialHash])
						let organization = organizations.get(account)
						if (!organization) {
							organization = verifyApiKey(key, {
								endpoint: current.apiUrl,
								fetch: fetchBounded,
								signal: boundedSignal,
								retry: { maxRetries: 0 },
							}).then((identity) => {
								if (!isWorkId(identity.organizationId) || (identity.userId !== undefined && !isWorkId(identity.userId)))
									throw new Error("Billing account identity is invalid")
								return identity
							})
							organizations.set(account, organization)
						}
						const { organizationId, userId } = await organization
						lookup.organizationId = item.organizationId ?? organizationId
						lookup.userId = item.userId ?? userId
						if (item.organizationId && item.organizationId !== organizationId) {
							lookup.status = "account-changed"
							lookup.reason = "Original billing organization changed"
						} else if (item.userId && item.userId !== userId) {
							lookup.status = "account-changed"
							lookup.reason = "Original billing API key owner changed"
						} else {
							await lookupRows(
								current.apiUrl,
								lookup.organizationId,
								lookup.userId,
								item.selector,
								key,
								fetchBounded,
								rows,
							)
							lookup.status = rows.length && rows.every((row) => row.costUsd !== null) ? "priced" : "pending"
						}
					}
				}
			} catch (error) {
				signal.throwIfAborted()
				lookup.status = "unavailable"
				// Errors from fetch/JSON may contain URLs or response text; retain only our bounded descriptions.
				lookup.reason =
					error instanceof Error && /^(Billing |Invalid billing)/.test(error.message)
						? error.message
						: "Billing lookup unavailable"
			}
			assertLease()
			if (
				lookup.status === "account-changed" &&
				item.lookup?.status === lookup.status &&
				item.lookup.reason === lookup.reason
			) {
				processed--
				continue
			}
			const ctx = {
				cwd: String(item.request.cwd ?? ""),
				sessionManager: { getSessionId: () => item.request.sessionId },
			}
			appendWorkRecord(
				ctx,
				{
					type: "request_cost",
					requestId: item.requestId,
					billingSource: item.source,
					promptId: item.promptId,
					billingSelector: item.selector,
					billingRows: rows,
					billingLookup: lookup,
				},
				item.request.workId,
				join(agentDir, "work-attribution", `${encodeURIComponent(item.request.sessionId)}.jsonl`),
			)
		}
		signal.throwIfAborted()
		await publishReports(agentDir, () => {
			signal.throwIfAborted()
			assertLease()
		})
	} finally {
		clearTimeout(timeout)
	}
}

/** /work reads the last durable result; opening the command never waits for the network. */
export function workCostDetails(agentDir: string, workId: string): string[] {
	if (!isWorkId(workId)) return []
	try {
		const value: unknown = JSON.parse(readFileSync(join(agentDir, "work", workId, "costs.json"), "utf8"))
		if (!object(value) || !Array.isArray(value.pullRequests)) return ["Cost: unknown; waiting for billing"]
		const lines: string[] = []
		for (const row of value.pullRequests) {
			if (!object(row)) continue
			if (value.pullRequests.some((other) => object(other) && other !== row && other.key === row.key))
				lines.push(
					isWorkAccount(row.account)
						? `Account: ${row.account.organizationId} / ${row.account.userId} (${row.account.apiUrl})`
						: "Account: unknown",
				)
			const label = object(row.pullRequest) ? row.pullRequest.url : row.key
			if (typeof row.totalCostUsd === "string") lines.push(`Cost: $${row.totalCostUsd} USD — ${label}`)
			else lines.push(`Cost: unknown; $${row.knownCostUsd} USD confirmed so far — ${label}`)
		}
		if (Array.isArray(value.requests)) {
			const requests = value.requests.filter(object)
			const priced = requests.filter((row) => row.priceStatus === "priced").length
			const unresolved = requests.filter((row) => row.allocation === "unknown").length
			const inferred = requests.filter((row) => row.allocation === "inferred").length
			const shared = requests.filter((row) => row.allocation === "shared").length
			lines.push(
				`Prices: ${priced}/${requests.length} requests billed. PR assignments: ${unresolved} unresolved, ${inferred} inferred, ${shared} shared.`,
			)
		}
		return [...lines, `Cost details: ${join(agentDir, "work", workId, "costs.json")}`]
	} catch {
		return ["Cost: unknown; waiting for billing"]
	}
}
