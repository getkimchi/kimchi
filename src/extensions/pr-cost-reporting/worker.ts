import { watch } from "node:fs"
import { verifyApiKey } from "../../api/organizations.js"
import { loadConfig, resolveEndpoints } from "../../config.js"
import { computeRetryDelayMs, fetchWithRetry, parseRetryAfterMs } from "../../utils/http.js"
import { plainURL } from "../../utils/url.js"
import { lookupRepositoryIdentity } from "../pull-request-status/provider-api.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"
import { readWorkCostReport } from "../work-attribution/cost-sync.js"
import { isWorkAccount, isWorkScope, sameWorkAccount } from "../work-attribution/scope.js"
import {
	acknowledgeSnapshot,
	deferSnapshot,
	queueSnapshots,
	readReportingState,
	recordReportingError,
	reportingDirectory,
	type SnapshotAck,
} from "./queue.js"
import { buildSnapshots, type ReportingRepository, validateSnapshot } from "./snapshot.js"

const PASS_MS = 5000
const RESPONSE_BYTES = 64 * 1024
const REPOSITORY_CACHE_MS = 5 * 60_000
/**
 * A rejection that retrying cannot fix, such as an endpoint not deployed yet or a full storage
 * allowance (429 without Retry-After), waits one to six hours.
 */
function rejectionDelay(status: number | undefined, attempts: number, retryAfter: boolean): number {
	if (!status || status < 400 || status >= 500 || status === 408 || (status === 429 && retryAfter)) return 0
	return Math.min(6 * 60 * 60_000, 60 * 60_000 * 2 ** attempts)
}
const repositoryCache = new Map<string, { checkedAt: number; value?: ReportingRepository }>()

/** Verify and acknowledgement responses are small; neither response text nor headers enter durable state. */
async function boundedResponse(response: Response, signal: AbortSignal): Promise<Response> {
	const reader = response.body?.getReader()
	if (!reader) return response
	let abort: (() => void) | undefined
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason)
		signal.addEventListener("abort", abort, { once: true })
	})
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		while (true) {
			signal.throwIfAborted()
			const chunk = await Promise.race([reader.read(), cancelled])
			if (chunk.done) break
			size += chunk.value.length
			if (size > RESPONSE_BYTES) throw new Error("PR reporting response exceeds the size limit")
			chunks.push(chunk.value)
		}
		return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers })
	} finally {
		if (abort) signal.removeEventListener("abort", abort)
		void reader.cancel().catch(() => {})
	}
}

function endpoint(cwd: string): string {
	return resolveEndpoints({ cwd }).platformApiUrl.replace(/\/+$/, "")
}
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
	const watcher = watch(reportingDirectory(agentDir), { persistent: false }, () => {
		void readReportingState(agentDir).then(
			(state) => {
				if (!state.enabled) controller.abort()
			},
			() => controller.abort(),
		)
	})
	try {
		const state = await readReportingState(agentDir)
		if (!state.enabled) return
		const configuredKey = loadConfig({ cwd }).apiKey
		const configuredEndpoint = endpoint(cwd)
		if (
			Object.values(state.entries).some(
				(entry) => entry.pending && (!configuredKey || entry.account.apiUrl !== configuredEndpoint),
			)
		)
			await recordReportingError(
				agentDir,
				`${state.error ? `${state.error}. ` : ""}Some queued reports are waiting for their original account endpoint and credentials`,
			)
		let attempts = 0
		for (const [id, entry] of Object.entries(state.entries).sort(([, a], [, b]) => a.retryAt - b.retryAt)) {
			if (!entry.pending || entry.held || entry.retryAt > Date.now()) continue
			if (combined.aborted || attempts >= 3) break
			const snapshot = entry.pending
			const key = loadConfig({ cwd }).apiKey
			const apiUrl = endpoint(cwd)
			if (!key || !safeEndpoint(apiUrl) || apiUrl !== entry.account.apiUrl) continue
			attempts++
			let retryMs = computeRetryDelayMs(entry.attempts + 1)
			let retryAfter = false
			let errorMessage = "PR reporting request unavailable"
			let rejected: number | undefined
			const assertCurrent = () => {
				assertLease()
				combined.throwIfAborted()
				if (loadConfig({ cwd }).apiKey !== key || endpoint(cwd) !== apiUrl)
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
				const after = parseRetryAfterMs(response)
				retryAfter = after !== null
				retryMs = Math.max(retryMs, Math.min(after ?? 0, Number.MAX_SAFE_INTEGER - Date.now()))
				if (!response.ok) {
					errorMessage = `PR reporting returned HTTP ${response.status}`
					rejected = response.status
				}
				const bounded = await boundedResponse(response, combined)
				assertCurrent()
				return bounded
			}
			try {
				validateSnapshot(snapshot)
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
				const response = await fetchWithRetry(
					`${apiUrl}/ai-optimizer/v1beta/organizations/${entry.account.organizationId}/pr-cost-snapshots`,
					{
						method: "POST",
						headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
						body: JSON.stringify(snapshot),
					},
					{ fetchImpl: fetchBounded, signal: combined, retry: { maxRetries: 0 } },
				)
				assertCurrent()
				if (!response.ok) throw new Error(errorMessage)
				const ack: SnapshotAck = await response.json()
				assertCurrent()
				await acknowledgeSnapshot(agentDir, id, snapshot.revision, ack)
				trackPRCostMetric({ kind: "delivery", outcome: "success" })
			} catch {
				trackPRCostMetric({ kind: "delivery", outcome: combined.aborted ? "canceled" : "failed" })
				if (signal.aborted) return
				const delay = Math.max(30_000, retryMs, rejectionDelay(rejected, entry.attempts, retryAfter))
				await deferSnapshot(agentDir, id, snapshot.revision, Date.now() + delay, errorMessage)
			}
		}
	} finally {
		watcher.close()
		clearTimeout(timer)
	}
}

