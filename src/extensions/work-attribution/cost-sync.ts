import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setImmediate } from "node:timers/promises"
import { type VerifyApiKeyResponse, verifyApiKey } from "../../api/organizations.js"
import { writeFileAtomic, writeFileDurably } from "../../config/json.js"
import { loadConfig } from "../../config.js"
import { isWorkId } from "../../shared/work-id.js"
import { readE2eSeam } from "../e2e-seam.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"
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
import { type BillingSource, captureBillingSource, LOOKUP_WINDOW_MS, sameBillingSource } from "./billing-source.js"
import { type SavedRequestCost, workCostTotals } from "./cost-details.js"
import {
	type CostTotal,
	calculatePullRequestCosts,
	type PullRequestCost,
	type PullRequestCostReport,
	type RequestCostAllocation,
	totalRequestCosts,
} from "./costs.js"
import type { WorkAccount } from "./scope.js"
import {
	type JournalPosition,
	journalPositions,
	journalsExtend,
	object,
	readAppendedWorkRecords,
	readWorkRecords,
	readWorkRecordsAsync,
	type WorkRecord,
	workJournalFingerprint,
} from "./summary.js"

// The background pass: it looks up due bills within a budget, journals new evidence and publishes reports.

const PASS_MS = 5000
const MAX_CALLS = 30
const MAX_PROCESSED_REQUESTS = 30
const PENDING_REFRESH_MS = 30_000
const PRICED_REFRESH_MS = 5 * 60_000
const DAY_MS = 24 * 60 * 60_000
const SLOW_REFRESH_MS = 60 * 60_000
/** How often the whole journal history is re-read and reports recomputed; appends in between only mark it stale. */
const REBUILD_INTERVAL_MS = 5 * 60_000

/** The rebuild interval, with the e2e override for tests that need to move it. */
export function costRebuildIntervalMs(): number {
	const value = Number(readE2eSeam("KIMCHI_E2E_COST_REBUILD_MS") ?? Number.NaN)
	return Number.isSafeInteger(value) && value >= 0 ? value : REBUILD_INTERVAL_MS
}

/** Rebuilds requested by user action skip the interval: the next pass for this directory re-reads the journals. */
export function requestWorkCostRebuild(agentDir: string): void {
	forcedRebuilds.add(resolve(agentDir))
}
const forcedRebuilds = new Set<string>()

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
		const stat = statSync(path)
		// Re-parsing the scheduling state cost a full pass on every tick with a large history;
		// the file identity keys the cache, so any writer invalidates it. The caller mutates
		// the returned object toward what it writes back, keeping cache and file in step.
		if (cachedPolls?.path === path && cachedPolls.ino === stat.ino && cachedPolls.size === stat.size)
			return cachedPolls.polls
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
		cachedPolls = { path, ino: stat.ino, size: stat.size, polls }
	} catch {}
	return polls
}
let cachedPolls: { path: string; ino: number; size: number; polls: Record<string, BillingPoll> } | undefined

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
	const costRefreshes = new Map(
		[...requests.values()].flatMap((item) =>
			!item.invalid && item.substantiveLookup?.status === "priced"
				? [[item.requestId, item.substantiveLookup.checkedAt] as const]
				: [],
		),
	)
	return { records, report, requests, costRefreshes }
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
	/** When this state was computed; a journal change within the rebuild interval still reuses it. */
	rebuiltAt: number
	/** Refresh failures shown by the last complete publish of this calculation. */
	published?: string
	/** The parsed records behind this calculation, so a forced rebuild re-reads only appends. */
	records: WorkRecord[]
	/** Where each journal was read to on the last parse; journals only grow. */
	positions: Map<string, JournalPosition>
}

let lastCostState: CostState | undefined

/**
 * The calculation is a pure function of the journals, so passes reuse it until a journal changes.
 * A change within the rebuild interval also reuses it: normal use appends records every few minutes,
 * and re-reading the whole history on every 30-second pass made idle cost grow with that history.
 * `force` re-reads at once: after this pass's own appends, and when a user action requested a refresh.
 */
