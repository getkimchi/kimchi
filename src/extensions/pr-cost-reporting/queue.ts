import { createHash, randomUUID } from "node:crypto"
import { mkdir, open } from "node:fs/promises"
import { join } from "node:path"
import { lock } from "proper-lockfile"
import { writeFileDurably } from "../../config/json.js"
import { readTelemetryConfig } from "../../config.js"
import { isWorkId } from "../../shared/work-id.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"
import { isWorkAccount, type WorkAccount } from "../work-attribution/scope.js"
import { object, SHA256_HEX } from "../work-attribution/summary.js"
import { machineFingerprint } from "./machine.js"
import {
	accountKey,
	MAX_REVISION,
	type ReportingRepository,
	type RepositorySnapshot,
	repositoryKey,
	revision,
	SNAPSHOT_LIMITS,
	type SnapshotContent,
	type SnapshotLimits,
	validateSnapshot,
	validTime,
	type WireSnapshot,
} from "./snapshot.js"

export interface SnapshotAck {
	status: "accepted" | "unchanged" | "stale"
	revision: string
	receivedAt: string
}

/** Scopes and limit names an upload rejection can carry; the server's frozen limits only bound its queries. */
export const LIMIT_SCOPES = ["snapshot", "producer", "contributor", "organization"] as const
export const LIMIT_NAMES = [
	"bytes",
	"requests",
	"pullRequests",
	"windowedPullRequests",
	"snapshots",
	"repositories",
	"billingIds",
] as const
/** Contributor and organization limits apply to every repository of the account. */
export const ACCOUNT_SCOPES: readonly string[] = ["contributor", "organization"]

/** A validated PR_COST_LIMIT rejection. Free-form server text never enters durable state. */
export interface ServerLimit {
	scope?: (typeof LIMIT_SCOPES)[number]
	limit?: (typeof LIMIT_NAMES)[number]
	current?: number
	maximum?: number
	/** When the server reported it. */
	at: number
}

export interface AccountPause {
	limit: ServerLimit
	retryAt: number
	noticeShown?: true
}

/** Ordinary changes upload at most once in this window per repository. */
export const UPLOAD_INTERVAL_MS = 5 * 60_000
/** A limit learned from the server is retried at the normal limits after a week. */
const LEARNED_LIMIT_MS = 7 * 24 * 60 * 60_000
/** The local queue's size limit; a replacement that would cross it waits instead of blocking every repository. */
const MAX_STATE_BYTES = 24 * 1024 * 1024
/** Room for JSON punctuation the per-entry estimate leaves out. */
const STATE_SIZE_MARGIN = 64 * 1024

export interface PendingRepository {
	account: WorkAccount
	repository: ReportingRepository
	revision: string
	/** Membership that may still exist on the server; only a matching ACK can shrink it. */
	requestHashes: string[]
	held?: boolean
	acceptedDigest?: string
	pendingDigest?: string
	pending?: WireSnapshot
	attempts: number
	retryAt: number
	lastError?: string
	lastAcknowledgedAt?: string
	/** Start of the last upload attempt; ordinary changes wait UPLOAD_INTERVAL_MS after it. */
	uploadedAt?: number
	/** The pending snapshot changes a PR state, carries a new explicit correction or withdraws claims. */
	urgent?: true
	/** PR states and explicit corrections the server acknowledged; a change to them uploads at once. */
	markers?: string[]
	/** The last PR_COST_LIMIT rejection of this repository, until an upload is accepted. */
	limit?: ServerLimit
	/** Smaller snapshot limits learned from a snapshot-scope rejection, used until `until`. */
	learned?: Partial<SnapshotLimits> & { until: number }
	/** Requests left out of the latest queued snapshot to fit the limits. */
	trimmed?: number
	/** The one-time partial-report notice was shown for this repository. */
	limitNoticeShown?: true
}

export interface ReportingState {
	version: 1
	enabled: boolean
	/** New queues follow SaaS uploads until an explicit /pr-reporting choice is saved. */
	followsTelemetry?: true
	defaultNoticeShown?: true
	producerId: string
	/** Hashed machine ID that owns producerId; a home copied to another machine starts a new producer. */
	machine?: string
	entries: Record<string, PendingRepository>
	/** Account-wide limit pauses, keyed by account. */
	paused?: Record<string, AccountPause>
	error?: string
}

