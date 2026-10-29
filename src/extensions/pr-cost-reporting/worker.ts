import { createHash } from "node:crypto"
import { setImmediate } from "node:timers/promises"
import { verifyApiKey } from "../../api/organizations.js"
import { GATEWAY_ORGANIZATION_HEADER, resolveGatewayCredentials } from "../../auth/gateway-credentials.js"
import { loadConfig } from "../../config.js"
import { type StatPoller, startStatPoller } from "../../shared/stat-poller.js"
import { boundedResponse, parseRetryAfterMs } from "../../utils/http.js"
import { plainURL } from "../../utils/url.js"
import { pullRequestKey } from "../pull-request-status/links.js"
import { lookupRepositoryIdentity } from "../pull-request-status/provider-api.js"
import { LookupError } from "../pull-request-status/provider-records.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"
import { mapInChunks, runCooperatively } from "../work-attribution/cooperative.js"
import { readWorkCostReport, readWorkCostReportSteps } from "../work-attribution/cost-sync.js"
import type { PullRequestCostReport } from "../work-attribution/costs.js"
import { isWorkAccount, isWorkScope, platformApiUrl } from "../work-attribution/scope.js"
import { importWorkRecordsAsync, object, type WorkRecord } from "../work-attribution/summary.js"
import { buildEvents, buildEventsSteps } from "./events.js"
import {
	advanceGroupCache,
	groupKey,
	mergeSharedFacts,
	observationUnits,
	prepareGroupCache,
	readChangedGroup,
	requestIndexEntries,
	sameCachedRepositories,
	saveGroupCache,
	verifySharedHeads,
} from "./incremental.js"
import {
	acknowledgeBatch,
	deliveryRetry,
	effectiveClaim,
	type Fact,
	observeEvents,
	pendingBatch,
	readDeliveryStatus,
} from "./ledger/outbox.js"
import {
	backendFor,
	type OutboxBatch,
	type RecordBackend,
	readGroupRequestRecordsAsync,
	readGroupStoredRecordsAsync,
} from "./ledger/records.js"
import type { Acknowledgement } from "./protocol.js"
import {
	readReportingState,
	recordReportingError,
	reportingProducer,
	reportingStatePath,
	withReportingConsent,
} from "./queue.js"
import { accountKey, type ReportingRepository, type RepositoryIdentity } from "./snapshot.js"

const PASS_MS = 5000
/** Time a delivery pass keeps for finishing one more batch upload and its acknowledgement. */
const DELIVERY_RESERVE_MS = 500
const RESPONSE_BYTES = 64 * 1024
/** How often the reporting state file is stat-polled for a mid-pass opt-out. */
const OPT_OUT_POLL_MS = 250
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
/** Provider repository IDs are stable, so a found identity, or the lack of a supported remote, is kept a day. */
const REPOSITORY_CACHE_MS = 24 * HOUR_MS
/** The longest wait between attempts: about six hours. */
export const LIMIT_RETRY_MS = 6 * HOUR_MS
/** ±20%, so that clients rejected together do not come back together. */
const jitter = (ms: number) => Math.round(ms * (0.8 + 0.4 * Math.random()))
/**
 * Transient failures (timeouts, 408, 429 and 5xx) honor a bounded Retry-After, or back
 * off from 30 seconds to 30 minutes. Other 4xx responses, such as an endpoint not deployed yet, cannot
 * be fixed by retrying and wait one to six hours.
 */
export function retryDelay(status: number | undefined, attempts: number, retryAfterMs: number | null): number {
	if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429)
		return jitter(Math.min(LIMIT_RETRY_MS, HOUR_MS * 2 ** attempts))
	if (retryAfterMs !== null) return Math.min(Math.max(retryAfterMs, 30_000), LIMIT_RETRY_MS)
	return jitter(Math.min(30 * MINUTE_MS, 30_000 * 2 ** attempts))
}

/** A failed lookup keeps its kind: a repository without a GitHub or GitLab identity is not missing evidence. */
const repositoryCache = new Map<string, { checkedAt: number; value?: ReportingRepository; unsupported?: true }>()

