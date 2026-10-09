import { existsSync, readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { type VerifyApiKeyResponse, verifyApiKey } from "../../api/organizations.js"
import { writeFileAtomic, writeFileDurably } from "../../config/json.js"
import { loadConfig } from "../../config.js"
import { isWorkId } from "../../shared/work-id.js"
import { appendWorkRecord } from "../work-attribution.js"
import { BEFORE_PAGE_TIMEOUT_MESSAGE, type BillingRow, billingResponse, lookupRows } from "./billing-api.js"
import {
	type BillingDisplay,
	type BillingLookup,
	billingDisplay,
	billingRequests,
	isSettled,
	type OpenBilling,
	openBilling,
} from "./billing-evidence.js"
import { type BillingSource, captureBillingSource, sameBillingSource } from "./billing-source.js"
import { calculatePullRequestCosts, type PullRequestCost, type PullRequestCostReport } from "./costs.js"
import type { WorkAccount } from "./scope.js"
import { object, readWorkRecords, readWorkRecordsAsync, workJournalFingerprint } from "./summary.js"

// The background pass: it looks up due bills within a budget, journals new evidence and publishes reports.

const PASS_MS = 5000
const MAX_CALLS = 30
const MAX_PROCESSED_REQUESTS = 30
const PENDING_REFRESH_MS = 30_000
const PRICED_REFRESH_MS = 5 * 60_000
const DAY_MS = 24 * 60 * 60_000
const SLOW_REFRESH_MS = 60 * 60_000

interface BillingPoll {
	checkedAt: number
	/** Ignore scheduling state if its source observation has changed or disappeared; empty before any. */
	lookupAt: string
	/** The last refresh failed before any billing page arrived, so it added no evidence. */
	failure?: { checkedAt: string; reason: string }
}

function readBillingPolls(path: string): Record<string, BillingPoll> {
	const polls: Record<string, BillingPoll> = Object.create(null)
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"))
		if (object(value))
			for (const [id, entry] of Object.entries(value)) {
				if (
					object(entry) &&
					typeof entry.checkedAt === "number" &&
					Number.isFinite(entry.checkedAt) &&
					entry.checkedAt <= Date.now() &&
					typeof entry.lookupAt === "string"
				) {
					const { failure } = entry
					polls[id] = {
						checkedAt: entry.checkedAt,
						lookupAt: entry.lookupAt,
						...(object(failure) &&
						typeof failure.checkedAt === "string" &&
						Number.isFinite(Date.parse(failure.checkedAt)) &&
						typeof failure.reason === "string"
							? { failure: { checkedAt: failure.checkedAt, reason: failure.reason } }
							: {}),
					}
				}
			}
	} catch {}
	return polls
}

/** Scheduling state applies only to the journal observation it was written for. */
function currentPoll(polls: Record<string, BillingPoll>, item: OpenBilling): BillingPoll | undefined {
	const poll = polls[item.requestId]
	return poll?.lookupAt === (item.lookup?.checkedAt ?? "") ? poll : undefined
}

/** A refresh without any billing page leaves the journal unchanged; costs.json still shows that it failed. */
function shownFailure(display: BillingDisplay | undefined, poll: BillingPoll | undefined) {
	return display?.refresh && poll?.lookupAt === display.lookupAt ? poll.failure : undefined
}

function costFingerprint(rows: unknown[], lookup: BillingLookup): string {
	const { checkedAt: _, ...result } = lookup
	return JSON.stringify([result, [...new Set(rows.map((row) => JSON.stringify(row)))].sort()])
}

/** Read durable evidence rather than combining per-work caches. */
export function readWorkCostReport(agentDir: string, records = readWorkRecords(agentDir)) {
	const requests = billingRequests(records)
	const noCharge = new Map<string, WorkAccount>()
	for (const item of requests.values()) {
		const lookup = item.substantiveLookup
		if (
			!item.invalid &&
			!item.observations.length &&
			item.source &&
			lookup?.status === "no-charge" &&
			lookup.organizationId &&
			lookup.userId
		)
			noCharge.set(item.requestId, {
				apiUrl: item.source.apiUrl,
				organizationId: lookup.organizationId,
				userId: lookup.userId,
			})
	}

	const incomplete = new Set(
		[...requests.values()]
			.filter((item) => item.invalid || (item.substantiveLookup?.status !== "priced" && !noCharge.has(item.requestId)))
			.map((item) => item.requestId),
	)

	const report = calculatePullRequestCosts(
		records,
		[...requests.values()].flatMap((item) => (item.invalid ? [] : item.observations)),
		incomplete,
		noCharge,
	)
	return { records, requests, report }
}