/** Runs after local pricing, under the existing reconciliation lease. */
export async function reconcileReporting(
	agentDir: string,
	cwd: string,
	signal: AbortSignal,
	assertLease: () => void,
): Promise<void> {
	if (!(await readReportingState(agentDir)).enabled) return
	const deadline = Date.now() + PASS_MS
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(PASS_MS)])
	const check = () => {
		assertLease()
		bounded.throwIfAborted()
		if (Date.now() >= deadline) throw new Error("PR reporting pass time limit exceeded")
	}
	try {
		check()
		const { records, report, historyComplete, costRefreshes } = readWorkCostReport(agentDir, check)
		if (!historyComplete) throw new Error("PR reporting is waiting for readable source records")
		const repositories = new Map<string, ReportingRepository>()
		const needed = new Map<string, string>()
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
			for (const repository of requestRepositories.get(request.requestId) ?? []) needed.set(repository, repository)
		}
		for (const [key, cached] of repositoryCache)
			if (Date.now() - cached.checkedAt >= REPOSITORY_CACHE_MS) repositoryCache.delete(key)
		const cacheKey = (repository: string) => JSON.stringify([agentDir, repository])
		for (const repository of needed.keys()) {
			const cached = repositoryCache.get(cacheKey(repository))
			if (cached?.value) repositories.set(repository, cached.value)
		}
		for (const [repository, path] of [...needed].sort(
			([a], [b]) =>
				(repositoryCache.get(cacheKey(a))?.checkedAt ?? 0) - (repositoryCache.get(cacheKey(b))?.checkedAt ?? 0),
		)) {
			const key = cacheKey(repository)
			const cached = repositoryCache.get(key)
			if (cached?.value || (cached && Date.now() - cached.checkedAt < 30_000)) continue
			// Reserve time to persist and deliver known groups even when discovery is slow.
			if (Date.now() >= deadline - 2000) break
			check()
			try {
				const lookupMs = Math.min(3000, deadline - Date.now() - 1000)
				const value = await lookupRepositoryIdentity(path, AbortSignal.any([bounded, AbortSignal.timeout(lookupMs)]))
				repositoryCache.set(key, { checkedAt: Date.now(), value })
				repositories.set(repository, value)
			} catch {
				repositoryCache.set(key, { checkedAt: Date.now() })
				check()
			}
		}
		const built = buildSnapshots(records, report, repositories, historyComplete, costRefreshes)
		check()
		const queued = await queueSnapshots(agentDir, built.snapshots, !built.incomplete)
		if (built.skippedRequests)
			await recordReportingError(
				agentDir,
				`${queued.error ? `${queued.error}. ` : ""}PR reporting skipped ${built.skippedRequests} request(s) without original account or repository evidence; history coverage is incomplete`,
			)
		check()
		await deliverSnapshots(agentDir, cwd, signal, assertLease, deadline)
	} catch {
		if (!signal.aborted)
			await recordReportingError(
				agentDir,
				"PR reporting could not capture a complete inventory; previous reports were retained",
			)
	}
}