export function reportingDirectory(agentDir: string): string {
	return join(agentDir, "pr-cost-reporting")
}

const statePath = (agentDir: string) => join(reportingDirectory(agentDir), "state.json")
const requestHash = (requestId: string) => createHash("sha256").update(requestId).digest("hex")
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0

function validLimit(value: unknown): value is ServerLimit {
	return (
		object(value) &&
		(value.scope === undefined || LIMIT_SCOPES.some((scope) => scope === value.scope)) &&
		(value.limit === undefined || LIMIT_NAMES.some((name) => name === value.limit)) &&
		(value.current === undefined || count(value.current)) &&
		(value.maximum === undefined || count(value.maximum)) &&
		Number.isFinite(value.at)
	)
}

function validEntryExtras(entry: PendingRepository): boolean {
	const learned = entry.learned
	return (
		(entry.uploadedAt === undefined || Number.isFinite(entry.uploadedAt)) &&
		(entry.urgent === undefined || entry.urgent === true) &&
		(entry.markers === undefined ||
			(Array.isArray(entry.markers) &&
				entry.markers.every((marker) => typeof marker === "string" && marker.length <= 256))) &&
		(entry.limit === undefined || validLimit(entry.limit)) &&
		(learned === undefined ||
			(object(learned) &&
				Number.isFinite(learned.until) &&
				[learned.requests, learned.pullRequests, learned.bytes].every(
					(value) => value === undefined || (count(value) && value > 0),
				))) &&
		(entry.trimmed === undefined || count(entry.trimmed)) &&
		(entry.limitNoticeShown === undefined || entry.limitNoticeShown === true)
	)
}

/** What the server must hear about at once: PR states and explicit `/work` corrections. */
export function snapshotMarkers(content: SnapshotContent): string[] {
	const markers = new Set(content.pullRequests.map((pr) => `pull-request:${pr.id}:${pr.state}`))
	for (const request of content.requests)
		if (request.correction?.source === "work-command")
			markers.add(`correction:${request.correction.id}:${request.correction.revision}`)
	return [...markers].sort()
}

function empty(): ReportingState {
	return {
		version: 1,
		enabled: readTelemetryConfig().enabled,
		followsTelemetry: true,
		producerId: randomUUID(),
		entries: {},
	}
}

export async function readReportingState(agentDir: string): Promise<ReportingState> {
	return (await loadReportingState(agentDir)).state
}

/** The validated state and, when the file exists, its text, so an unchanged update can skip the write. */
async function loadReportingState(agentDir: string): Promise<{ state: ReportingState; text?: string }> {
	try {
		const file = await open(statePath(agentDir), "r")
		let value: ReportingState
		let text: string
		try {
			if ((await file.stat()).size > MAX_STATE_BYTES) throw new Error("PR reporting state exceeds its local size limit")
			text = await file.readFile("utf8")
			value = JSON.parse(text)
		} finally {
			await file.close()
		}
		if (
			value?.version !== 1 ||
			typeof value.enabled !== "boolean" ||
			(value.followsTelemetry !== undefined && value.followsTelemetry !== true) ||
			(value.defaultNoticeShown !== undefined && value.defaultNoticeShown !== true) ||
			!isWorkId(value.producerId) ||
			(value.machine !== undefined && !SHA256_HEX.test(value.machine)) ||
			!value.entries ||
			typeof value.entries !== "object" ||
			Array.isArray(value.entries)
		)
			throw new Error("Invalid PR reporting state")
		for (const [key, entry] of Object.entries(value.entries)) {
			if (
				!isWorkAccount(entry.account) ||
				!revision(entry.revision) ||
				!entry.repository ||
				!Number.isSafeInteger(entry.attempts) ||
				entry.attempts < 0 ||
				!Number.isFinite(entry.retryAt) ||
				!Array.isArray(entry.requestHashes) ||
				entry.requestHashes.some((hash) => typeof hash !== "string" || !SHA256_HEX.test(hash)) ||
				key !== `${accountKey(entry.account)}:${repositoryKey(entry.repository)}` ||
				!validEntryExtras(entry)
			)
				throw new Error("Invalid PR reporting state")
			if (entry.pending) {
				validateSnapshot(entry.pending)
				if (
					entry.pending.producerId !== value.producerId ||
					entry.pending.revision !== entry.revision ||
					repositoryKey(entry.pending.repository) !== repositoryKey(entry.repository)
				)
					throw new Error("Invalid PR reporting state")
			}
		}
		if (
			value.paused !== undefined &&
			(!object(value.paused) ||
				Object.values(value.paused).some(
					(pause) =>
						!object(pause) ||
						!validLimit(pause.limit) ||
						!Number.isFinite(pause.retryAt) ||
						(pause.noticeShown !== undefined && pause.noticeShown !== true),
				))
		)
			throw new Error("Invalid PR reporting state")
		if (value.followsTelemetry) value.enabled = readTelemetryConfig().enabled
		const machine = await machineFingerprint()
		// Two machines sharing a producer would keep replacing each other's claims; the server deduplicates bills across producers.
		if (machine && value.machine && value.machine !== machine) {
			value.producerId = randomUUID()
			value.machine = machine
			value.entries = {}
			value.paused = undefined
		}
		trackPRCostMetric({
			kind: "queueDepth",
			value: Object.values(value.entries).filter((entry) => entry.pending).length,
		})
		return { state: value, text }
	} catch (error) {
		if (object(error) && error.code === "ENOENT") {
			trackPRCostMetric({ kind: "queueDepth", value: 0 })
			return { state: empty() }
		}
		throw new Error("PR reporting state is unreadable; queued reports were not replaced", { cause: error })
	}
}