interface CostState {
	agentDir: string
	/** The journals this calculation came from; see workJournalFingerprint. */
	fingerprint: string
	/** Requests that may still need a lookup; closed windows cost an idle pass nothing. */
	open: OpenBilling[]
	/** Compact display state, so the parsed journals need not stay in memory. */
	displays: Map<string, BillingDisplay>
	report: PullRequestCostReport
	workIds: string[]
	/** Refresh failures shown by the last complete publish of this calculation. */
	published?: string
}

let lastCostState: CostState | undefined

/** The calculation is a pure function of the journals, so passes reuse it until a journal changes. */
async function costState(agentDir: string): Promise<CostState> {
	// Fingerprint before reading: an append during the read only makes the next pass recalculate.
	const fingerprint = await workJournalFingerprint(agentDir)
	if (lastCostState?.agentDir === agentDir && lastCostState.fingerprint === fingerprint) return lastCostState
	const records = await readWorkRecordsAsync(agentDir)
	const { requests, report } = readWorkCostReport(agentDir, records)
	const open: OpenBilling[] = []
	const displays = new Map<string, BillingDisplay>()
	for (const item of requests.values()) {
		displays.set(item.requestId, billingDisplay(item))
		const billing = openBilling(item)
		if (billing) open.push(billing)
	}
	lastCostState = {
		agentDir,
		fingerprint,
		open,
		displays,
		report,
		workIds: [...new Set(records.map((row) => row.workId))],
	}
	return lastCostState
}

/** Besides the journals, costs.json shows only refresh failures kept in billing-polls.json. */
function refreshFailures(state: CostState, polls: Record<string, BillingPoll>): string {
	return JSON.stringify(
		Object.keys(polls)
			.sort()
			.flatMap((requestId) => {
				const failure = shownFailure(state.displays.get(requestId), polls[requestId])
				return failure ? [[requestId, failure.checkedAt, failure.reason]] : []
			}),
	)
}

function group<T>(groups: Map<string, T[]>, key: string, value: T): void {
	const values = groups.get(key)
	if (values) values.push(value)
	else groups.set(key, [value])
}

async function publishReports(
	agentDir: string,
	{ displays, report, workIds }: CostState,
	polls: Record<string, BillingPoll>,
	assertLease: () => void,
): Promise<void> {
	// Group rows by work once instead of filtering every row for every work.
	const pullRequests = new Map<string, PullRequestCost[]>()
	for (const row of report.pullRequests) for (const workId of row.workIds) group(pullRequests, workId, row)
	const workRequests = new Map<string, unknown[]>()
	for (const row of report.requests) {
		const display = displays.get(row.requestId)
		const failure = shownFailure(display, polls[row.requestId])
		const shown = {
			...row,
			...(display?.tagSkipped ? { billingTagSkipped: display.tagSkipped } : {}),
			billingLookup: failure
				? { status: "unavailable", checkedAt: failure.checkedAt, ...display?.refresh, reason: failure.reason }
				: (display?.billingLookup ?? { status: "pending", reason: "No captured billing source or request selector" }),
		}
		for (const workId of new Set([...row.workIds, ...(row.linkedWorkIds ?? [])])) group(workRequests, workId, shown)
	}
	for (const workId of workIds) {
		assertLease()
		const directory = join(agentDir, "work", workId)
		await mkdir(directory, { recursive: true, mode: 0o700 })
		const value = {
			version: 1,
			workId,
			pullRequests: pullRequests.get(workId) ?? [],
			requests: workRequests.get(workId) ?? [],
		}

		const content = `${JSON.stringify(value, null, 2)}\n`
		try {
			if (readFileSync(join(directory, "costs.json"), "utf8") === content) continue
		} catch {}
		await writeFileDurably(join(directory, "costs.json"), content, assertLease)
	}
}

