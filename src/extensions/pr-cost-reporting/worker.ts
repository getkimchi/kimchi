import { watch } from "node:fs"
import { verifyApiKey } from "../../api/organizations.js"
import { loadConfig, resolveEndpoints } from "../../config.js"
import { computeRetryDelayMs, fetchWithRetry, parseRetryAfterMs } from "../../utils/http.js"
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
	try {
		const url = new URL(value)
		return (
			(url.protocol === "https:" ||
				(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		)
	} catch {
		return false
	}
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
			let errorMessage = "PR reporting request unavailable"
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
				retryMs = Math.max(retryMs, Math.min(parseRetryAfterMs(response) ?? 0, Number.MAX_SAFE_INTEGER - Date.now()))
				if (!response.ok) errorMessage = `PR reporting returned HTTP ${response.status}`
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
				await deferSnapshot(agentDir, id, snapshot.revision, Date.now() + Math.max(30_000, retryMs), errorMessage)
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
		for (const [repository, path] of needed) {
			check()
			try {
				repositories.set(repository, await lookupRepositoryIdentity(path, bounded))
			} catch {
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