function safeEndpoint(value: string): boolean {
	const url = plainURL(value, ["https:", "http:"])
	return url?.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url?.hostname ?? "")
}

/** Delivery shares one cancellation, opt-out polling and lease boundary per pass. */
async function reportingDelivery(
	agentDir: string,
	signal: AbortSignal,
	assertLease: () => void,
	deadline: number,
	deliver: (signal: AbortSignal, check: () => void) => Promise<void>,
): Promise<void> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()))
	timer.unref()
	const combined = AbortSignal.any([signal, controller.signal])
	const check = () => {
		assertLease()
		combined.throwIfAborted()
	}
	// Seeing an opt-out from another process mid-upload is an optimisation: each upload rereads the state anyway.
	// Stat polling has no inotify or FSEvents involvement, and a failure to start it still leaves delivery working.
	// The state can reach 24 MiB, so one reread runs at a time; changes seen during it cause one more.
	let poller: StatPoller | undefined
	let rereading = false
	let changedAgain = false
	const reread = () => {
		if (rereading) {
			changedAgain = true
			return
		}
		rereading = true
		void readReportingState(agentDir)
			.then(
				(state) => {
					if (!state.enabled) controller.abort()
				},
				() => controller.abort(),
			)
			.finally(() => {
				rereading = false
				if (!changedAgain || !poller?.isActive()) return
				changedAgain = false
				reread()
			})
	}
	const statePath = reportingStatePath(agentDir)
	try {
		poller = startStatPoller(statePath, OPT_OUT_POLL_MS, reread)
	} catch {}
	try {
		await deliver(combined, check)
	} finally {
		controller.abort()
		poller?.stop()
		poller = undefined
		clearTimeout(timer)
	}
}