/** Called by the shared supervisor's lease holder; model inference never waits for this pass. */
export async function reconcileWorkCosts(
	agentDir: string,
	signal: AbortSignal,
	assertLease: () => void = () => {},
): Promise<void> {
	const state = await costState(agentDir)
	signal.throwIfAborted()
	assertLease()
	let changed = false
	const pollingPath = join(agentDir, "work-attribution", "billing-polls.json")
	const polls = readBillingPolls(pollingPath)
	const previousPolls = JSON.stringify(polls)
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
		return billingResponse(response, boundedSignal)
	}

	const organizations = new Map<string, Promise<VerifyApiKeyResponse>>()
	const credentials = new Map<string, { key: string; source?: BillingSource }>()
	try {
		// Unknown prices come first; rechecks of settled results wait for any spare budget.
		// Keys are computed once: parsing timestamps inside the comparator dominated idle passes.
		const ordered = state.open
			.map((item) => ({
				item,
				settled: isSettled(item.lookup) ? 1 : 0,
				lastCheck: currentPoll(polls, item)?.checkedAt ?? (Date.parse(item.lookup?.checkedAt ?? "") || 0),
			}))
			.sort((left, right) => left.settled - right.settled || left.lastCheck - right.lastCheck)
		for (const [index, { item, lastCheck }] of ordered.entries()) {
			// Most requests are not due; still let the UI run during a long scan.
			if (index && index % 2000 === 0) await setImmediate()
			signal.throwIfAborted()
			assertLease()
			if (boundedSignal.aborted || Date.now() >= deadline || calls >= MAX_CALLS || processed >= MAX_PROCESSED_REQUESTS)
				break
			const endsAt = Date.parse(item.selector.endTime)
			const age = Date.now() - (endsAt - 32 * DAY_MS)
			// One final lookup may catch up after a closed client; a final lookup without any
			// billing page is retried on the slow schedule.
			// Unsettled results, including failed and never-completed lookups, slow down after a day.
			const refresh =
				Date.now() >= endsAt
					? lastCheck < endsAt
						? 0
						: SLOW_REFRESH_MS
					: isSettled(item.lookup)
						? // Settled results change rarely: recheck them less often as they age.
							Math.max(PRICED_REFRESH_MS, Math.min(DAY_MS, age / 16))
						: age >= DAY_MS
							? PRICED_REFRESH_MS
							: PENDING_REFRESH_MS
			if (Date.now() - lastCheck < refresh) continue
			const lookup: BillingLookup = {
				status: "pending",
				checkedAt: new Date(Date.now()).toISOString(),
				organizationId: item.organizationId,
				userId: item.userId,
			}

			const rows: BillingRow[] = []
			let pageReceived = false
			try {
				const { cwd } = item
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
				if (item.lookup?.status === "account-changed" && (!current || !sameBillingSource(current, item.source)))
					continue
				// Cached auth failures settle in a microtask; let UI and cancellation run.
				await setImmediate()
				signal.throwIfAborted()
				if (!current || !sameBillingSource(current, item.source)) {
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
							() => {
								pageReceived = true
							},
						)
						lookup.status = rows.length && rows.every((row) => row.costUsd !== null) ? "priced" : "pending"
						if (!rows.length && !item.billed && age >= DAY_MS && lookup.userId) lookup.status = "no-charge"
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
				// Offline, DNS/TLS, key checks, HTTP errors and deadlines before the first page add
				// no evidence: keep the last confirmed result and only remember the failure.
				if (!pageReceived) {
					polls[item.requestId] = {
						checkedAt: Date.parse(lookup.checkedAt),
						lookupAt: item.lookup?.checkedAt ?? "",
						failure: { checkedAt: lookup.checkedAt, reason: lookup.reason },
					}
					continue
				}
			}
			assertLease()
			const previousLookup = item.lookup
			// The journal must prove that the window closed, even when the final result is unchanged.
			// A changed account never closes it for a settled result, which that change cannot withdraw.
			const final =
				Date.parse(lookup.checkedAt) >= endsAt &&
				!(lookup.status === "account-changed" && isSettled(item.substantiveLookup))
			const repeated =
				previousLookup &&
				((item.lastRows && costFingerprint(rows, lookup) === costFingerprint(item.lastRows, previousLookup)) ||
					(lookup.status === "account-changed" &&
						previousLookup.status === lookup.status &&
						previousLookup.reason === lookup.reason))
			polls[item.requestId] = {
				checkedAt: Date.parse(lookup.checkedAt),
				lookupAt: repeated && !final ? previousLookup.checkedAt : lookup.checkedAt,
			}
			if (repeated && !final) continue
			const ctx = {
				cwd: item.cwd ?? "",
				sessionManager: { getSessionId: () => item.sessionId },
			}
			processed++
			appendWorkRecord(
				ctx,
				{
					type: "request_cost",
					requestId: item.requestId,
					billingSource: item.source,
					billingSelector: item.selector,
					billingRows: rows,
					billingLookup: lookup,
				},
				item.workId,
				join(agentDir, "work-attribution", `${encodeURIComponent(item.sessionId)}.jsonl`),
			)
			changed = true
		}
		signal.throwIfAborted()
		assertLease()
		const latest = changed ? await costState(agentDir) : state
		signal.throwIfAborted()
		assertLease()
		// Closed windows, which the journal now proves, and vanished requests need no scheduling state.
		const open = new Set(latest.open.map((item) => item.requestId))
		for (const requestId of Object.keys(polls)) if (!open.has(requestId)) delete polls[requestId]
		const currentPolls = JSON.stringify(polls)
		if (currentPolls !== previousPolls) writeFileAtomic(pollingPath, `${currentPolls}\n`)
		const failures = refreshFailures(latest, polls)
		// Unchanged inputs give unchanged reports; only a deleted report needs writing again.
		if (
			latest.published === failures &&
			latest.workIds.every((workId) => existsSync(join(agentDir, "work", workId, "costs.json")))
		)
			return
		await publishReports(agentDir, latest, polls, () => {
			signal.throwIfAborted()
			assertLease()
		})
		latest.published = failures
	} finally {
		clearTimeout(timeout)
	}
}