async function update(agentDir: string, mutate: (state: ReportingState) => void): Promise<ReportingState> {
	const directory = reportingDirectory(agentDir)
	await mkdir(directory, { recursive: true, mode: 0o700 })
	let compromised: Error | undefined
	const release = await lock(directory, {
		retries: { retries: 20, minTimeout: 10, maxTimeout: 50 },
		stale: 5000,
		update: 1000,
		onCompromised: (error) => {
			compromised = error
		},
	})
	try {
		const { state, text } = await loadReportingState(agentDir)
		state.machine ??= await machineFingerprint()
		mutate(state)
		const body = `${JSON.stringify(state)}\n`
		// Passes run every 30 seconds; an unchanged queue is not rewritten or synced.
		if (body === text) return state
		if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error("PR reporting queue exceeds its local size limit")
		await writeFileDurably(statePath(agentDir), body, () => {
			if (compromised) throw compromised
		})

		const parent = await open(directory, "r")
		try {
			await parent.sync()
		} finally {
			await parent.close()
		}
		trackPRCostMetric({
			kind: "queueDepth",
			value: Object.values(state.entries).filter((entry) => entry.pending).length,
		})
		return state
	} finally {
		if (!compromised) await release()
	}
}

/** An explicit choice also restarts delivery: the next snapshot of every repository goes out at once. */
export function setReportingEnabled(agentDir: string, enabled: boolean): Promise<ReportingState> {
	return update(agentDir, (state) => {
		state.enabled = enabled
		state.followsTelemetry = undefined
		state.error = undefined
		state.paused = undefined
		for (const entry of Object.values(state.entries)) {
			entry.uploadedAt = undefined
			entry.attempts = 0
			entry.retryAt = 0
			if (enabled) continue
			// The discarded replacement may have arrived even if its acknowledgement did not.
			if (entry.pending) entry.acceptedDigest = undefined
			entry.pending = undefined
			entry.pendingDigest = undefined
			entry.urgent = undefined
			entry.lastError = undefined
			entry.held = undefined
		}
	})
}

/** Claim the installation notice under the queue lock so concurrent sessions show it once. */
export async function takeReportingNotice(agentDir: string): Promise<boolean> {
	let show = false
	await update(agentDir, (state) => {
		if (state.enabled && state.followsTelemetry && !state.defaultNoticeShown) {
			state.defaultNoticeShown = true
			show = true
		}
	})
	return show
}

export function recordReportingError(agentDir: string, error: string): Promise<ReportingState> {
	return update(agentDir, (state) => {
		if (state.enabled) state.error = error
	})
}

/**
 * Replaces a repository's entire inventory. The fsynced rename completes before delivery can begin.
 * Every change replaces the pending snapshot; whether it may skip the upload window is decided here.
 */

