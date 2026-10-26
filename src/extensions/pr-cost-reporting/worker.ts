import { verifyApiKey } from "../../api/organizations.js"
import { GATEWAY_ORGANIZATION_HEADER, resolveGatewayCredentials } from "../../auth/gateway-credentials.js"
import { loadConfig } from "../../config.js"
import { type StatPoller, startStatPoller } from "../../shared/stat-poller.js"
import { boundedResponse, parseRetryAfterMs } from "../../utils/http.js"
import { plainURL } from "../../utils/url.js"
import { lookupRepositoryIdentity } from "../pull-request-status/provider-api.js"
import { LookupError } from "../pull-request-status/provider-records.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"
import { readWorkCostReport } from "../work-attribution/cost-sync.js"
import { isWorkAccount, isWorkScope, platformApiUrl, sameWorkAccount } from "../work-attribution/scope.js"
import { importWorkRecordsAsync, object, type WorkRecord, workJournalFingerprint } from "../work-attribution/summary.js"
import { buildEvents } from "./events.js"
import { reportJournalProblems } from "./ledger/import.js"
import {
	acknowledgeBatch,
	deliveryRetry,
	effectiveClaim,
	observeEvents,
	pendingBatch,
	readOutboxStatus,
} from "./ledger/outbox.js"
import { backendFor, type OutboxBatch, readStoredRecordsAsync } from "./ledger/records.js"
import type { Acknowledgement } from "./protocol.js"
import {
	ACCOUNT_SCOPES,
	acknowledgeFrozenSnapshot,
	deferFrozenSnapshot,
	freezeSnapshots,
	frozenSnapshotPending,
	inUploadWindow,
	LIMIT_NAMES,
	LIMIT_SCOPES,
	limitFrozenSnapshot,
	pendingFrozenSnapshots,
	readReportingState,
	recordReportingError,
	reportingProducer,
	reportingStatePath,
	reportingStateVersion,
	type ServerLimit,
	type SnapshotAck,
	withDrainedLegacyAccount,
} from "./queue.js"
import { accountKey, type ReportingRepository, type RepositoryIdentity } from "./snapshot.js"

const PASS_MS = 5000
const RESPONSE_BYTES = 64 * 1024
/** How often the reporting state file is stat-polled for a mid-pass opt-out. */
const OPT_OUT_POLL_MS = 250
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
/** Provider repository IDs are stable, so a found identity, or the lack of a supported remote, is kept a day. */
const REPOSITORY_CACHE_MS = 24 * HOUR_MS
/** A limit rejection waits about six hours; the server frees space on its own schedule. */
export const LIMIT_RETRY_MS = 6 * HOUR_MS
/** ±20%, so that clients rejected together do not come back together. */
const jitter = (ms: number) => Math.round(ms * (0.8 + 0.4 * Math.random()))
/**
 * Transient failures (timeouts, 408, 5xx and 429 without a limit) honor a bounded Retry-After, or back
 * off from 30 seconds to 30 minutes. Other 4xx responses, such as an endpoint not deployed yet, cannot
 * be fixed by retrying and wait one to six hours.
 */
export function retryDelay(status: number | undefined, attempts: number, retryAfterMs: number | null): number {
	if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429)
		return jitter(Math.min(LIMIT_RETRY_MS, HOUR_MS * 2 ** attempts))
	if (retryAfterMs !== null) return Math.min(Math.max(retryAfterMs, 30_000), LIMIT_RETRY_MS)
	return jitter(Math.min(30 * MINUTE_MS, 30_000 * 2 ** attempts))
}

/** Reads the PR_COST_LIMIT ErrorInfo of a 429 body; anything else is not a limit. */
export function serverLimit(body: unknown, at = Date.now()): ServerLimit | undefined {
	if (!object(body) || !Array.isArray(body.details)) return undefined
	const info = body.details.find(
		(detail) =>
			object(detail) &&
			detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" &&
			detail.reason === "PR_COST_LIMIT" &&
			detail.domain === "ai-optimizer",
	)
	if (!object(info)) return undefined
	const metadata = object(info.metadata) ? info.metadata : {}
	const number = (value: unknown) =>
		typeof value === "string" && /^\d{1,15}$/.test(value) ? { value: Number(value) } : undefined
	const scope = LIMIT_SCOPES.find((value) => value === metadata.scope)
	const limit = LIMIT_NAMES.find((value) => value === metadata.limit)
	const current = number(metadata.current)
	const maximum = number(metadata.maximum)
	return {
		...(scope ? { scope } : {}),
		...(limit ? { limit } : {}),
		...(current ? { current: current.value } : {}),
		...(maximum ? { maximum: maximum.value } : {}),
		at,
	}
}

