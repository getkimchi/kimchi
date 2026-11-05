import { createHash } from "node:crypto"
import { setImmediate } from "node:timers/promises"
import { verifyApiKey } from "../../api/organizations.js"
import { GATEWAY_ORGANIZATION_HEADER, resolveGatewayCredentials } from "../../auth/gateway-credentials.js"
import { loadConfig } from "../../config.js"
import { canonicalPlatformApiUrl } from "../../regions.js"
import { type StatPoller, startStatPoller } from "../../shared/stat-poller.js"
import { isTelemetryEnabled } from "../../telemetry-policy.js"
import { boundedResponse, parseRetryAfterMs } from "../../utils/http.js"
import { plainURL } from "../../utils/url.js"
import { pullRequestKey } from "../pull-request-status/links.js"
import { lookupRepositoryIdentity } from "../pull-request-status/provider-api.js"
import { LookupError } from "../pull-request-status/provider-records.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"
import { readWorkCostReport } from "../work-attribution/cost-sync.js"
import type { PullRequestCostReport } from "../work-attribution/costs.js"
import { isWorkAccount, isWorkScope, platformApiUrl, sameWorkAccount } from "../work-attribution/scope.js"
import { importWorkRecordsAsync, object, type WorkRecord } from "../work-attribution/summary.js"
import { buildEvents } from "./events.js"
import { legacyInputSignature } from "./ledger/import.js"
import {
	acknowledgeBatch,
	deliveryRetry,
	effectiveClaim,
	type Fact,
	observeEvents,
	pendingBatch,
	readOutboxStatus,
} from "./ledger/outbox.js"
import { backendFor, type OutboxBatch, type RecordBackend } from "./ledger/records.js"
import type { Acknowledgement } from "./protocol.js"
import {
	ACCOUNT_SCOPES,
	acknowledgeFrozenSnapshot,
	deadLetterFrozenSnapshot,
	deferFrozenSnapshot,
	type FreshReportingState,
	type FrozenSnapshot,
	freezeSnapshots,
	frozenSnapshotPending,
	HOLD_EXPIRY_MS,
	inUploadWindow,
	LIMIT_NAMES,
	LIMIT_SCOPES,
	limitFrozenSnapshot,
	pendingFrozenSnapshots,
	type ReportingState,
	readReportingState,
	readReportingStateFresh,
	recordReportingError,
	reportingOwnWrites,
	reportingProducer,
	reportingStateContentHash,
	reportingStatePath,
	reportingStateVersion,
	runWithReportingOwnWrites,
	type ServerLimit,
	type SnapshotAck,
	trimFrozenSnapshot,
	UPLOAD_INTERVAL_MS,
	withReportingConsent,
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
async function reportingDelivery<T>(
	agentDir: string,
	signal: AbortSignal,
	assertLease: () => void,
	deadline: number,
	deliver: (signal: AbortSignal, check: () => void) => Promise<T>,
): Promise<T> {
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
		return await deliver(combined, check)
	} finally {
		controller.abort()
		poller?.stop()
		poller = undefined
		clearTimeout(timer)
	}
}

/** The due-relevant fields of a frozen row — pass gates reproduce the delivery loop's selection from them. */
export interface FrozenDueMeta {
	/** The frozen row's own id: one pass can carry several rows of one key, so marks key on it. */
	id: string
	key: string
	account: string
	held: boolean
	/** The body was dead-lettered and no retry will ever select it again. */
	dead: boolean
	hasContent: boolean
	urgent: boolean
	retryAt: number
	uploadedAt?: number
}

function frozenDueMeta(job: FrozenSnapshot): FrozenDueMeta {
	return {
		id: job.id,
		key: job.key,
		account: accountKey(job.entry.account),
		held: job.entry.held === true,
		dead: job.entry.dead !== undefined,
		// Mirrors the delivery loop's pause skip word for word: a body with zero requests and zero
		// pull requests withdraws nothing, so it goes out even on a paused account.
		hasContent: (job.entry.pending?.requests.length ?? 0) > 0 || (job.entry.pending?.pullRequests.length ?? 0) > 0,
		urgent: job.entry.urgent === true,
		retryAt: job.entry.retryAt,
		uploadedAt: job.entry.uploadedAt,
	}
}

