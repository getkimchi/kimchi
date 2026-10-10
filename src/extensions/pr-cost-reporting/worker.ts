import { watch } from "node:fs"
import { verifyApiKey } from "../../api/organizations.js"
import { loadConfig } from "../../config.js"
import { boundedResponse, parseRetryAfterMs } from "../../utils/http.js"
import { plainURL } from "../../utils/url.js"
import { lookupRepositoryIdentity } from "../pull-request-status/provider-api.js"
import { LookupError } from "../pull-request-status/provider-records.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"
import { readWorkCostReport } from "../work-attribution/cost-sync.js"
import { isWorkAccount, isWorkScope, platformApiUrl, sameWorkAccount } from "../work-attribution/scope.js"
import { object, readWorkRecordsAsync, workJournalFingerprint } from "../work-attribution/summary.js"
import {
	ACCOUNT_SCOPES,
	acknowledgeSnapshot,
	deferSnapshot,
	inUploadWindow,
	LIMIT_NAMES,
	LIMIT_SCOPES,
	learnedLimits,
	limitSnapshot,
	queueSnapshots,
	type ReportingState,
	readReportingState,
	recordReportingError,
	reportingDirectory,
	reportingStateVersion,
	type ServerLimit,
	type SnapshotAck,
} from "./queue.js"
import { accountKey, buildSnapshots, type ReportingRepository, type RepositoryIdentity } from "./snapshot.js"

const PASS_MS = 5000
const RESPONSE_BYTES = 64 * 1024
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

/** Delivery uses a fresh account verification and a credential fence for every bounded attempt. */
export async function deliverSnapshots(
	agentDir: string,
	cwd: string,
	signal: AbortSignal,
	assertLease: () => void,
	deadline = Date.now() + PASS_MS,
): Promise<void> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()))
	timer.unref()
	const combined = AbortSignal.any([signal, controller.signal])
	// Seeing an opt-out from another process mid-upload is an optimisation: each upload rereads the state anyway.
	// Without a watcher, for example when inotify watches run out, delivery still works.
	// One durable write raises several events on Linux and the state can reach 24 MiB, so one reread runs at a time;
	// events seen during it cause one more.
	let watcher: ReturnType<typeof watch> | undefined
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
				if (!changedAgain || !watcher) return
				changedAgain = false
				reread()
			})
	}
	try {
		watcher = watch(reportingDirectory(agentDir), { persistent: false }, reread)
	} catch {}
	try {
		const state = await readReportingState(agentDir)
		if (!state.enabled) return
		const configuredKey = loadConfig({ cwd }).apiKey
		const configuredEndpoint = platformApiUrl(cwd)
		if (
			Object.values(state.entries).some(
				(entry) => entry.pending && (!configuredKey || entry.account.apiUrl !== configuredEndpoint),
			)
		)
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

		const due = Object.entries(state.entries)
			.filter(([, entry]) => entry.pending && !entry.held && entry.retryAt <= now && !inUploadWindow(entry, now))
			.sort(([, a], [, b]) => Number(!a.urgent) - Number(!b.urgent) || a.retryAt - b.retryAt)
		let attempts = 0
		for (const [id, entry] of due) {
			const snapshot = entry.pending
			if (!snapshot) continue
			if (paused.has(accountKey(entry.account)) && (snapshot.requests.length || snapshot.pullRequests.length)) continue
			if (combined.aborted || attempts >= 3) break
			const key = loadConfig({ cwd }).apiKey
			const apiUrl = platformApiUrl(cwd)
			if (!key || !safeEndpoint(apiUrl) || apiUrl !== entry.account.apiUrl) continue
			attempts++
			let status: number | undefined
			let retryAfterMs: number | null = null
			let limit: ServerLimit | undefined
			let errorMessage = "PR reporting request unavailable"
			const assertCurrent = () => {
				assertLease()
				combined.throwIfAborted()
				if (loadConfig({ cwd }).apiKey !== key || platformApiUrl(cwd) !== apiUrl)
					throw new Error("PR reporting credentials changed")
			}

			const fetchBounded: typeof fetch = async (input, init) => {
				assertCurrent()
				const current = await readReportingState(agentDir)
				assertCurrent()
				if (
					!current.enabled ||
					current.entries[id]?.held ||
					current.entries[id]?.pending?.revision !== snapshot.revision
				)
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
						headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
						body: JSON.stringify(snapshot),
					},
				)
				assertCurrent()
				if (response.status === 429) limit = serverLimit(await response.json().catch(() => undefined))
				if (!response.ok) throw new Error(errorMessage)
				const ack: SnapshotAck = await response.json()
				assertCurrent()
				await acknowledgeSnapshot(agentDir, id, snapshot.revision, ack)
				trackPRCostMetric({ kind: "delivery", outcome: "success" })
			} catch {
				trackPRCostMetric({ kind: "delivery", outcome: combined.aborted ? "canceled" : "failed" })
				if (signal.aborted) return
				if (limit) {
					await limitSnapshot(agentDir, id, snapshot.revision, limit, Date.now() + jitter(LIMIT_RETRY_MS))
					if (limit.scope && ACCOUNT_SCOPES.includes(limit.scope)) paused.add(accountKey(entry.account))
				} else
					await deferSnapshot(
						agentDir,
						id,
						snapshot.revision,
						Date.now() + retryDelay(status, entry.attempts, retryAfterMs),
						errorMessage,
					)
			}
		}
	} finally {
		watcher?.close()
		watcher = undefined
		clearTimeout(timer)
	}
}