export async function queueSnapshots(
	agentDir: string,
	snapshots: RepositorySnapshot[],
	completeInventory = false,
): Promise<ReportingState> {
	let largest: { requests: number; bytes: number } | undefined
	const state = await update(agentDir, (state) => {
		if (!state.enabled) return
		const now = Date.now()
		const invalid = new Set<string>()
		const current = new Map<string, RepositorySnapshot>()
		for (const snapshot of snapshots) {
			const key = `${accountKey(snapshot.account)}:${repositoryKey(snapshot.content.repository)}`
			try {
				const next = BigInt(state.entries[key]?.revision ?? "0") + 1n
				validateSnapshot({
					schemaVersion: 1,
					producerId: state.producerId,
					revision: String(next),
					generatedAt: new Date().toISOString(),
					...snapshot.content,
				})
				current.set(key, snapshot)
			} catch {
				invalid.add(key)
			}
		}

		const reported = new Map<string, Set<string>>()
		for (const snapshot of current.values()) {
			if (snapshot.incomplete) continue
			const key = accountKey(snapshot.account)
			const members = reported.get(key) ?? new Set<string>()
			for (const requestId of snapshot.observedRequestIds ??
				snapshot.content.requests.map((request) => request.requestId))
				if (isWorkId(requestId)) members.add(requestHash(requestId))
			reported.set(key, members)
		}

		let held = 0
		const withdrawals = new Set<string>()
		for (const [key, entry] of Object.entries(state.entries)) {
			if (entry.learned && entry.learned.until <= now) entry.learned = undefined
			if (!current.has(key)) {
				if (
					!invalid.has(key) &&
					entry.requestHashes.every((member) => reported.get(accountKey(entry.account))?.has(member))
				) {
					current.set(key, {
						account: entry.account,
						content: {
							repository: entry.repository,
							pullRequests: [],
							requests: [],
							coverage: { observedRequests: 0, unpricedRequests: 0, historyComplete: completeInventory },
						},
					})
					withdrawals.add(key)
				} else {
					entry.held = true
					// An invalid replacement is reported as invalid, not also as missing evidence.
					if (!invalid.has(key)) held++
				}
			}
		}

		const changes: [string, RepositorySnapshot, string][] = []
		for (const [key, snapshot] of current) {
			const digest = createHash("sha256").update(JSON.stringify(snapshot.content)).digest("hex")
			const entry = state.entries[key]
			if (
				entry &&
				(snapshot.incomplete ||
					entry.requestHashes.some((member) => !reported.get(accountKey(entry.account))?.has(member)))
			) {
				entry.held = true
				held++
				continue
			}
			if (entry) entry.held = undefined
			if (entry?.pendingDigest === digest || (!entry?.pending && entry?.acceptedDigest === digest)) continue
			changes.push([key, snapshot, digest])
		}

		// An explicit correction can move requests to another repository; when one first appears, every
		// changed repository of that account goes out at once, not only the one that carries the receipt.
		const corrected = new Set<string>()
		for (const [key, snapshot] of changes) {
			const entry = state.entries[key]
			const seen = new Set([...(entry?.markers ?? []), ...(entry?.pending ? snapshotMarkers(entry.pending) : [])])
			if (snapshotMarkers(snapshot.content).some((marker) => marker.startsWith("correction:") && !seen.has(marker)))
				corrected.add(accountKey(snapshot.account))
		}

		// Smaller replacements first; one that would push the queue past its size limit waits for space.
		let size = changes.length ? Buffer.byteLength(JSON.stringify(state)) : 0
		let tooLarge = 0
		changes.sort(([, a], [, b]) => JSON.stringify(a.content).length - JSON.stringify(b.content).length)
		for (const [key, snapshot, digest] of changes) {
			const entry = state.entries[key]
			const next = BigInt(entry?.revision ?? "0") + 1n
			if (next > MAX_REVISION) throw new Error("PR reporting revision limit reached")
			const pending: WireSnapshot = {
				schemaVersion: 1,
				producerId: state.producerId,
				revision: String(next),
				generatedAt: new Date().toISOString(),
				...snapshot.content,
			}

			// Unacknowledged PR states and corrections stay urgent through replacements until the server has them.
			const acknowledged = new Set(entry?.markers)
			const urgent =
				entry?.urgent ||
				withdrawals.has(key) ||
				corrected.has(accountKey(snapshot.account)) ||
				snapshotMarkers(snapshot.content).some((marker) => !acknowledged.has(marker))
			const replacement: PendingRepository = {
				...entry,
				account: snapshot.account,
				repository: snapshot.content.repository,
				revision: String(next),
				requestHashes: [
					...new Set([
						...(entry?.requestHashes ?? []),
						...snapshot.content.requests.map((request) => request.requestId).map(requestHash),
					]),
				].sort(),
				held: undefined,
				pendingDigest: digest,
				pending,
				urgent: urgent || undefined,
				trimmed: snapshot.content.coverage.trimmedRequests || undefined,
				attempts: entry?.attempts ?? 0,
				retryAt: entry?.retryAt ?? 0,
			}

			const grown =
				Buffer.byteLength(JSON.stringify({ [key]: replacement })) -
				(entry ? Buffer.byteLength(JSON.stringify({ [key]: entry })) : 0)
			if (size + grown > MAX_STATE_BYTES - STATE_SIZE_MARGIN) {
				if (entry) entry.held = true
				tooLarge++
				continue
			}
			size += grown
			state.entries[key] = replacement
			largest = {
				requests: Math.max(largest?.requests ?? 0, pending.requests.length),
				bytes: Math.max(largest?.bytes ?? 0, Buffer.byteLength(JSON.stringify(pending))),
			}
		}
		state.error =
			[
				...(held ? [`PR reporting held ${held} repository snapshot(s) because earlier evidence is missing`] : []),
				...(invalid.size
					? [
							`PR reporting held ${invalid.size} snapshot(s) that are invalid or exceed the upload limits after trimming`,
						]
					: []),
				...(tooLarge
					? [`PR reporting held ${tooLarge} snapshot(s) until queued reports leave room in the local queue`]
					: []),
			].join(". ") || undefined
	})
	if (largest) {
		trackPRCostMetric({ kind: "snapshotRequests", value: largest.requests })
		trackPRCostMetric({ kind: "snapshotBytes", value: largest.bytes })
	}
	return state
}