/** Frozen delta batches use the existing reporting worker; inference and proxy metrics are not prerequisites. */
export function deliverEvents(
	agentDir: string,
	cwd: string,
	signal: AbortSignal,
	assertLease: () => void,
	deadline = Date.now() + PASS_MS,
): Promise<void> {
	return reportingDelivery(agentDir, signal, assertLease, deadline, async (combined, check) => {
		const backend = backendFor(agentDir)
		/** The credential is verified once for the whole pass, not before every batch. */
		let verified: Awaited<ReturnType<typeof verifyApiKey>> | undefined
		let verifiedKey: string | undefined
		// Keep sending while the pass has time left: one iteration sends one frozen batch.
		while (Date.now() < deadline - DELIVERY_RESERVE_MS) {
			check()
			const due = readDeliveryStatus(agentDir).filter((status) => (status.retry?.retryAt ?? 0) <= Date.now())
			if (!due.length) return
			const { token: key, organizationId } = resolveGatewayCredentials(loadConfig({ cwd }))
			const apiUrl = platformApiUrl(cwd)
			if (!key || !safeEndpoint(apiUrl)) return
			const assertOwnership = () => {
				assertLease()
				if (resolveGatewayCredentials(loadConfig({ cwd })).token !== key || platformApiUrl(cwd) !== apiUrl)
					throw new Error("PR reporting credentials changed")
			}
			const assertCurrent = () => {
				assertOwnership()
				combined.throwIfAborted()
			}
			let status: number | undefined
			let retryAfterMs: number | null = null
			let errorMessage = "PR cost event upload unavailable"
			const readResponse = async (response: Response): Promise<Response> => {
				assertCurrent()
				status = response.status
				retryAfterMs = parseRetryAfterMs(response)
				if (!response.ok)
					errorMessage =
						response.status === 403
							? "PR reporting is not allowed for this API key: uploading PR costs needs an Owner or Member role (HTTP 403)"
							: `PR cost event upload returned HTTP ${response.status}`
				const bounded = await boundedResponse(
					response,
					RESPONSE_BYTES,
					combined,
					"PR reporting response exceeds the size limit",
				)
				assertCurrent()
				return bounded
			}
			const fetchBounded: typeof fetch = async (input, init) => {
				assertCurrent()
				const current = await readReportingState(agentDir)
				assertCurrent()
				if (!current.enabled) throw new Error("PR reporting is disabled")
				return readResponse(await fetch(input, { ...init, redirect: "error", signal: combined }))
			}
			const resume = backend.getNote("agent", "legacy-snapshot-resume")
			/** Each waiting account backs off on its own schedule. */
			const defer = (accounts: typeof due, error: string) =>
				backend.tx(() => {
					assertOwnership()
					for (const { accountKey: id, firstBatchId, retry } of accounts) {
						const attempts = retry?.attempts ?? 0
						const retryAt = Date.now() + retryDelay(status, attempts, retryAfterMs)
						const body = { batchId: firstBatchId, attempts: attempts + 1, retryAt, resume, error }
						backend.putNote("pr-cost-delivery", id, JSON.stringify(body))
					}
				})
			if (verifiedKey !== key) {
				verifiedKey = key
				verified = undefined
				try {
					verified = await verifyApiKey(key, {
						endpoint: apiUrl,
						organizationId,
						fetch: fetchBounded,
						signal: combined,
						retry: { maxRetries: 0 },
					})
				} catch {}
			}
			// Cancellation, an opt-out and changed credentials end the pass; a failed verification backs off below.
			assertCurrent()
			const account = verified && { apiUrl, ...verified }
			if (!account || !isWorkAccount(account)) {
				// A rejected or unreachable verification waits like a failed upload instead of repeating every pass.
				defer(due, errorMessage)
				await recordReportingError(agentDir, errorMessage)
				return
			}
			const accountId = accountKey(account)
			// Events captured under another account wait for its credential without verifying on every pass.
			const others = due.filter((status) => status.accountKey !== accountId)
			if (others.length) defer(others, "PR reporting is waiting for the original account")
			const own = due.filter((status) => status.accountKey === accountId)
			if (!own.length) return
			let batch: OutboxBatch | undefined
			const ready = await withReportingConsent(
				agentDir,
				(fence) => {
					batch = pendingBatch(agentDir, accountId, fence)
				},
				assertCurrent,
			)
			if (!ready || !batch) return
			const sent = batch
			const schedule = deliveryRetry(backend, accountId, sent.id)
			if (schedule && schedule.retryAt > Date.now()) return
			status = undefined
			retryAfterMs = null
			try {
				let dispatched: Promise<Response> | undefined
				if (
					!(await withReportingConsent(
						agentDir,
						(fence) => {
							const current = pendingBatch(agentDir, accountId, fence)
							if (!current || current.id !== sent.id || !Buffer.from(current.body).equals(Buffer.from(sent.body)))
								throw new Error("PR cost event batch changed")
							fence()
							// Launch right after the consent check; await network and body reads outside it.
							dispatched = fetch(
								`${apiUrl}/ai-optimizer/v1beta/organizations/${account.organizationId}/pr-cost-events:batchIngest`,
								{
									method: "POST",
									body: Buffer.from(sent.body).toString("utf8"),
									redirect: "error",
									signal: combined,
									headers: {
										Authorization: `Bearer ${key}`,
										...(organizationId ? { [GATEWAY_ORGANIZATION_HEADER]: organizationId } : {}),
										"Content-Type": "application/json",
										Accept: "application/json",
									},
								},
							)
							void dispatched.catch(() => {})
						},
						assertCurrent,
					))
				)
					return
				if (!dispatched) throw new Error("PR cost event batch was not dispatched")
				const response = await readResponse(await dispatched)
				assertCurrent()
				if (!response.ok) throw new Error(errorMessage)
				const ack: Acknowledgement = await response.json()
				assertCurrent()
				let acknowledged = false
				if (
					!(await withReportingConsent(
						agentDir,
						(fence) => {
							backend.tx(() => {
								acknowledged = acknowledgeBatch(agentDir, accountId, sent, ack, fence)
								if (acknowledged) backend.deleteNote("pr-cost-delivery", accountId)
								fence()
							})
						},
						assertCurrent,
					)) ||
					!acknowledged
				)
					return
				trackPRCostMetric({ kind: "delivery", outcome: "success" })
			} catch {
				trackPRCostMetric({ kind: "delivery", outcome: combined.aborted ? "canceled" : "failed" })
				if (signal.aborted) return
				try {
					assertOwnership()
				} catch {
					return
				}
				const attempts = Number(schedule?.attempts ?? 0)
				backend.tx(() => {
					assertOwnership()
					if (backend.getOutboxBatch(accountId)?.id !== sent.id) return
					// 409: the server holds other content under this batch ID, so its events go out in a new batch.
					if (status === 409) backend.deleteOutboxBatch(accountId, sent.id)
					else
						backend.putNote(
							"pr-cost-delivery",
							accountId,
							JSON.stringify({
								batchId: sent.id,
								attempts: attempts + 1,
								retryAt: Date.now() + retryDelay(status, attempts, retryAfterMs),
								resume,
								error: errorMessage,
							}),
						)
					assertOwnership()
				})
				await recordReportingError(agentDir, errorMessage)
				return
			}
		}
	})
}