/** Runs after local pricing, under the existing reconciliation lease, in sessions that may upload. */
export async function reconcileReporting(
	agentDir: string,
	cwd: string,
	signal: AbortSignal,
	assertLease: () => void,
): Promise<void> {
	const state = await readReportingState(agentDir)
	if (!state.enabled) return
	try {
		await captureSnapshots(agentDir, state, signal, assertLease)
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
	} catch {
		if (!signal.aborted) await recordReportingError(agentDir, "PR reporting could not deliver queued reports")
	}
}

/** Unchanged journals and queue give the same snapshots; only the moving upload window needs another capture. */
const CAPTURE_REFRESH_MS = HOUR_MS
/** What the last capture that settled every repository identity read and left behind, and when it started. */
let lastCapture: { inputs: string; at: number } | undefined

/** Queues every repository's snapshot, unless the journals and queue have not changed since the last capture. */
async function captureSnapshots(
	agentDir: string,
	state: ReportingState,
	signal: AbortSignal,
	assertLease: () => void,
): Promise<void> {
	const deadline = Date.now() + PASS_MS
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(PASS_MS)])
	const check = () => {
		assertLease()
		bounded.throwIfAborted()
		if (Date.now() >= deadline) throw new Error("PR reporting pass time limit exceeded")
	}
	check()
	// Fingerprint before reading: an append during the read only makes the next pass capture again.
	const journals = await workJournalFingerprint(agentDir)
	const inputs = async () => JSON.stringify([agentDir, journals, await reportingStateVersion(agentDir)])
	if (lastCapture?.inputs === (await inputs()) && Date.now() - lastCapture.at < CAPTURE_REFRESH_MS) return
	const startedAt = Date.now()
	let historyComplete = true
	const records = await readWorkRecordsAsync(agentDir, bounded, () => {
		historyComplete = false
	})
	check()
	if (!historyComplete) throw new Error("PR reporting is waiting for readable source records")
	const { report, costRefreshes } = readWorkCostReport(agentDir, records)
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
		const linked = report.pullRequests.filter(
			(pr) =>
				request.account &&
				pr.account &&
				sameWorkAccount(request.account, pr.account) &&
				request.pullRequestIds.includes(pr.key),
		)
		if (linked.length && linked.every((pr) => pr.pullRequest?.id && pr.pullRequest.repositoryId)) continue
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

	const built = buildSnapshots(records, report, repositories, costRefreshes, learnedLimits(state))
	check()
	const queued = await queueSnapshots(agentDir, built.snapshots, !built.incomplete)
	if (built.skippedRequests)
		await recordReportingError(
			agentDir,
			`${queued.error ? `${queued.error}. ` : ""}PR reporting skipped ${built.skippedRequests} request(s) without original account or repository evidence; history coverage is incomplete`,
		)
	// A repository lookup that failed or ran out of time is retried by the next pass.
	if ([...needed].every((repository) => repositories.has(repository)))
		lastCapture = { inputs: await inputs(), at: startedAt }
}