export function acknowledgeSnapshot(
	agentDir: string,
	key: string,
	sentRevision: string,
	ack: SnapshotAck,
): Promise<ReportingState> {
	return update(agentDir, (state) => {
		const entry = state.entries[key]
		if (!state.enabled || !entry?.pending || entry.pending.revision !== sentRevision) return
		if (
			!ack ||
			!revision(ack.revision) ||
			BigInt(ack.revision) < BigInt(sentRevision) ||
			!["accepted", "unchanged", "stale"].includes(ack.status) ||
			!validTime(ack.receivedAt) ||
			(ack.status === "stale" ? BigInt(ack.revision) <= BigInt(sentRevision) : ack.revision !== sentRevision)
		)
			throw new Error("Invalid PR reporting acknowledgement")
		if (ack.status !== "stale") {
			entry.requestHashes = entry.pending.requests.map((request) => requestHash(request.requestId)).sort()
			entry.acceptedDigest = entry.pendingDigest
			entry.lastAcknowledgedAt = ack.receivedAt
			entry.markers = snapshotMarkers(entry.pending)
			entry.limit = undefined
			// Only an upload that adds claims proves an account limit no longer blocks; withdrawals pass it.
			if (state.paused && (entry.pending.requests.length || entry.pending.pullRequests.length)) {
				delete state.paused[accountKey(entry.account)]
				if (!Object.keys(state.paused).length) state.paused = undefined
			}
		} else entry.acceptedDigest = undefined
		entry.revision = ack.revision
		entry.pending = undefined
		entry.pendingDigest = undefined
		entry.urgent = undefined
		entry.lastError = undefined
		entry.attempts = 0
		entry.retryAt = 0
		entry.uploadedAt = Date.now()
	})
}

export function deferSnapshot(
	agentDir: string,
	key: string,
	sentRevision: string,
	retryAt: number,
	message: string,
): Promise<ReportingState> {
	return update(agentDir, (state) => {
		const entry = state.entries[key]
		if (!state.enabled || entry?.pending?.revision !== sentRevision) return
		entry.attempts++
		entry.retryAt = retryAt
		entry.lastError = message
		entry.uploadedAt = Date.now()
	})
}

/**
 * A smaller cap for the rejected dimension, learned in one step. The server's overflow may scale with the
 * upload (another encoding of the same body) or add a constant (records it counts besides the upload), so
 * the cap is the smaller of the proportional and the subtractive target. A subtractive target of zero or
 * less cannot be met by any upload, so only the proportional one applies then. The client never sends more
 * than the server's 2,000 windowed PR IDs, so that limit teaches nothing.
 */