const CAPTURE_FAILED = "PR reporting could not capture a complete inventory; previous reports were retained"

/** Runs after local pricing, under the existing reconciliation lease, in sessions that may upload. */
export async function reconcileReporting(
	agentDir: string,
	cwd: string,
	signal: AbortSignal,
	assertLease: () => void,
): Promise<void> {
	const state = await readReportingState(agentDir)
	assertLease()
	signal.throwIfAborted()
	if (!state.enabled) return
	try {
		await captureEvents(agentDir, signal, assertLease)
	} catch (error) {
		if (!signal.aborted) await recordReportingError(agentDir, captureFailure(error))
	}
	// Batches already queued go out even when this pass could not capture new evidence.
	if (signal.aborted) return
	try {
		await deliverEvents(agentDir, cwd, signal, assertLease, Date.now() + PASS_MS)
	} catch {
		if (!signal.aborted) await recordReportingError(agentDir, "PR reporting could not deliver queued reports")
	}
}

/** At most this many requests or auxiliary records commit their events in one transaction. */
const CHUNK_UNITS = 100
/** Large groups use a longer local build, but yield and keep the original lease and cancellation. */
const COOPERATIVE_RECORDS = 1000
/** Auxiliary evidence alone should not trigger request-only repository preflight. */
const PREFLIGHT_REQUESTS = 1000
const GROUP_BUILD_MS = 3 * 60_000
const GROUP_BUILD_BACKOFF_MS = 5 * MINUTE_MS
const GROUP_BUILD_BACKOFF_NOTE = "translation-build-backoff-v1:"
/** Time a pass keeps for committing one more chunk and delivering what it captured. */
const CHUNK_RESERVE_MS = 500
/** Each group's committed units survive later groups running before it resumes. */
const PROGRESS_NOTE = "translation-progress-v2:"
/** Next group to try after one used the rest of a pass. */
const NEXT_GROUP_NOTE = "translation-next-group"
class CaptureTimeLimit extends Error {}
class GroupBuildTimeLimit extends CaptureTimeLimit {}

function captureFailure(error: unknown): string {
	let reason: string
	if (error instanceof CaptureTimeLimit) reason = "local capture time limit exceeded"
	else if (error instanceof Error && error.message === "PR reporting is waiting for readable source records")
		reason = "source records are unreadable"
	else {
		const code = object(error) ? error.code : undefined
		switch (code) {
			case "EACCES":
			case "EPERM":
				reason = "source access denied"
				break
			case "ENOSPC":
				reason = "disk is full"
				break
			case "ENOENT":
				reason = "source changed while reading"
				break
			case "SQLITE_BUSY":
				reason = "ledger is busy"
				break
			default:
				reason = "unexpected capture error"
		}
	}
	return `${CAPTURE_FAILED}: ${reason}`
}

/**
 * Translates the works whose records changed since their last translation into events, one connected group at a
 * time. A pass that runs out of time resumes where it stopped.
 */