/** Preserve the old route and each frozen body's exact bytes until its original account acknowledges it. */
export function deliverSnapshots(
	agentDir: string,
	cwd: string,
	signal: AbortSignal,
	assertLease: () => void,
	deadline = Date.now() + PASS_MS,
): Promise<FrozenDueMeta[] | undefined> {
	return reportingDelivery(agentDir, signal, assertLease, deadline, async (combined, check) => {
		const state = await freezeSnapshots(agentDir, check)
		if (!state.enabled) return undefined
		const frozen = await pendingFrozenSnapshots(agentDir, check, Math.min(deadline, Date.now() + PASS_MS / 2))
		// Pass-scoped signature cache: every durable write renames the file, so an unchanged
		// (mtime, size, ino) means the parse is still current and the mega-byte reread is skipped.
		// Seeded without a signature: stat seeding would pair the freeze pass's state with a
		// signature read after it, hiding a write that landed between the two, so the first
		// HTTP call binds state+signature itself.
		let queueFile: FreshReportingState = { state }
		/** The configured credential: API key, or the SSO token from auth.json. */
		const configuredCredentials = () => resolveGatewayCredentials(loadConfig({ cwd }))
		const configuredKey = configuredCredentials().token
		const configuredEndpoint = platformApiUrl(cwd)
		// Compare endpoints canonically: snapshots queued before the platform API
		// moved to the region's API origin hold the legacy console-proxy base and
		// must not be treated as another account's reports.
		if (
			frozen.some(
				({ entry }) =>
					!configuredKey ||
					canonicalPlatformApiUrl(entry.account.apiUrl) !== canonicalPlatformApiUrl(configuredEndpoint),
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
		// Attempt outcomes, recorded as they happen: the row's new retry deadline and its
		// new uploadedAt (both moves stamp the upload-window clock the due filter reads),
		// or null when the row is gone (acknowledged or replaced mid-flight) and stops being
		// due. The stamp derives its post-attempt picture from these; re-reading the whole
		// queue after delivery would mean a second full parse of every frozen body per pass.
		// UploadedAt is THIS side's attempt time; the queue's internal timestamp may lag a
		// millisecond — immaterial against a five-minute window, and never a risk of over-close.
		// Marks key on the frozen row id: a legacy replacement leaves several pending rows of one
		// key in a single pass, and their outcomes must not overwrite each other.
		const dueMarks = new Map<string, { retryAt: number; uploadedAt?: number; dead?: boolean } | null>()

		const positions = new Map(Object.keys(state.entries).map((key, index) => [key, index]))
		const urgent = new Set(frozen.filter(({ entry }) => entry.urgent).map(({ key }) => key))
		const due = frozen
			.filter(({ key, entry }) => {
				const live = state.entries[key] ?? entry
				// A settled body is refused by the server as long as its bytes are: neither the live
				// entry's own mark nor an older frozen note's mark ever selects for delivery again.
				const dead = live.dead !== undefined || entry.dead !== undefined
				return !live.held && !dead && entry.retryAt <= now && !inUploadWindow(entry, now)
			})
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
		// One account verification per pass for the configured credential; a multi-entry queue
		// sends api-keys:verify once, not once per upload attempt. The result is keyed on the
		// credential so a mid-pass change re-verifies instead of reusing the stale verdict.
		let passVerify:
			| {
					key: string
					apiUrl: string
					result:
						| { ok: { apiUrl: string } & Awaited<ReturnType<typeof verifyApiKey>> }
						| { status: number | undefined; retryAfterMs: number | null; message: string }
			  }
			| undefined
		for (const job of due) {
			const entry = job.entry
			const snapshot = entry.pending
			if (!snapshot) continue
			if (paused.has(accountKey(entry.account)) && (snapshot.requests.length || snapshot.pullRequests.length)) continue
			if (combined.aborted || attempts >= 3) break
			const { token: key, organizationId } = configuredCredentials()
			const apiUrl = platformApiUrl(cwd)
			if (
				!key ||
				!safeEndpoint(apiUrl) ||
				canonicalPlatformApiUrl(apiUrl) !== canonicalPlatformApiUrl(entry.account.apiUrl)
			)
				continue
			attempts++
			let status: number | undefined
			let retryAfterMs: number | null = null
			let limit: ServerLimit | undefined
			let errorMessage = "PR reporting request unavailable"
			/** Only the upload's rejection may trim the body; a verify rejection cannot. */
			let uploadAttempted = false
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
				const fresh = await readReportingStateFresh(agentDir, queueFile)
				queueFile = fresh
				const current = fresh.state
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
				let verified: { apiUrl: string } & Awaited<ReturnType<typeof verifyApiKey>>
				if (passVerify?.key === key && passVerify.apiUrl === apiUrl && "ok" in passVerify.result)
					verified = passVerify.result.ok
				else if (passVerify?.key === key && passVerify.apiUrl === apiUrl && !("ok" in passVerify.result)) {
					status = passVerify.result.status
					retryAfterMs = passVerify.result.retryAfterMs
					errorMessage = passVerify.result.message
					throw new Error(errorMessage)
				} else
					try {
						verified = {
							apiUrl,
							...(await verifyApiKey(key, {
								endpoint: apiUrl,
								organizationId,
								fetch: fetchBounded,
								signal: combined,
								retry: { maxRetries: 0 },
							})),
						}
						passVerify = { key, apiUrl, result: { ok: verified } }
					} catch {
						// Only an HTTP-level failure is credential-scoped and safe to replay within the pass;
						// a throw from the per-job state guard (held/replaced/trimmed) belongs to this entry alone.
						if (status !== undefined && !combined.aborted && !signal.aborted)
							passVerify = { key, apiUrl, result: { status, retryAfterMs, message: errorMessage } }
						throw new Error(errorMessage)
					}
				assertCurrent()
				if (!isWorkAccount(verified) || !sameWorkAccount(entry.account, verified)) {
					errorMessage = "PR reporting is waiting for the original account"
					throw new Error(errorMessage)
				}

				uploadAttempted = true
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
				dueMarks.set(job.id, null)
				trackPRCostMetric({ kind: "delivery", outcome: "success" })
			} catch {
				trackPRCostMetric({ kind: "delivery", outcome: combined.aborted ? "canceled" : "failed" })
				if (signal.aborted) return
				try {
					assertOwnership()
				} catch {
					return
				}
				// Another process replaced or capped this body away while the upload was in flight; its
				// claims moved with it, so this job is settled and the pass moves on to the next one.
				const gone = () => {
					try {
						return !frozenSnapshotPending(agentDir, job)
					} catch {
						return true
					}
				}
				if (gone()) {
					dueMarks.set(job.id, null)
					continue
				}
				try {
					if (limit) {
						const attemptedAt = Date.now()
						const limitRetryAt = attemptedAt + jitter(LIMIT_RETRY_MS)
						await limitFrozenSnapshot(agentDir, job, limit, limitRetryAt, assertOwnership)
						dueMarks.set(job.id, { retryAt: limitRetryAt, uploadedAt: attemptedAt })
						if (limit.scope && ACCOUNT_SCOPES.includes(limit.scope)) paused.add(accountKey(entry.account))
						else if (limit.scope === "snapshot" && limit.limit === "bytes") {
							// The server's own byte cap rejected this body; trim it to the cap it stated, so the
							// retry carries a body the server can accept instead of resending it for hours.
							// A successful trim REPLACES the row entirely (due immediately: attempts and the
							// window clock reset) — overwrite any earlier mark with that reality.
							if (await trimFrozenSnapshot(agentDir, job, assertOwnership, limit)) dueMarks.set(job.id, { retryAt: 0 })
						}
					} else if (uploadAttempted && status === 410) {
						// Explicitly gone: the server cannot say this about a missing route; settle.
						await deadLetterFrozenSnapshot(agentDir, job, status, errorMessage, assertOwnership)
						// Settled rows are kept for the record but are never due again: the stamp carries
						// the dead flag instead of any retry deadline.
						dueMarks.set(job.id, { retryAt: 0, dead: true })
					} else if (uploadAttempted && status === 404 && (entry.attempts ?? 0) >= 2) {
						// The third spaced 404: a durable deletion. A single 404 can be an undeployed
						// or rolled-back /pr-cost-snapshots route while api-keys:verify still answers,
						// and those windows last minutes, so a lone 404 must never settle the queue
						// tail — it falls through to the normal defer below (attempts increments on
						// defer, after this dispatch, so 2 already counted = two prior spaced refusals).
						await deadLetterFrozenSnapshot(agentDir, job, status, errorMessage, assertOwnership)
						// Settled rows are kept for the record but are never due again: the stamp carries
						// the dead flag instead of any retry deadline.
						dueMarks.set(job.id, { retryAt: 0, dead: true })
					} else if (uploadAttempted && status === 413) {
						if (await trimFrozenSnapshot(agentDir, job, assertOwnership))
							// The server rejected this body for its size; its halved replacement is due
							// immediately (attempts and the window clock reset).
							dueMarks.set(job.id, { retryAt: 0 })
						else {
							// Halving reached its floor and the server still refuses the size: settle
							// the body instead of deferring the same refusal forever.
							await deadLetterFrozenSnapshot(agentDir, job, status, errorMessage, assertOwnership)
							dueMarks.set(job.id, { retryAt: 0, dead: true })
						}
					} else {
						const attemptedAt = Date.now()
						const nextRetryAt = attemptedAt + retryDelay(status, entry.attempts, retryAfterMs)
						await deferFrozenSnapshot(agentDir, job, nextRetryAt, errorMessage, assertOwnership)
						dueMarks.set(job.id, { retryAt: nextRetryAt, uploadedAt: attemptedAt })
					}
				} catch (error) {
					if (gone()) {
						dueMarks.set(job.id, null)
						continue
					}
					throw error
				}
			}
		}
		// Attempts above moved retry bookkeeping on the rows the pass started with: the stamp must
		// carry POST-attempt due times — otherwise every failing entry's stale retryAt would re-open
		// on the next tick and a failing queue would never sleep between attempts. The post-attempt
		// picture is derived, not re-read: each attempt's new deadline was computed by this loop,
		// acknowledged/replaced rows drop out, and rows never attempted keep the pass-start picture.
		return frozen
			.map((row) => frozenDueMeta(row))
			.filter((meta) => dueMarks.get(meta.id) !== null)
			.map((meta) => {
				const mark = dueMarks.get(meta.id)
				return mark
					? {
							...meta,
							retryAt: mark.retryAt,
							uploadedAt: mark.uploadedAt,
							dead: mark.dead ?? meta.dead,
						}
					: meta
			})
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
		// Pass-scoped signature cache; details at the snapshots deliver path below the events loop.
		let queueFile: FreshReportingState = {}
		for (let attempt = 0; attempt < 3; attempt++) {
			check()
			const due = readOutboxStatus(agentDir).filter(
				(status) => (status.sendable > 0 || status.batches > 0) && (status.retry?.retryAt ?? 0) <= Date.now(),
			)
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
				const fresh = await readReportingStateFresh(agentDir, queueFile)
				queueFile = fresh
				const current = fresh.state
				assertCurrent()
				if (!current.enabled) throw new Error("PR reporting is disabled")
				return readResponse(await fetch(input, { ...init, redirect: "error", signal: combined }))
			}
			const resume = backend.getNote("agent", "legacy-snapshot-resume")
			/** Each waiting account backs off on its own schedule, as each legacy snapshot did. */
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
			let verified: Awaited<ReturnType<typeof verifyApiKey>> | undefined
			try {
				verified = await verifyApiKey(key, {
					endpoint: apiUrl,
					organizationId,
					fetch: fetchBounded,
					signal: combined,
					retry: { maxRetries: 0 },
				})
			} catch {}
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

/**
 * Pass gate: an unchanged, not-due tick costs one file stat plus cheap ledger counters instead of a
 * full freeze + capture + deliver cycle (which reads and deep-validates a queue of up to 24 MiB).
 * The signature covers every input a pass consumes:
 * - state.json's sidecar version: every writer — this process or another session — bumps a tiny
 *   monotonic counter next to it on every real change (queueing, acknowledgements, opt-outs,
 *   delivery bookkeeping, frozen-trim rewrites). The stamp is pass-start version plus this
 *   process's own bump count, so a pass's own writes never re-open it and any other writer does.
 *   Raw content-identical rewrites never bump it (update() never writes those at all).
 * - recordCount: ledger rows appended by capture between ticks, in any process.
 * - dirtyWorks: a flagged projection forces repair regardless of row count.
 * - dataVersion: PRAGMA data_version plus an own-commit counter — any ledger write in ANY process
 *   (receipts, outbox schedule notes, frozen-trim writes) moves it; own writes are counted because
 *   Bun:sqlite does not exempt same-connection commits from the pragma.
 * - legacy journal stat identity: imported only inside passes, so it must open the gate itself.
 * Time is the remaining input, and the snapshot due filter (worker.ts `due`) reads exactly the
 * fields FrozenDueMeta and the stamp-time holds carry: held, dead, retryAt, urgency, the warm
 * upload-window fields and account pauses — plus the earliest hold deadline queueSnapshots
 * releases, stamped so a quiet tick still wakes for it. Frozen rows are content-addressed and every row mutation
 * rides through queue.ts's update() (state.json) or a ledger commit (dataVersion), so a stamped
 * gate cannot go stale behind a matching signature. Only isTelemetryEnabled is consulted live: an
 * in-session toggle changes reporting duty without touching any file or ledger.
 */
interface PassGate {
	signature: string
	frozen: FrozenDueMeta[]
	/** Held flag per queue key at the last sweep — the live key wins over frozen metadata. */
	liveHeld: Record<string, boolean>
	/** Dead-lettered flag per queue key at the last sweep — the live key wins over frozen metadata. */
	liveDead: Record<string, boolean>
	/** Earliest hold deadline; when it passes the freeze sweep releases the hold, so the pass opens. */
	nextHoldExpiryAt?: number
	/** Account pauses at the last sweep (retryAt thaws by clock, so frozen stamps stay exact). */
	pauses: { account: string; retryAt: number }[]
	/** Failed repository-identity lookups live only in repositoryCache; the next retry opens the pass. */
	nextLookupRetryAt?: number
	/** A pass that ran out of time leaves its changed records marked; translation continues next pass. */
	captureDone: boolean
	/** Next scheduled event-upload time across still-open outbox accounts (their own backoff note). */
	eventsRetryAt?: number
	enabled: boolean
	followsTelemetry: boolean
}
const passGates = new Map<string, PassGate>()

/** The ledger slots of a probe: every writer rides through the reconcile lease, so they read live. */
function probeLedgerSlots(agentDir: string): string {
	const backend = backendFor(agentDir)
	return [
		// Records are insert-only, so the rowid watermark tracks appends O(1) where COUNT(*) was O(n).
		backend.recordWatermark(),
		backend.dataVersion(),
		backend.dirtyWorks().length,
	].join(":")
}

/** True when this stamp says any frozen snapshot could match the delivery loop's selection this tick. */
function gateHasDue(gate: PassGate, now: number): boolean {
	const enabled = gate.followsTelemetry ? isTelemetryEnabled() : gate.enabled
	if (!enabled) return false
	if (gate.nextLookupRetryAt !== undefined && now >= gate.nextLookupRetryAt) return true
	if (!gate.captureDone) return true
	if (gate.eventsRetryAt !== undefined && now >= gate.eventsRetryAt) return true
	if (gate.nextHoldExpiryAt !== undefined && now >= gate.nextHoldExpiryAt) return true
	const paused = new Set(gate.pauses.filter((pause) => pause.retryAt > now).map((pause) => pause.account))
	for (const meta of gate.frozen) {
		// Mirrors the delivery loop's `due` pick and its per-attempt account-pause skip: a held key or a
		// paused account with claims never goes out, anything else due re-opens the pass.
		const held = gate.liveHeld[meta.key] ?? meta.held
		const dead = meta.dead || gate.liveDead[meta.key] === true
		if (held || dead || (paused.has(meta.account) && meta.hasContent)) continue
		const inWindow =
			!meta.urgent &&
			meta.uploadedAt !== undefined &&
			meta.uploadedAt <= now &&
			now - meta.uploadedAt < UPLOAD_INTERVAL_MS
		if (meta.retryAt <= now && !inWindow) return true
	}
	return false
}

/**
 * Stamp-time picture of a sweep: the signature of what the pass actually consumed (NOT a fresh probe —
 * a write landing mid-pass must reopen the next tick, and a post-pass probe would silently absorb it),
 * plus every held/pause/enabled field gateHasDue reads.
 */
async function passGateStamp(
	agentDir: string,
	state: ReportingState,
	frozen: FrozenDueMeta[],
	signature: string,
): Promise<PassGate> {
	// Failed lookups (no resolved identity, not permanently unsupported) retry at checkedAt + 30 s,
	// from the same skip window repositoryIdentities applies inside a pass. The cache key JSON-encodes
	// an [agentDir, repository] pair; derive the directory prefix the same way so unrelated agent
	// directories never share a deadline.
	const prefix = JSON.stringify([agentDir, "x"]).replace(/x"\]$/, "")
	let nextLookupRetryAt: number | undefined
	for (const [key, cached] of repositoryCache)
		if (key.startsWith(prefix) && cached.value === undefined && cached.unsupported !== true) {
			const retryAt = cached.checkedAt + 30_000
			if (nextLookupRetryAt === undefined || retryAt < nextLookupRetryAt) nextLookupRetryAt = retryAt
		}
	let eventsRetryAt: number | undefined
	let unstampedOutbox = false
	for (const status of readOutboxStatus(agentDir)) {
		// An open account without a backoff note says "attempt now": keep opening until one appears.
		if ((status.sendable > 0 || status.batches > 0) && !status.retry) unstampedOutbox = true
		if (status.retry && (eventsRetryAt === undefined || status.retry.retryAt < eventsRetryAt))
			eventsRetryAt = status.retry.retryAt
	}
	let nextHoldExpiryAt: number | undefined
	// Only a hold with a parked body can wake something up; the freeze sweep releases those.
	for (const entry of Object.values(state.entries))
		if (
			entry.heldAt !== undefined &&
			(entry.pending !== undefined || entry.pendingId !== undefined) &&
			entry.dead === undefined
		) {
			// A settled entry can never deliver from a wakeup: it must not hold the gate open.
			const expires = entry.heldAt + HOLD_EXPIRY_MS
			if (nextHoldExpiryAt === undefined || expires < nextHoldExpiryAt) nextHoldExpiryAt = expires
		}
	return {
		signature,
		frozen,
		liveHeld: Object.fromEntries(Object.entries(state.entries).map(([key, entry]) => [key, entry.held === true])),
		liveDead: Object.fromEntries(Object.entries(state.entries).map(([key, entry]) => [key, entry.dead !== undefined])),
		nextHoldExpiryAt,
		pauses: Object.entries(state.paused ?? []).map(([account, pause]) => ({ account, retryAt: pause.retryAt })),
		nextLookupRetryAt,
		captureDone: backendFor(agentDir).markedRecords().length === 0,
		eventsRetryAt: unstampedOutbox ? Number.NEGATIVE_INFINITY : eventsRetryAt,
		enabled: state.enabled,
		followsTelemetry: state.followsTelemetry === true,
	}
}

/** Test hook: drop pass-gate records (does not touch on-disk state). */
export function resetReportingPassGates(): void {
	passGates.clear()
}

/** Runs after local pricing, under the existing reconciliation lease, in sessions that may upload. */
export async function reconcileReporting(
	agentDir: string,
	cwd: string,
	signal: AbortSignal,
	assertLease: () => void,
): Promise<void> {
	const versionBefore = reportingStateVersion(agentDir)
	const ownBefore = reportingOwnWrites(agentDir)
	// Legacy journals are imported only inside passes, so their stat identity opens the gate itself;
	// without it a torn-append repair or a late-arriving record could wait forever.
	const journalBefore = legacyInputSignature(agentDir)
	// The state slot unions the sidecar version with the file's own (mtime, size): the sidecar is
	// bumped only by writers running this code, so an older build sharing the agentDir (a
	// staggered rollout, or a legacy external writer) can rewrite state.json without moving it.
	// The hash opens for changed foreign bytes of any vintage while a content-identical rewrite
	// keeps the gate asleep; own writes absorb through the post-pass recompute below.
	const stateBefore = await reportingStateContentHash(agentDir)
	const signatureBefore = [versionBefore, stateBefore ?? "", probeLedgerSlots(agentDir), journalBefore].join(":")
	const gate = passGates.get(agentDir)
	// Nothing moved and nothing could go out: this tick delays nothing by skipping its cycle.
	if (gate?.signature === signatureBefore && !gateHasDue(gate, Date.now())) return
	// Only writes from inside this pass's own async context are absorbed into the stamp below; a
	// same-process write arriving anywhere else (command handler, another session) re-opens the
	// next tick normally.
	return runWithReportingOwnWrites(agentDir, async () => {
		const state = await freezeSnapshots(agentDir, () => {
			assertLease()
			signal.throwIfAborted()
		})
		if (!state.enabled) {
			// The sweep's own migration writes (which run even while disabled) are absorbed like
			// the enabled path — version delta plus the post-sweep hash — or the stamp mismatches
			// once and buys a spurious reopen.
			const stateAfter = await reportingStateContentHash(agentDir)
			passGates.set(
				agentDir,
				await passGateStamp(
					agentDir,
					state,
					[],
					[
						versionBefore + (reportingOwnWrites(agentDir) - ownBefore),
						stateAfter ?? "",
						probeLedgerSlots(agentDir),
						journalBefore,
					].join(":"),
				),
			)
			return
		}
		try {
			await captureEvents(agentDir, signal, assertLease)
		} catch {
			if (!signal.aborted) await recordReportingError(agentDir, CAPTURE_FAILED)
		}
		// Reports already queued go out with their own time even when this pass could not capture a new inventory.
		if (signal.aborted) return
		let frozen: FrozenDueMeta[] | undefined
		try {
			frozen = await deliverSnapshots(agentDir, cwd, signal, assertLease, Date.now() + PASS_MS)
			await deliverEvents(agentDir, cwd, signal, assertLease, Date.now() + PASS_MS)
		} catch {
			if (!signal.aborted) await recordReportingError(agentDir, "PR reporting could not deliver queued reports")
		}
		// Stamp only a completed, quiet sweep: a failed or aborted pass leaves the next tick fully open.
		// A still-open outbox no longer blocks the stamp — its own backoff note reopens the gate when due.
		if (frozen !== undefined && !signal.aborted) {
			// The stamp absorbs exactly what THIS process wrote during the pass: the version slot starts
			// from pass start plus this process's own state.json bumps, so a failing entry's own retry
			// bookkeeping does not re-open the very next tick — but any other session's bump differs
			// from the stamp and re-opens exactly once, and a foreign journal append rides its own
			// stat slot the same way. Ledger slots read live post-pass: their writers all ride this
			// same reconcile lease, so nothing they track can be moved by anyone else mid-pass.
			// passGateStamp's own outbox repair may commit to the ledger itself: stamp the content
			// first, THEN read the ledger slots — every writer this process could be is ordered before.
			const stamp = await passGateStamp(agentDir, state, frozen, "")
			const stateAfter = await reportingStateContentHash(agentDir)
			const signatureAfter = [
				versionBefore + (reportingOwnWrites(agentDir) - ownBefore),
				stateAfter ?? "",
				probeLedgerSlots(agentDir),
				journalBefore,
			].join(":")
			passGates.set(agentDir, { ...stamp, signature: signatureAfter })
		}
	})
}

/** At most this many requests or auxiliary records commit their events in one transaction. */
const CHUNK_UNITS = 100
/** Time a pass keeps for committing one more chunk and delivering what it captured. */
const CHUNK_RESERVE_MS = 500
/** The group translation in progress: units committed while its marked records stay unchanged. */
const PROGRESS_NOTE = "translation-progress"

/**
 * Translates the works whose records changed since their last translation, one connected group at a time, without
 * creating any new legacy snapshot inventory. A pass that runs out of time resumes where it stopped.
 */
async function captureEvents(agentDir: string, signal: AbortSignal, assertLease: () => void): Promise<void> {
	const deadline = Date.now() + PASS_MS
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(PASS_MS)])
	const check = () => {
		assertLease()
		bounded.throwIfAborted()
		if (Date.now() >= deadline) throw new Error("PR reporting pass time limit exceeded")
	}
	check()
	let historyComplete = true
	await importWorkRecordsAsync(agentDir, check, () => {
		historyComplete = false
	})
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
		if ((await readReportingState(agentDir)).error === CAPTURE_FAILED) await recordReportingError(agentDir, undefined)
		return
	}
	const producer = await reportingProducer(agentDir, check)
	let waiting = false
	for (const works of changedWorkGroups(backend, new Set(marked.keys()))) {
		if (Date.now() >= deadline - CHUNK_RESERVE_MS) return
		const changed = new Map(works.flatMap((workId) => [...(marked.get(workId) ?? [])]))
		const translated = await translateGroup(agentDir, works, changed, producer, deadline, bounded, check)
		if (translated === undefined) return
		waiting ||= translated
	}
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
): Promise<boolean | undefined> {
	const backend = backendFor(agentDir)
	const stored = works.flatMap((workId) => backend.readRecords({ workId }, check))
	const records = stored.map((row) => {
		check()
		return JSON.parse(row.body) as WorkRecord
	})
	const { report } = readWorkCostReport(agentDir, records)
	const { repositories, settled } = await repositoryIdentities(agentDir, records, report, deadline, bounded, check)
	// A commit or work link can move any request of the group; other records touch only their own request.
	const structural = [...changed.values()].some((type) => type === "commit" || type === "work_link")
	const touched = structural
		? undefined
		: {
				requests: new Set(
					records.flatMap((row, index) =>
						changed.has(stored[index].recordHash) && typeof row.requestId === "string" ? [row.requestId] : [],
					),
				),
				records: new Set(changed.keys()),
			}
	const built = buildEvents(
		stored,
		report,
		repositories,
		producer,
		check,
		(account, entity) => effectiveClaim(backend, account, entity),
		touched,
	)
	check()
	const facts = new Map(
		built.accounts.map((group) => [
			accountKey(group.account),
			new Map(group.facts.map((fact) => [fact.entityId, fact])),
		]),
	)
	const hash = (parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex")
	const progress = {
		group: hash(works),
		markers: changed.size,
		plan: hash(built.units.map((unit) => unit.requestId ?? unit.recordHashes.join())),
	}
	const saved: unknown = JSON.parse(backend.getNote("agent", PROGRESS_NOTE) ?? "null")
	let done =
		object(saved) &&
		saved.group === progress.group &&
		saved.markers === progress.markers &&
		saved.plan === progress.plan &&
		Number.isSafeInteger(saved.units)
			? Number(saved.units)
			: 0
	const observed = new Set<string>()
	while (done < built.units.length) {
		if (Date.now() >= deadline - CHUNK_RESERVE_MS) return undefined
		const chunk = built.units.slice(done, done + CHUNK_UNITS)
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
			for (const [account, list] of byAccount) observeEvents(agentDir, account, list, [], check)
			backend.putNote("agent", PROGRESS_NOTE, JSON.stringify({ ...progress, units: done }))
		})
		await setImmediate()
	}
	backend.tx(() => {
		check()
		// A repository lookup that failed or ran out of time retries the group with a later pass.
		if (settled) for (const recordHash of changed.keys()) backend.clearTranslation(recordHash)
		backend.deleteNote("agent", PROGRESS_NOTE)
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
	report: PullRequestCostReport,
	deadline: number,
	bounded: AbortSignal,
	check: () => void,
): Promise<{ repositories: Map<string, RepositoryIdentity>; settled: boolean }> {
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
	return { repositories, settled: [...needed].every((repository) => repositories.has(repository)) }
}