function learnedLimit(pending: WireSnapshot, limit: ServerLimit): number | undefined {
	if (limit.limit !== "requests" && limit.limit !== "pullRequests" && limit.limit !== "bytes") return undefined
	const measured = {
		requests: pending.requests.length,
		pullRequests: pending.pullRequests.length,
		bytes: Buffer.byteLength(JSON.stringify(pending)),
	}[limit.limit]
	const { current, maximum } = limit
	let target = Math.floor(measured * 0.9)
	if (current !== undefined && maximum !== undefined && current > maximum) {
		const subtractive = measured - (current - maximum)
		target = Math.floor((measured * maximum) / current)
		if (subtractive > 0) target = Math.min(target, subtractive)
	}

	const learned = Math.min(target, measured - 1)
	return learned > 0 ? learned : undefined
}

/**
 * A PR_COST_LIMIT rejection is quota, not an outage. Account-wide limits pause every repository of the
 * account; a repository limit waits on its own counter, and a snapshot limit also teaches a smaller cap.
 */

export function limitSnapshot(
	agentDir: string,
	key: string,
	sentRevision: string,
	limit: ServerLimit,
	retryAt: number,
): Promise<ReportingState> {
	return update(agentDir, (state) => {
		const entry = state.entries[key]
		if (!state.enabled || !entry?.pending || entry.pending.revision !== sentRevision) return
		entry.uploadedAt = Date.now()
		entry.lastError = undefined
		if (limit.scope && ACCOUNT_SCOPES.includes(limit.scope)) {
			const account = accountKey(entry.account)
			const previous = state.paused?.[account]
			state.paused = {
				...state.paused,
				[account]: { limit, retryAt, ...(previous?.noticeShown ? { noticeShown: true } : {}) },
			}
			return
		}
		entry.limit = limit
		entry.retryAt = retryAt
		const learned = limit.scope === "snapshot" ? learnedLimit(entry.pending, limit) : undefined
		if (learned && limit.limit)
			entry.learned = {
				...(entry.learned && entry.learned.until > limit.at ? entry.learned : {}),
				[limit.limit]: learned,
				until: limit.at + LEARNED_LIMIT_MS,
			}
	})
}

/** Limits a repository's server rejections taught, by entry key, for buildSnapshots. */
export function learnedLimits(state: ReportingState, now = Date.now()): Map<string, SnapshotLimits> {
	const limits = new Map<string, SnapshotLimits>()
	for (const [key, entry] of Object.entries(state.entries)) {
		const learned = entry.learned
		if (!learned || learned.until <= now) continue
		limits.set(key, {
			requests: Math.min(SNAPSHOT_LIMITS.requests, learned.requests ?? Number.POSITIVE_INFINITY),
			pullRequests: Math.min(SNAPSHOT_LIMITS.pullRequests, learned.pullRequests ?? Number.POSITIVE_INFINITY),
			bytes: Math.min(SNAPSHOT_LIMITS.bytes, learned.bytes ?? Number.POSITIVE_INFINITY),
		})
	}
	return limits
}

export interface LimitNotices {
	repositories: ReportingRepository[]
	pauses: ServerLimit[]
}

/** Repositories and accounts whose one-time limit notice is still due. */
export function dueLimitNotices(state: ReportingState): LimitNotices {
	if (!state.enabled) return { repositories: [], pauses: [] }
	return {
		repositories: Object.values(state.entries)
			.filter((entry) => !entry.limitNoticeShown && (entry.trimmed || entry.limit))
			.map((entry) => entry.repository),
		pauses: Object.values(state.paused ?? {})
			.filter((pause) => !pause.noticeShown)
			.map((pause) => pause.limit),
	}
}

/** Claim limit notices under the queue lock so concurrent sessions show each once. */
export async function takeLimitNotices(agentDir: string): Promise<LimitNotices> {
	let notices: LimitNotices = { repositories: [], pauses: [] }
	await update(agentDir, (state) => {
		notices = dueLimitNotices(state)
		if (!state.enabled) return
		for (const entry of Object.values(state.entries)) if (entry.trimmed || entry.limit) entry.limitNoticeShown = true
		for (const pause of Object.values(state.paused ?? {})) pause.noticeShown = true
	})
	return notices
}