async function captureEvents(agentDir: string, signal: AbortSignal, assertLease: () => void): Promise<void> {
	const deadline = Date.now() + PASS_MS
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(PASS_MS)])
	const check = () => {
		assertLease()
		signal.throwIfAborted()
		if (bounded.aborted || Date.now() >= deadline) throw new CaptureTimeLimit("PR reporting pass time limit exceeded")
	}
	check()
	let historyComplete = true
	await importWorkRecordsAsync(
		agentDir,
		check,
		() => {
			historyComplete = false
		},
		true,
	)
	if (!historyComplete) throw new Error("PR reporting is waiting for readable source records")
	const backend = backendFor(agentDir)
	const marked = new Map<string, Map<string, string>>()
	for (const { recordHash, workId, type } of backend.markedRecords()) {
		const work = marked.get(workId) ?? new Map<string, string>()
		work.set(recordHash, type)
		marked.set(workId, work)
	}
	if (!marked.size) {
		// Nothing changed since the last translation; only a failure an earlier pass recorded is out of date.
		if ((await readReportingState(agentDir)).error?.startsWith(CAPTURE_FAILED))
			await recordReportingError(agentDir, undefined)
		return
	}
	const producer = await reportingProducer(agentDir, check)
	let waiting = false
	const groups = changedWorkGroups(backend, new Set(marked.keys()))
	const next = backend.getNote("agent", NEXT_GROUP_NOTE)
	const start = next
		? Math.max(
				0,
				groups.findIndex((group) => group[0] >= next),
			)
		: 0
	const ordered = [...groups.slice(start), ...groups.slice(0, start)]
	for (const [index, works] of ordered.entries()) {
		if (Date.now() >= deadline - CHUNK_RESERVE_MS) {
			if (ordered.length > 1) backend.putNote("agent", NEXT_GROUP_NOTE, works[0])
			return
		}
		const backoffName = `${GROUP_BUILD_BACKOFF_NOTE}${groupKey(works)}`
		const backoff = backend.getNote("agent", backoffName)
		if (backoff && Date.now() < Number(backoff)) {
			waiting = true
			continue
		}
		const changed = new Map(works.flatMap((workId) => [...(marked.get(workId) ?? [])]))
		let translated: boolean | undefined
		let buildTimedOut = false
		try {
			translated = await translateGroup(
				agentDir,
				works,
				changed,
				producer,
				deadline,
				bounded,
				check,
				signal,
				assertLease,
			)
		} catch (error) {
			if (error instanceof GroupBuildTimeLimit) {
				backend.putNote("agent", backoffName, String(Date.now() + GROUP_BUILD_BACKOFF_MS))
				buildTimedOut = true
				translated = true
			} else if (!(error instanceof CaptureTimeLimit)) throw error
		}
		if (backoff && translated !== undefined && !buildTimedOut) backend.deleteNote("agent", backoffName)
		if (translated === undefined) {
			if (ordered.length > 1) backend.putNote("agent", NEXT_GROUP_NOTE, ordered[(index + 1) % ordered.length][0])
			return
		}
		waiting ||= translated
	}
	if (next) backend.deleteNote("agent", NEXT_GROUP_NOTE)
	await recordReportingError(
		agentDir,
		waiting ? "Some PR cost events are waiting for complete original evidence" : undefined,
	)
}

/**
 * Works that share a PR or a work link change each other's events: a PR's state and issue keys and a link's target
 * come from all of them. Each group holding a changed work translates together.
 */
function changedWorkGroups(backend: RecordBackend, changed: ReadonlySet<string>): string[][] {
	const parent = new Map<string, string>()
	const root = (node: string) => {
		let top = node
		for (let next = parent.get(top); next !== undefined; next = parent.get(top)) top = next
		return top
	}
	const join = (left: string, right: string) => {
		const a = root(left)
		const b = root(right)
		if (a !== b) parent.set(a, b)
	}
	const works = new Set(changed)
	for (const head of backend.allHeads()) {
		works.add(head.workId)
		for (const link of head.pullRequests) {
			join(head.workId, `pr:${pullRequestKey(link)}`)
			if (typeof link.url === "string") join(head.workId, `url:${link.url}`)
		}
	}
	for (const row of backend.readRecords({ type: "work_link" })) {
		const link: unknown = JSON.parse(row.body)
		if (!object(link)) continue
		for (const workId of [link.sourceWorkId, link.targetWorkId])
			if (typeof workId === "string") {
				works.add(workId)
				join(row.workId, workId)
			}
	}
	const groups = new Map<string, string[]>()
	for (const workId of [...works].sort()) {
		const group = groups.get(root(workId)) ?? []
		group.push(workId)
		groups.set(root(workId), group)
	}
	return [...groups.values()].filter((group) => group.some((workId) => changed.has(workId)))
}