async function costState(agentDir: string, signal: AbortSignal, force = false): Promise<CostState> {
	// Fingerprint before reading: an append during the read only makes the next pass recalculate.
	const fingerprint = await workJournalFingerprint(agentDir)
	if (lastCostState?.agentDir === agentDir && lastCostState.fingerprint === fingerprint) return lastCostState
	if (
		!force &&
		lastCostState?.agentDir === agentDir &&
		!forcedRebuilds.delete(resolve(agentDir)) &&
		Date.now() - lastCostState.rebuiltAt < costRebuildIntervalMs()
	)
		return lastCostState
	const previous = lastCostState?.agentDir === agentDir ? lastCostState : undefined
	// Journals only grow, so when the previous calculation already parsed them only the
	// appended bytes are read back; a full drain of open items re-parsed the whole history
	// on every 30-second pass otherwise. A journal replaced, shrunk or removed by anything
	// else falls back to the full read, as does the first build.
	let records: WorkRecord[]
	let positions: Map<string, JournalPosition>
	if (previous && journalsExtend(previous.positions)) {
		positions = new Map(previous.positions)
		records = [...previous.records, ...readAppendedWorkRecords(agentDir, positions)]
	} else {
		records = await readWorkRecordsAsync(agentDir, signal)
		positions = journalPositions(agentDir)
	}
	// The calculation cannot stop midway; a closing session must not wait for one it no longer needs.
	signal.throwIfAborted()
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
		records,
		positions,
		rebuiltAt: Date.now(),
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

function group<K, T>(groups: Map<K, T[]>, key: K, value: T): void {
	const values = groups.get(key)
	if (values) values.push(value)
	else groups.set(key, [value])
}

/** A long work's full report is large; it is refreshed at most this often, and `/work` reads the totals instead. */
const REPORT_REFRESH_MS = 5 * 60_000
/** When this process last refreshed each work's full report. Its first pass refreshes every report. */
const reportRefreshes = new Map<string, number>()
/** Hash of each work's last written report content; an unchanged component costs a pass nothing. */
const publishedContents = new Map<string, string>()
function reportRefreshMs(): number {
	const value = Number(readE2eSeam("KIMCHI_E2E_COST_REPORT_REFRESH_MS") ?? Number.NaN)
	return Number.isSafeInteger(value) && value >= 0 ? value : REPORT_REFRESH_MS
}
async function writeChanged(path: string, content: string, assertLease: () => void): Promise<void> {
	try {
		if (readFileSync(path, "utf8") === content) return
	} catch {}
	await writeFileDurably(path, content, assertLease)
}
async function publishReports(
	agentDir: string,
	{ displays, report, workIds }: CostState,
	polls: Record<string, BillingPoll>,
	assertLease: () => void,
): Promise<boolean> {
	trackPRCostMetric({
		kind: "unpriced",
		value: report.requests.filter((request) => request.priceStatus !== "priced").length,
	})
	// Shared PR totals and correction links connect works, transitively; a saved report covers the whole component.
	const neighbours = new Map<string, Set<string>>()
	for (const ids of [
		...report.pullRequests.map((row) => row.workIds),
		...report.requests.map((row) => [...row.workIds, ...(row.linkedWorkIds ?? [])]),
	])
		for (const id of ids) {
			const linked = neighbours.get(id) ?? new Set<string>()
			for (const other of ids) linked.add(other)
			neighbours.set(id, linked)
		}
	const components = new Map<string, Set<string>>()
	const component = (workId: string) => {
		let found = components.get(workId)
		if (found) return found
		found = new Set([workId])
		// A Set iterator also visits members added during the loop, so this walks the whole component once.
		for (const id of found) for (const other of neighbours.get(id) ?? []) found.add(other)
		for (const id of found) components.set(id, found)
		return found
	}
	// Group rows by component once instead of filtering every row for every work.
	const pullRequests = new Map<Set<string>, PullRequestCost[]>()
	for (const row of report.pullRequests) if (row.workIds.length) group(pullRequests, component(row.workIds[0]), row)
	const requests = new Map<Set<string>, RequestCostAllocation[]>()
	for (const row of report.requests) if (row.workIds.length) group(requests, component(row.workIds[0]), row)
	const shown = (row: RequestCostAllocation): SavedRequestCost => {
		const display = displays.get(row.requestId)
		const failure = shownFailure(display, polls[row.requestId])
		return {
			...row,
			...(display?.tagSkipped ? { billingTagSkipped: display.tagSkipped } : {}),
			billingLookup: failure
				? { status: "unavailable", checkedAt: failure.checkedAt, ...display?.refresh, reason: failure.reason }
				: (display?.billingLookup ?? { status: "pending", reason: "No captured billing source or request selector" }),
		}
	}
	// Members of one component share the same rows, so build them once per component.
	const contents = new Map<
		Set<string>,
		{ pullRequests: PullRequestCost[]; requests: SavedRequestCost[]; unallocated: Record<string, CostTotal> }
	>()
	const content = (included: Set<string>) => {
		let found = contents.get(included)
		if (found) return found
		const workRequests = requests.get(included) ?? []
		found = {
			pullRequests: pullRequests.get(included) ?? [],
			requests: workRequests.map(shown),
			unallocated: Object.fromEntries(
				Object.keys(report.unallocated).map((kind) => [
					kind,
					totalRequestCosts(workRequests.filter((row) => row.allocation === kind)),
				]),
			),
		}
		contents.set(included, found)
		return found
	}
	// A full report left for a later pass keeps this calculation unpublished, so that pass still writes it.
	let deferred = false
	for (const workId of workIds) {
		assertLease()
		const directory = join(agentDir, "work", workId)
		// Members of one component repeat the same rows; when those rows did not change since the last
		// publish, neither the full report nor the totals need rewriting.
		const rows = JSON.stringify(content(component(workId)))
		const digest = createHash("sha256").update(rows).digest("hex")
		if (
			publishedContents.get(workId) === digest &&
			existsSync(join(directory, "costs.json")) &&
			existsSync(join(directory, "cost-totals.json"))
		)
			continue
		await mkdir(directory, { recursive: true, mode: 0o700 })
		// ponytail: connected works repeat in per-work files; use one shared snapshot if storage growth warrants it.
		const value = { version: 1, workId, ...content(component(workId)) }
		// `/work` and its browser read only these bounded totals.
		await writeChanged(
			join(directory, "cost-totals.json"),
			`${JSON.stringify(workCostTotals(value), null, 2)}\n`,
			assertLease,
		)
		// The accuracy CLI and lab read the full report. A missing one is rebuilt at once.
		const path = join(directory, "costs.json")
		const now = Date.now()
		if (now - (reportRefreshes.get(workId) ?? Number.NEGATIVE_INFINITY) < reportRefreshMs() && existsSync(path)) {
			deferred = true
			continue
		}
		await writeChanged(path, `${JSON.stringify(value, null, 2)}\n`, assertLease)
		reportRefreshes.set(workId, now)
		publishedContents.set(workId, digest)
	}
	return !deferred
}

/** Called by the shared supervisor's lease holder; model inference never waits for this pass. */
export async function reconcileWorkCosts(
	agentDir: string,
	signal: AbortSignal,
	assertLease: () => void = () => {},
): Promise<void> {
	const state = await costState(agentDir, signal)
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
			const age = Date.now() - (endsAt - LOOKUP_WINDOW_MS)
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
				// no evidence: keep the last known result and only remember the failure.
				if (!pageReceived) {
					const previous = polls[item.requestId]
					polls[item.requestId] = {
						checkedAt: Date.parse(lookup.checkedAt),
						lookupAt: item.lookup?.checkedAt ?? "",
						// A repeated failure keeps its first observation: retry times are scheduling
						// state, and changing them here churns every report that shows the failure.
						failure:
							previous?.failure?.reason === lookup.reason
								? previous.failure
								: { checkedAt: lookup.checkedAt, reason: lookup.reason },
					}
					continue
				}
			}
			assertLease()
			const previousLookup = item.lookup
			// The journal must prove that the window closed, even when the final result is unchanged.
			// A changed account never closes it: that lookup did not reach the billing API.
			const final = Date.parse(lookup.checkedAt) >= endsAt && lookup.status !== "account-changed"
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
		// The pass's own appends force a rebuild so the same pass publishes them, but the rebuild
		// re-reads only the appended bytes (see costState): while open items drain — thirty a pass —
		// a full re-read here would parse the whole journal history on every 30-second tick.
		const latest = changed ? await costState(agentDir, signal, true) : state
		signal.throwIfAborted()
		assertLease()
		// Closed windows, which the journal now proves, and vanished requests need no scheduling state.
		const open = new Set(latest.open.map((item) => item.requestId))
		for (const requestId of Object.keys(polls)) if (!open.has(requestId)) delete polls[requestId]
		const currentPolls = JSON.stringify(polls)
		if (currentPolls !== previousPolls) writeFileAtomic(pollingPath, `${currentPolls}\n`)
		const failures = refreshFailures(latest, polls)
		// Unchanged inputs give unchanged reports; only a deleted report or totals file needs writing again.
		if (
			latest.published === failures &&
			latest.workIds.every((workId) =>
				["costs.json", "cost-totals.json"].every((name) => existsSync(join(agentDir, "work", workId, name))),
			)
		)
			return
		const complete = await publishReports(agentDir, latest, polls, () => {
			signal.throwIfAborted()
			assertLease()
		})
		if (complete) latest.published = failures
	} finally {
		clearTimeout(timeout)
	}
}