/** A failed lookup keeps its kind: a repository without a GitHub or GitLab identity is not missing evidence. */
const repositoryCache = new Map<string, { checkedAt: number; value?: ReportingRepository; unsupported?: true }>()

function safeEndpoint(value: string): boolean {
	const url = plainURL(value, ["https:", "http:"])
	return url?.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url?.hostname ?? "")
}

/** Both transports share the same cancellation, opt-out polling and lease boundary. */
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

/** Preserve the old route and each frozen body's exact bytes until its original account acknowledges it. */
export function deliverSnapshots(
	agentDir: string,
	cwd: string,
	signal: AbortSignal,
	assertLease: () => void,
	deadline = Date.now() + PASS_MS,
): Promise<void> {
	return reportingDelivery(agentDir, signal, assertLease, deadline, async (combined, check) => {
		const state = await freezeSnapshots(agentDir, check)
		if (!state.enabled) return
		const frozen = await pendingFrozenSnapshots(agentDir, check, Math.min(deadline, Date.now() + PASS_MS / 2))
		/** The configured credential: API key, or the SSO token from auth.json. */
		const configuredCredentials = () => resolveGatewayCredentials(loadConfig({ cwd }))
		const configuredKey = configuredCredentials().token
		const configuredEndpoint = platformApiUrl(cwd)
		if (frozen.some(({ entry }) => !configuredKey || entry.account.apiUrl !== configuredEndpoint))
			await recordReportingError(
				agentDir,
				`${state.error ? `${state.error}. ` : ""}Some queued reports are waiting for their original account endpoint and credentials`,
			)
		const now = Date.now()
		// Withdrawals free space, so an account-wide limit only holds snapshots that add claims.
		const paused = new Set(
			Object.entries(state.paused ?? {})
				.filter(([, pause]) => pause.retryAt > now)
				.map(([account]) => account),
		)

		const positions = new Map(Object.keys(state.entries).map((key, index) => [key, index]))
		const urgent = new Set(frozen.filter(({ entry }) => entry.urgent).map(({ key }) => key))
		const due = frozen
			.filter(
				({ key, entry }) => !(state.entries[key] ?? entry).held && entry.retryAt <= now && !inUploadWindow(entry, now),
			)
			.sort((a, b) => {
				const priority = Number(!urgent.has(a.key)) - Number(!urgent.has(b.key))
				if (priority) return priority
				const position =
					(positions.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.key) ?? Number.MAX_SAFE_INTEGER)
				if (position) return position
				if (a.key !== b.key) return a.key < b.key ? -1 : 1
				const revision = BigInt(a.entry.revision) - BigInt(b.entry.revision)
				return revision < 0n ? -1 : revision > 0n ? 1 : a.entry.retryAt - b.entry.retryAt
			})
		let attempts = 0
		for (const job of due) {
			const entry = job.entry
			const snapshot = entry.pending
			if (!snapshot) continue
			if (paused.has(accountKey(entry.account)) && (snapshot.requests.length || snapshot.pullRequests.length)) continue
			if (combined.aborted || attempts >= 3) break
			const { token: key, organizationId } = configuredCredentials()
			const apiUrl = platformApiUrl(cwd)
			if (!key || !safeEndpoint(apiUrl) || apiUrl !== entry.account.apiUrl) continue
			attempts++
			let status: number | undefined
			let retryAfterMs: number | null = null
			let limit: ServerLimit | undefined
			let errorMessage = "PR reporting request unavailable"
			const assertOwnership = () => {
				assertLease()
				if (configuredCredentials().token !== key || platformApiUrl(cwd) !== apiUrl)
					throw new Error("PR reporting credentials changed")
			}
			const assertCurrent = () => {
				assertOwnership()
				combined.throwIfAborted()
			}

			const fetchBounded: typeof fetch = async (input, init) => {
				assertCurrent()
				const current = await readReportingState(agentDir)
				assertCurrent()
				if (!current.enabled || current.entries[job.key]?.held || !frozenSnapshotPending(agentDir, job))
					throw new Error("PR reporting snapshot changed")
				const response = await fetch(input, { ...init, redirect: "error", signal: combined })
				assertCurrent()
				status = response.status
				retryAfterMs = parseRetryAfterMs(response)
				if (!response.ok)
					errorMessage =
						response.status === 403
							? "PR reporting is not allowed for this API key: uploading PR costs needs an Owner or Member role (HTTP 403)"
							: `PR reporting returned HTTP ${response.status}`
				// Verify, acknowledgement and error bodies are small; neither response text nor headers enter durable state.
				const bounded = await boundedResponse(
					response,
					RESPONSE_BYTES,
					combined,
					"PR reporting response exceeds the size limit",
				)
				assertCurrent()
				return bounded
			}
			try {
				const verified = {
					apiUrl,
					...(await verifyApiKey(key, {
						endpoint: apiUrl,
						organizationId,
						fetch: fetchBounded,
						signal: combined,
						retry: { maxRetries: 0 },
					})),
				}
				assertCurrent()
				if (!isWorkAccount(verified) || !sameWorkAccount(entry.account, verified)) {
					errorMessage = "PR reporting is waiting for the original account"
					throw new Error(errorMessage)
				}

				const response = await fetchBounded(
					`${apiUrl}/ai-optimizer/v1beta/organizations/${entry.account.organizationId}/pr-cost-snapshots`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${key}`,
							...(organizationId ? { [GATEWAY_ORGANIZATION_HEADER]: organizationId } : {}),
							"Content-Type": "application/json",
							Accept: "application/json",
						},
						body: job.body,
					},
				)
				assertCurrent()
				if (response.status === 429) limit = serverLimit(await response.json().catch(() => undefined))
				if (!response.ok) throw new Error(errorMessage)
				const ack: SnapshotAck = await response.json()
				assertCurrent()
				await acknowledgeFrozenSnapshot(agentDir, job, ack, assertCurrent)
				trackPRCostMetric({ kind: "delivery", outcome: "success" })
			} catch {
				trackPRCostMetric({ kind: "delivery", outcome: combined.aborted ? "canceled" : "failed" })
				if (signal.aborted) return
				try {
					assertOwnership()
				} catch {
					return
				}
				if (limit) {
					await limitFrozenSnapshot(agentDir, job, limit, Date.now() + jitter(LIMIT_RETRY_MS), assertOwnership)
					if (limit.scope && ACCOUNT_SCOPES.includes(limit.scope)) paused.add(accountKey(entry.account))
				} else
					await deferFrozenSnapshot(
						agentDir,
						job,
						Date.now() + retryDelay(status, entry.attempts, retryAfterMs),
						errorMessage,
						assertOwnership,
					)
			}
		}
	})
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
		for (let attempt = 0; attempt < 3; attempt++) {
			check()
			if (
				!readOutboxStatus(agentDir).some(
					(status) => (status.sendable > 0 || status.batches > 0) && (status.retry?.retryAt ?? 0) <= Date.now(),
				)
			)
				return
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
							? "PR reporting is not allowed for this API key (HTTP 403)"
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
			const account = {
				apiUrl,
				...(await verifyApiKey(key, {
					endpoint: apiUrl,
					organizationId,
					fetch: fetchBounded,
					signal: combined,
					retry: { maxRetries: 0 },
				})),
			}
			assertCurrent()
			if (!isWorkAccount(account)) throw new Error("PR reporting account verification failed")
			const accountId = accountKey(account)
			let batch: OutboxBatch | undefined
			if (
				!(await withDrainedLegacyAccount(
					agentDir,
					account,
					(fence) => {
						batch = pendingBatch(agentDir, accountId, fence)
					},
					assertCurrent,
				)) ||
				!batch
			)
				return
			const sent = batch
			const resume = backend.getNote("agent", "legacy-snapshot-resume")
			const schedule = deliveryRetry(backend, accountId, sent.id)
			if (schedule && schedule.retryAt > Date.now()) return
			status = undefined
			retryAfterMs = null
			try {
				let dispatched: Promise<Response> | undefined
				if (
					!(await withDrainedLegacyAccount(
						agentDir,
						account,
						(fence) => {
							const current = pendingBatch(agentDir, accountId, fence)
							if (!current || current.id !== sent.id || !Buffer.from(current.body).equals(Buffer.from(sent.body)))
								throw new Error("PR cost event batch changed")
							fence()
							// Launch under the old-writer lock; await network and body reads after releasing it.
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
					!(await withDrainedLegacyAccount(
						agentDir,
						account,
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
				assertOwnership()
				const attempts = Number(schedule?.attempts ?? 0)
				backend.tx(() => {
					assertOwnership()
					if (backend.getOutboxBatch(accountId)?.id !== sent.id) return
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

/** Runs after local pricing, under the existing reconciliation lease, in sessions that may upload. */
export async function reconcileReporting(
	agentDir: string,
	cwd: string,
	signal: AbortSignal,
	assertLease: () => void,
): Promise<void> {
	const state = await freezeSnapshots(agentDir, () => {
		assertLease()
		signal.throwIfAborted()
	})
	if (!state.enabled) return
	try {
		await captureEvents(agentDir, signal, assertLease)
	} catch {
		if (!signal.aborted)
			await recordReportingError(
				agentDir,
				"PR reporting could not capture a complete inventory; previous reports were retained",
			)
	}
	// Reports already queued go out with their own time even when this pass could not capture a new inventory.
	if (signal.aborted) return
	try {
		await deliverSnapshots(agentDir, cwd, signal, assertLease, Date.now() + PASS_MS)
		await deliverEvents(agentDir, cwd, signal, assertLease, Date.now() + PASS_MS)
	} catch {
		if (!signal.aborted) await recordReportingError(agentDir, "PR reporting could not deliver queued reports")
	}
}

/** Refresh mutable PR metadata and repository identities even without new request records. */
const CAPTURE_REFRESH_MS = HOUR_MS
/** What the last capture that settled every repository identity read and left behind, and when it started. */
let lastCapture: { inputs: string; at: number } | undefined

/** Translate one imported authority prefix without creating any new legacy snapshot inventory. */
async function captureEvents(agentDir: string, signal: AbortSignal, assertLease: () => void): Promise<void> {
	const deadline = Date.now() + PASS_MS
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(PASS_MS)])
	const check = () => {
		assertLease()
		bounded.throwIfAborted()
		if (Date.now() >= deadline) throw new Error("PR reporting pass time limit exceeded")
	}
	check()
	// Retain known coverage failures without rehashing unchanged legacy bodies on idle passes.
	let historyComplete = true
	reportJournalProblems(
		agentDir,
		() => {
			historyComplete = false
		},
		check,
	)
	// Fingerprint before reading: an append during the read only makes the next pass capture again.
	const journals = await workJournalFingerprint(agentDir, check)
	check()
	const inputs = async () => JSON.stringify([agentDir, journals, await reportingStateVersion(agentDir)])
	const currentInputs = await inputs()
	check()
	if (lastCapture?.inputs === currentInputs && Date.now() - lastCapture.at < CAPTURE_REFRESH_MS) {
		if (!historyComplete) throw new Error("PR reporting is waiting for readable source records")
		return
	}
	// Changed legacy input may repair a torn append. Re-evaluate coverage after the bounded import.
	historyComplete = true
	const startedAt = Date.now()
	await importWorkRecordsAsync(agentDir, check, () => {
		historyComplete = false
	})
	const stored = await readStoredRecordsAsync(agentDir, check)
	const records = stored.map((row) => {
		check()
		return JSON.parse(row.body) as WorkRecord
	})
	check()
	if (!historyComplete) throw new Error("PR reporting is waiting for readable source records")
	const { report } = readWorkCostReport(agentDir, records)
	const repositories = new Map<string, RepositoryIdentity>()
	const needed = new Set<string>()
	const requestRepositories = new Map<string, Set<string>>()
	for (const row of records)
		if (row.type === "request" && typeof row.requestId === "string" && isWorkScope(row.scope)) {
			const values = requestRepositories.get(row.requestId) ?? new Set<string>()
			values.add(row.scope.repository)
			requestRepositories.set(row.requestId, values)
		}
	for (const request of report.requests) {
		check()
		for (const repository of requestRepositories.get(request.requestId) ?? []) needed.add(repository)
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

	const producer = await reportingProducer(agentDir, check)
	const built = buildEvents(stored, report, repositories, producer, check, (account, entity) =>
		effectiveClaim(backendFor(agentDir), account, entity),
	)
	check()
	for (const group of built.accounts)
		observeEvents(agentDir, accountKey(group.account), group.facts, group.recordHashes, check)
	await recordReportingError(
		agentDir,
		built.unresolved.length ? "Some PR cost events are waiting for complete original evidence" : undefined,
	)
	check()
	// A repository lookup that failed or ran out of time is retried by the next pass.
	if ([...needed].every((repository) => repositories.has(repository)))
		lastCapture = { inputs: await inputs(), at: startedAt }
}