/**
 * Rebuilds one group from all of its records and observes the units its changed records touch, in bounded
 * transactions. Returns whether any touched request still waits for evidence, or undefined when time ran out.
 */
async function translateGroup(
	agentDir: string,
	works: string[],
	changed: ReadonlyMap<string, string>,
	producer: string,
	deadline: number,
	bounded: AbortSignal,
	check: () => void,
	signal: AbortSignal,
	assertLease: () => void,
	forceFull = false,
): Promise<boolean | undefined> {
	const backend = backendFor(agentDir)
	const fast = forceFull ? undefined : readChangedGroup(backend, works, producer, changed, check)
	const cooperative =
		fast !== undefined || works.reduce((count, workId) => count + backend.recordCount(workId), 0) > COOPERATIVE_RECORDS
	const groupDeadline = cooperative ? Date.now() + GROUP_BUILD_MS : deadline
	const groupCheck = () => {
		if (!cooperative) return check()
		assertLease()
		signal.throwIfAborted()
		if (Date.now() >= groupDeadline) throw new GroupBuildTimeLimit("PR reporting group build time limit exceeded")
	}
	const through = fast?.through ?? backend.recordWatermark()
	if (
		cooperative &&
		!fast &&
		works.reduce((count, workId) => count + backend.requestCount(workId), 0) > PREFLIGHT_REQUESTS
	) {
		const requests = await readGroupRequestRecordsAsync(agentDir, works, groupCheck)
		const lookup = await repositoryIdentities(
			agentDir,
			requests,
			undefined,
			Date.now() + PASS_MS,
			AbortSignal.any([signal, AbortSignal.timeout(PASS_MS)]),
			groupCheck,
		)
		if (!lookup.settled) return true
	}
	const stored = fast
		? works.flatMap((workId) => [
				...fast.cache.context.filter((row) => row.workId === workId),
				...fast.stored.filter((row) => row.workId === workId),
			])
		: cooperative
			? await readGroupStoredRecordsAsync(agentDir, works, groupCheck)
			: works.flatMap((workId) => backend.readRecords({ workId }, check))
	const records = fast
		? stored.map((row) => JSON.parse(row.body) as WorkRecord)
		: cooperative
			? await runCooperatively(
					mapInChunks(stored, 128, (row) => JSON.parse(row.body) as WorkRecord),
					groupCheck,
				)
			: stored.map((row) => {
					check()
					return JSON.parse(row.body) as WorkRecord
				})
	const { report } = cooperative
		? await runCooperatively(readWorkCostReportSteps(agentDir, records), groupCheck)
		: readWorkCostReport(agentDir, records)
	if (fast)
		for (const [requestId, prior] of fast.replayed)
			if (JSON.stringify(report.requests.find((row) => row.requestId === requestId)) !== JSON.stringify(prior.result))
				return translateGroup(agentDir, works, changed, producer, deadline, bounded, check, signal, assertLease, true)
	const { repositories, settled } = await repositoryIdentities(
		agentDir,
		records,
		report,
		cooperative ? Date.now() + PASS_MS : deadline,
		cooperative ? AbortSignal.any([signal, AbortSignal.timeout(PASS_MS)]) : bounded,
		groupCheck,
	)
	if (fast && !sameCachedRepositories(fast.cache, repositories))
		return translateGroup(agentDir, works, changed, producer, deadline, bounded, check, signal, assertLease, true)
	// The complete build keeps shared facts and the group projection; touched only narrows the cached path.
	const touchedRequests = new Set(
		records.flatMap((row, index) =>
			changed.has(stored[index].recordHash) && typeof row.requestId === "string" ? [row.requestId] : [],
		),
	)
	const touched = fast ? { requests: touchedRequests, records: new Set(changed.keys()) } : undefined
	const claim = (account: string, entity: string) => effectiveClaim(backend, account, entity)
	const partial = cooperative
		? await runCooperatively(
				buildEventsSteps(stored, report, repositories, producer, groupCheck, claim, touched, records),
				groupCheck,
			)
		: buildEvents(stored, report, repositories, producer, check, claim, touched)
	const built = fast ? mergeSharedFacts(fast.cache, partial) : partial
	groupCheck()
	const cache = settled
		? fast
			? advanceGroupCache(backend, fast.cache, through, fast.rows, repositories, built)
			: prepareGroupCache(backend, works, producer, through, stored, records, repositories, built)
		: undefined
	if (cache && !fast) {
		const index = requestIndexEntries(stored, records, report)
		for (let offset = 0; offset < index.length; offset += 100) {
			groupCheck()
			backend.tx(() => {
				for (const entry of index.slice(offset, offset + 100)) backend.putNote(entry.owner, entry.name, entry.body)
			})
			await setImmediate()
		}
	}
	const facts = new Map(
		built.accounts.map((group) => [
			accountKey(group.account),
			new Map(group.facts.map((fact) => [fact.entityId, fact])),
		]),
	)
	// Without a cache, build every contributor but observe only changed request facts and the earlier shared carriers.
	// A structural change, invalidated cache or forced fallback can alter old allocations, so those observe all units.
	// A new billing source can also invalidate one request's bill and reprice another request sharing that bill.
	const pruneUnchanged =
		!fast &&
		!forceFull &&
		!backend.hasNote("agent", groupKey(works)) &&
		!records.some(
			(row, index) =>
				row.type === "request_response" && row.billingSource !== undefined && changed.has(stored[index].recordHash),
		) &&
		[...changed.values()].every(
			(type) => type === "request" || type === "request_response" || type === "tool_execution",
		)
	const units = fast
		? observationUnits(fast.cache, built)
		: pruneUnchanged
			? built.units.flatMap((unit) => {
					if (unit.requestId === undefined)
						return unit.recordHashes.some((recordHash) => changed.has(recordHash)) ? [unit] : []
					if (touchedRequests.has(unit.requestId)) return [unit]
					const shared = unit.entities.slice(1)
					return shared.length ? [{ ...unit, entities: shared }] : []
				})
			: built.units
	const hash = (parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex")
	const progress = {
		group: hash(works),
		markers: changed.size,
		plan: hash(units.map((unit) => unit.requestId ?? unit.recordHashes.join())),
	}
	const progressNote = `${PROGRESS_NOTE}${progress.group}`
	const saved: unknown = JSON.parse(backend.getNote("agent", progressNote) ?? "null")
	let done =
		object(saved) &&
		saved.group === progress.group &&
		saved.markers === progress.markers &&
		saved.plan === progress.plan &&
		Number.isSafeInteger(saved.units)
			? Number(saved.units)
			: 0
	const observed = new Set<string>()
	while (done < units.length) {
		if (Date.now() >= groupDeadline - CHUNK_RESERVE_MS) {
			if (cooperative && done === 0) throw new GroupBuildTimeLimit("PR reporting group build time limit exceeded")
			return undefined
		}
		const chunk = units.slice(done, done + CHUNK_UNITS)
		const byAccount = new Map<string, Fact[]>()
		for (const unit of chunk)
			for (const entity of unit.entities) {
				const fact = facts.get(unit.account)?.get(entity)
				const id = `${unit.account}\0${entity}`
				if (!fact || observed.has(id)) continue
				observed.add(id)
				const list = byAccount.get(unit.account) ?? []
				list.push(fact)
				byAccount.set(unit.account, list)
			}
		done += chunk.length
		backend.tx(() => {
			if (fast && done === chunk.length && !verifySharedHeads(backend, fast.cache))
				throw new Error("PR reporting shared facts changed during incremental capture")
			for (const [account, list] of byAccount) observeEvents(agentDir, account, list, [], groupCheck)
			if (done === units.length) {
				// A repository lookup that failed retries the group with a later pass.
				if (settled) {
					if (cache) {
						if (fast)
							for (const entry of requestIndexEntries(fast.stored, fast.rows, report, fast.replayed))
								backend.putNote(entry.owner, entry.name, entry.body)
						saveGroupCache(backend, {
							...cache,
							shared: cache.shared.map((entry) => {
								const head = backend.latestOutboxEvent(entry.account, entry.entityId)
								return { ...entry, headId: head?.id ?? null, headHash: head?.hash ?? null }
							}),
						})
					} else backend.deleteNote("agent", groupKey(works))
					backend.clearTranslations(new Set(changed.keys()))
				}
				backend.deleteNote("agent", progressNote)
			} else backend.putNote("agent", progressNote, JSON.stringify({ ...progress, units: done }))
		})
		await setImmediate()
	}
	if (units.length === 0)
		backend.tx(() => {
			groupCheck()
			if (settled) {
				if (cache) saveGroupCache(backend, cache)
				else backend.deleteNote("agent", groupKey(works))
				backend.clearTranslations(new Set(changed.keys()))
			}
			backend.deleteNote("agent", progressNote)
		})
	return built.unresolved.length > 0
}

/**
 * Provider identities of the repositories the report's requests ran in, from the cache or a bounded lookup; settled
 * once every one is known.
 */
async function repositoryIdentities(
	agentDir: string,
	records: WorkRecord[],
	report: PullRequestCostReport | undefined,
	deadline: number,
	bounded: AbortSignal,
	check: () => void,
): Promise<{ repositories: Map<string, RepositoryIdentity>; settled: boolean }> {
	const repositories = new Map<string, RepositoryIdentity>()
	const needed = new Set<string>()
	const requestRepositories = new Map<string, Set<string>>()
	for (const row of records)
		if (row.type === "request" && typeof row.requestId === "string" && row.requestId && isWorkScope(row.scope)) {
			const values = requestRepositories.get(row.requestId) ?? new Set<string>()
			values.add(row.scope.repository)
			requestRepositories.set(row.requestId, values)
		}
	if (report)
		for (const request of report.requests) {
			check()
			for (const repository of requestRepositories.get(request.requestId) ?? []) needed.add(repository)
		}
	else
		for (const values of requestRepositories.values()) {
			check()
			for (const repository of values) needed.add(repository)
		}
	for (const [key, cached] of repositoryCache)
		if (Date.now() - cached.checkedAt >= REPOSITORY_CACHE_MS) repositoryCache.delete(key)
	const cacheKey = (repository: string) => JSON.stringify([agentDir, repository])
	// One credential lookup per host and pass, not one per repository.
	const tokens: Parameters<typeof lookupRepositoryIdentity>[2] = new Map()
	for (const repository of needed) {
		const cached = repositoryCache.get(cacheKey(repository))
		if (cached?.value) repositories.set(repository, cached.value)
		else if (cached?.unsupported) repositories.set(repository, "unsupported")
	}
	for (const repository of [...needed].sort(
		(a, b) => (repositoryCache.get(cacheKey(a))?.checkedAt ?? 0) - (repositoryCache.get(cacheKey(b))?.checkedAt ?? 0),
	)) {
		const key = cacheKey(repository)
		const cached = repositoryCache.get(key)
		if (cached?.value || cached?.unsupported || (cached && Date.now() - cached.checkedAt < 30_000)) continue
		// Reserve time to persist and deliver known groups even when discovery is slow.
		if (Date.now() >= deadline - 2000) break
		check()
		try {
			const lookupMs = Math.min(3000, deadline - Date.now() - 1000)
			const value = await lookupRepositoryIdentity(
				repository,
				AbortSignal.any([bounded, AbortSignal.timeout(lookupMs)]),
				tokens,
			)
			repositoryCache.set(key, { checkedAt: Date.now(), value })
			repositories.set(repository, value)
		} catch (error) {
			// Transient failures (network, timeouts, rate limits) retry and leave the history incomplete meanwhile.
			const unsupported = error instanceof LookupError && error.kind === "unsupported"
			repositoryCache.set(key, { checkedAt: Date.now(), ...(unsupported ? { unsupported: true } : {}) })
			if (unsupported) repositories.set(repository, "unsupported")
			check()
		}
	}
	return { repositories, settled: [...needed].every((repository) => repositories.has(repository)) }
}
