import { createHash, randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { lock } from "proper-lockfile"
import { writeFileDurably } from "../../config/json.js"
import { isWorkId } from "../../shared/work-id.js"
import { isTelemetryEnabled } from "../../telemetry-policy.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"
import { isWorkAccount, type WorkAccount } from "../work-attribution/scope.js"
import { object, SHA256_HEX } from "../work-attribution/summary.js"
import { backendFor, diagnostic } from "./ledger/records.js"
import { machineFingerprint } from "./machine.js"
import {
	accountKey,
	fitSnapshot,
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
	/** Original legacy producer's machine; copied pending uploads keep this identity until acknowledged. */
	machine?: string
	entries: Record<string, PendingRepository>
	/** Account-wide limit pauses, keyed by account. */
	paused?: Record<string, AccountPause>
	error?: string
	/** Requests the latest capture left out without original account or repository evidence; others still report. */
	skippedRequests?: number
}

export function reportingDirectory(agentDir: string): string {
	return join(agentDir, "pr-cost-reporting")
}

export function reportingStatePath(agentDir: string): string {
	return join(reportingDirectory(agentDir), "state.json")
}
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

/** An ordinary change waits out the window after the last upload attempt; an urgent one, or a clock set back, does not. */
export function inUploadWindow(entry: PendingRepository, now: number): boolean {
	return (
		!entry.urgent &&
		entry.uploadedAt !== undefined &&
		entry.uploadedAt <= now &&
		now - entry.uploadedAt < UPLOAD_INTERVAL_MS
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
		enabled: isTelemetryEnabled(),
		followsTelemetry: true,
		producerId: randomUUID(),
		entries: {},
	}
}

export async function readReportingState(agentDir: string): Promise<ReportingState> {
	return (await loadReportingState(agentDir)).state
}

/** The new reporting producer rotates independently; legacy pending uploads keep their original identity. */
export async function reportingProducer(agentDir: string, assertCurrent: () => void): Promise<string> {
	assertCurrent()
	const machine = await machineFingerprint()
	assertCurrent()
	const backend = backendFor(agentDir)
	const legacy =
		backend.getNote("agent", "reporting-producer") === undefined ? await readReportingState(agentDir) : undefined
	return backend.tx(() => {
		assertCurrent()
		const previous = backend.getNote("agent", "reporting-producer")
		if (previous === undefined && !legacy) throw new Error("PR reporting producer disappeared")
		const value: unknown =
			previous === undefined
				? { version: 1, producerId: legacy?.producerId, machine: legacy?.machine }
				: JSON.parse(previous)
		if (
			!object(value) ||
			value.version !== 1 ||
			!isWorkId(value.producerId) ||
			(value.machine !== undefined && (typeof value.machine !== "string" || !SHA256_HEX.test(value.machine)))
		)
			throw new Error("Invalid PR reporting producer")
		const next = { version: 1, producerId: value.producerId, machine: value.machine }
		if (machine) {
			if (next.machine && next.machine !== machine) next.producerId = randomUUID()
			next.machine = machine
		}
		const body = JSON.stringify(next)
		if (body !== previous) backend.putNote("agent", "reporting-producer", body)
		assertCurrent()
		return next.producerId
	})
}

function validateEntry(key: string, entry: PendingRepository, producerId: string): void {
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
			entry.pending.producerId !== producerId ||
			entry.pending.revision !== entry.revision ||
			repositoryKey(entry.pending.repository) !== repositoryKey(entry.repository)
		)
			throw new Error("Invalid PR reporting state")
	}
}

/** (mtime, size) of state.json without parsing; pass gates read freshness through this. */
export function reportingStateFileSignature(agentDir: string): { mtimeMs: number; size: number } | undefined {
	try {
		const file = statSync(reportingStatePath(agentDir))
		return { mtimeMs: file.mtimeMs, size: file.size }
	} catch (error) {
		if (!object(error) || error.code !== "ENOENT") throw error
		return undefined
	}
}

/** The validated state and, when the file exists, its text, so an unchanged update can skip the write. */
async function loadReportingState(agentDir: string): Promise<{ state: ReportingState; text?: string }> {
	try {
		const file = await open(reportingStatePath(agentDir), "r")
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
			(value.skippedRequests !== undefined && !count(value.skippedRequests)) ||
			!value.entries ||
			typeof value.entries !== "object" ||
			Array.isArray(value.entries)
		)
			throw new Error("Invalid PR reporting state")
		for (const [key, entry] of Object.entries(value.entries)) validateEntry(key, entry, value.producerId)
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
		if (value.followsTelemetry) value.enabled = isTelemetryEnabled()
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

async function update(
	agentDir: string,
	mutate: (state: ReportingState, check: () => void) => void | Promise<void>,
	assertCurrent: () => void = () => {},
): Promise<ReportingState> {
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
	const check = () => {
		if (compromised) throw compromised
		assertCurrent()
	}
	try {
		const { state, text } = await loadReportingState(agentDir)
		const before = JSON.stringify(state)
		check()
		await mutate(state, check)
		check()
		if (text === undefined && JSON.stringify(state) === before) return state
		state.machine ??= await machineFingerprint()
		check()
		const body = `${JSON.stringify(state)}\n`
		// Passes run every 30 seconds; an unchanged queue is not rewritten or synced.
		if (body === text) return state
		if (Buffer.byteLength(body) > MAX_STATE_BYTES) throw new Error("PR reporting queue exceeds its local size limit")
		await writeFileDurably(reportingStatePath(agentDir), body, check)

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
		state.skippedRequests = undefined
		state.paused = undefined
		for (const entry of Object.values(state.entries)) {
			entry.uploadedAt = undefined
			entry.attempts = 0
			entry.retryAt = 0
		}
		if (enabled) backendFor(agentDir).putNote("agent", "legacy-snapshot-resume", randomUUID())
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

export function recordReportingError(agentDir: string, error: string | undefined): Promise<ReportingState> {
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
	skippedRequests = 0,
	assertCurrent?: () => void,
): Promise<ReportingState> {
	const machine = await machineFingerprint()
	let largest: { requests: number; bytes: number } | undefined
	const state = await update(
		agentDir,
		(state) => {
			if (!state.enabled) return
			if (machine && state.machine && machine !== state.machine)
				throw new Error("PR reporting snapshots from another machine must drain unchanged")
			// Legacy callers retain their queue contract; the current reporter freezes under this same lock.
			if (assertCurrent) freezeState(agentDir, state, assertCurrent)
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
				// An acknowledged withdrawal left no claims; rebuilding it would only send it again.
				if (!current.has(key) && (entry.requestHashes.length || entry.pending)) {
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

			const changes: [string, RepositorySnapshot, string, number][] = []
			for (const [key, snapshot] of current) {
				const text = JSON.stringify(snapshot.content)
				const digest = createHash("sha256").update(text).digest("hex")
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
				// History that is all outside the upload window has nothing to send and no earlier upload to replace.
				if (!entry && !snapshot.content.requests.length && !snapshot.content.pullRequests.length) continue
				changes.push([key, snapshot, digest, text.length])
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

			// Smaller replacements first; one that would push the queue past its size limit waits for space. The snapshot it
			// would replace stays deliverable: acknowledging queued snapshots is what frees that space.
			let size = changes.length ? Buffer.byteLength(JSON.stringify(state)) : 0
			let tooLarge = 0
			changes.sort((a, b) => a[3] - b[3])
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
			state.skippedRequests = skippedRequests || undefined
		},
		assertCurrent,
	)
	if (largest) {
		trackPRCostMetric({ kind: "snapshotRequests", value: largest.requests })
		trackPRCostMetric({ kind: "snapshotBytes", value: largest.bytes })
	}
	return state
}

function validateAck(sentRevision: string, ack: SnapshotAck): void {
	if (
		!ack ||
		!revision(ack.revision) ||
		BigInt(ack.revision) < BigInt(sentRevision) ||
		!["accepted", "unchanged", "stale"].includes(ack.status) ||
		!validTime(ack.receivedAt) ||
		(ack.status === "stale" ? BigInt(ack.revision) <= BigInt(sentRevision) : ack.revision !== sentRevision)
	)
		throw new Error("Invalid PR reporting acknowledgement")
}

function applyAck(state: ReportingState, entry: PendingRepository, sentRevision: string, ack: SnapshotAck): void {
	if (!entry.pending || entry.pending.revision !== sentRevision) return
	validateAck(sentRevision, ack)
	if (ack.status !== "stale") {
		const acked = entry.pending.requests.map((request) => requestHash(request.requestId)).sort()
		// A trimmed body keeps the server's earlier claims under the same revision, so only a
		// complete inventory shrinks membership; an incomplete one keeps what it may still hold.
		entry.requestHashes = entry.pending.coverage.historyComplete
			? acked
			: [...new Set([...entry.requestHashes, ...acked])].sort()
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
}

export function acknowledgeSnapshot(
	agentDir: string,
	key: string,
	sentRevision: string,
	ack: SnapshotAck,
): Promise<ReportingState> {
	return update(agentDir, (state) => {
		const entry = state.entries[key]
		if (state.enabled && entry) applyAck(state, entry, sentRevision, ack)
	})
}

function applyDefer(entry: PendingRepository, retryAt: number, message: string): void {
	entry.attempts++
	entry.retryAt = retryAt
	entry.lastError = message
	entry.uploadedAt = Date.now()
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
		applyDefer(entry, retryAt, message)
	})
}

/**
 * A smaller cap for the rejected dimension, learned in one step. The server's overflow may scale with the
 * upload (another encoding of the same body) or add a constant (records it counts besides the upload), so
 * the cap is the smaller of the proportional and the subtractive target. A subtractive target of zero or
 * less cannot be met by any upload, so only the proportional one applies then. The client never sends more
 * than the server's 2,000 windowed PR IDs, so that limit teaches nothing.
 */
export function learnedLimit(pending: WireSnapshot, limit: ServerLimit): number | undefined {
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
function applyLimit(state: ReportingState, entry: PendingRepository, limit: ServerLimit, retryAt: number): void {
	if (!entry.pending) return
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
}

export function limitSnapshot(
	agentDir: string,
	key: string,
	sentRevision: string,
	limit: ServerLimit,
	retryAt: number,
): Promise<ReportingState> {
	return update(agentDir, (state) => {
		const entry = state.entries[key]
		if (state.enabled && entry?.pending?.revision === sentRevision) applyLimit(state, entry, limit, retryAt)
	})
}

const FROZEN_SNAPSHOTS = "legacy-pr-cost-snapshots"
const SNAPSHOT_RECEIPTS = "legacy-pr-cost-snapshot-receipts"
/** Per key, the pending frozen ids and their sizes; the guard that keeps a stuck queue bounded. */
const FROZEN_INDEX = "legacy-pr-cost-pending"
export const FROZEN_QUEUE_BYTES = 64 * 1024 * 1024
let frozenQueueBytes = FROZEN_QUEUE_BYTES

/** Test-only override for the per-key pending byte cap. */
export function __setFrozenQueueCapForTest(bytes: number): void {
	frozenQueueBytes = bytes
}

interface FrozenIndexEntry {
	id: string
	bytes: number
	/** The body was held when it was frozen; held claims are never dropped by the cap. */
	held?: true
}

function readFrozenIndex(backend: ReturnType<typeof backendFor>, key: string): FrozenIndexEntry[] {
	const body = backend.getNote(FROZEN_INDEX, key)
	if (body === undefined) return []
	try {
		const value: unknown = JSON.parse(body)
		if (
			Array.isArray(value) &&
			value.every(
				(entry) =>
					object(entry) &&
					typeof entry.id === "string" &&
					typeof entry.bytes === "number" &&
					entry.bytes >= 0 &&
					(entry.held === undefined || entry.held === true),
			)
		)
			return value as FrozenIndexEntry[]
	} catch {
		// A damaged index resets; the pending notes it forgot still drain through the normal walk.
	}
	return []
}

function writeFrozenIndex(backend: ReturnType<typeof backendFor>, key: string, entries: FrozenIndexEntry[]): void {
	if (entries.length) backend.putNote(FROZEN_INDEX, key, JSON.stringify(entries))
	else backend.deleteNote(FROZEN_INDEX, key)
}

/** Removes a frozen id from its key's index; the pending or receipt note itself is untouched. */
function unindexFrozen(backend: ReturnType<typeof backendFor>, key: string, id: string): void {
	writeFrozenIndex(
		backend,
		key,
		readFrozenIndex(backend, key).filter((entry) => entry.id !== id),
	)
}

/**
 * Records a frozen id for its key and keeps the key's pending queue bounded: when the total passes
 * the cap, the oldest pending bodies are dropped (with a diagnostic) so one undeliverable
 * repository cannot grow without limit. A body frozen while held keeps its claims and is never
 * the cap's victim; a body deleted mid-delivery elsewhere settles as a benign ownership change.
 */
function indexFrozen(
	backend: ReturnType<typeof backendFor>,
	agentDir: string,
	key: string,
	id: string,
	bytes: number,
	held?: boolean,
): void {
	const index = readFrozenIndex(backend, key).filter((entry) => entry.id !== id)
	index.push({ id, bytes, ...(held ? { held: true } : {}) })
	let total = index.reduce((sum, entry) => sum + entry.bytes, 0)
	while (index.length > 1 && total > frozenQueueBytes) {
		const oldest = index.find((entry) => entry.id !== id && !entry.held)
		if (!oldest) break
		index.splice(index.indexOf(oldest), 1)
		total -= oldest.bytes
		backend.deleteNote(FROZEN_SNAPSHOTS, oldest.id)
		diagnostic(agentDir, "frozen-queue-capped")
	}
	writeFrozenIndex(backend, key, index)
}

export interface FrozenSnapshot {
	version: 1
	id: string
	key: string
	body: string
	entry: PendingRepository
	ack?: SnapshotAck
	resume?: string
}

/** A kept request without billing evidence is the only unpriced one a legacy body can still identify. */
const legacyUnpriced = (request: SnapshotContent["requests"][number]) => !request.billingRecordIds.length

/**
 * A legacy pending body over the upload limits is trimmed before it is frozen: an oversized body can
 * never be delivered, and every later capture of the same claims would freeze another full copy.
 * Trimmed coverage is marked incomplete so the server keeps its earlier claims.
 */
export function trimLegacySnapshot(pending: WireSnapshot): WireSnapshot {
	const { schemaVersion, producerId, revision: rev, generatedAt, ...content } = pending
	if (
		content.requests.length <= SNAPSHOT_LIMITS.requests &&
		content.pullRequests.length <= SNAPSHOT_LIMITS.pullRequests &&
		Buffer.byteLength(JSON.stringify(pending)) <= SNAPSHOT_LIMITS.bytes
	)
		return pending
	const fitted = fitSnapshot(content, SNAPSHOT_LIMITS, legacyUnpriced)
	const trimmed: SnapshotContent = fitted
		? fitted.content
		: {
				repository: content.repository,
				pullRequests: [],
				requests: [],
				// Omission without a name withdraws an earlier upload's claims, so the emptied body
				// still names the PRs the original body held as windowed.
				...(content.windowedPullRequestIds === undefined
					? {}
					: { windowedPullRequestIds: content.windowedPullRequestIds }),
				coverage: {
					observedRequests: 0,
					unpricedRequests: 0,
					historyComplete: false,
					trimmedRequests: content.requests.length,
				},
			}
	// A body that cannot be represented under the limits still freezes; delivery retries trim it instead.
	if (fitted) fitted.content.coverage.trimmedRequests = (content.coverage.trimmedRequests ?? 0) + fitted.trimmed
	const next: WireSnapshot = { schemaVersion, producerId, revision: rev, generatedAt, ...trimmed }
	try {
		validateSnapshot(next)
		return next
	} catch {
		return pending
	}
}

function frozenId(account: WorkAccount, body: string): string {
	return createHash("sha256")
		.update(`${accountKey(account)}\0${body}`)
		.digest("hex")
}

function encodeFrozen(value: FrozenSnapshot): string {
	const { pending: _pending, ...entry } = value.entry
	return JSON.stringify({ ...value, entry })
}

function decodeFrozen(id: string, body: string): FrozenSnapshot {
	const value: FrozenSnapshot = JSON.parse(body)
	if (
		value?.version !== 1 ||
		value.id !== id ||
		typeof value.body !== "string" ||
		typeof value.key !== "string" ||
		!object(value.entry) ||
		value.entry.pending !== undefined
	)
		throw new Error("Invalid frozen PR snapshot")
	const pending: WireSnapshot = JSON.parse(value.body)
	validateSnapshot(pending)
	value.entry.pending = pending
	validateEntry(value.key, value.entry, pending.producerId)
	if (id !== frozenId(value.entry.account, value.body) || JSON.stringify(pending) !== value.body)
		throw new Error("Frozen PR snapshot body mismatch")
	if (value.ack !== undefined) validateAck(pending.revision, value.ack)
	if (value.resume !== undefined && !isWorkId(value.resume)) throw new Error("Invalid frozen PR resume marker")
	return value
}

function storedFrozen(agentDir: string, id: string): FrozenSnapshot | undefined {
	const backend = backendFor(agentDir)
	const pending = backend.getNote(FROZEN_SNAPSHOTS, id)
	const receipt = backend.getNote(SNAPSHOT_RECEIPTS, id)
	if (pending !== undefined && receipt !== undefined) throw new Error("Duplicate frozen PR snapshot ownership")
	const body = pending ?? receipt
	if (body === undefined) return
	const frozen = decodeFrozen(id, body)
	if ((receipt !== undefined) !== (frozen.ack !== undefined))
		throw new Error("Frozen PR snapshot receipt is missing or misplaced")
	return frozen
}

function frozenResume(agentDir: string): string | undefined {
	const resume = backendFor(agentDir).getNote("agent", "legacy-snapshot-resume")
	if (resume !== undefined && !isWorkId(resume)) throw new Error("Invalid PR reporting resume marker")
	return resume
}

function refreshFrozenSchedule(agentDir: string, frozen: FrozenSnapshot): void {
	const resume = frozenResume(agentDir)
	if (resume === frozen.resume) return
	frozen.resume = resume
	frozen.entry.uploadedAt = undefined
	frozen.entry.attempts = 0
	frozen.entry.retryAt = 0
}

function freezeState(agentDir: string, state: ReportingState, assertCurrent: () => void): void {
	const entries = Object.entries(state.entries).filter(([, entry]) => entry.pending)
	if (!entries.length) return
	const backend = backendFor(agentDir)
	backend.tx(() => {
		assertCurrent()
		for (const [key, entry] of entries) {
			// The queue's size limit applies to new frozen bodies whatever built them; the live entry keeps
			// the trimmed body so the next pass freezes the same id instead of another full copy. An
			// unchanged body leaves the entry alone: an acknowledged receipt clears `pending` here.
			const original = entry.pending
			if (!original) continue
			const pending = trimLegacySnapshot(original)
			const body = JSON.stringify(pending)
			const id = frozenId(entry.account, body)
			const frozen = storedFrozen(agentDir, id)
			if (frozen === undefined) {
				const value: FrozenSnapshot = { version: 1, id, key, body, entry, resume: frozenResume(agentDir) }
				backend.putNote(FROZEN_SNAPSHOTS, id, encodeFrozen(value))
				indexFrozen(backend, agentDir, key, id, Buffer.byteLength(body), entry.held)
			} else {
				if (frozen.key !== key || frozen.body !== body) throw new Error("Frozen PR snapshot identity mismatch")
				if (state.enabled && frozen.ack) applyAck(state, entry, entry.revision, frozen.ack)
			}
			if (pending !== original) entry.pending = pending
		}
		assertCurrent()
	})
}

/** Take ownership under the old writers' lock before capture or delivery can replace their pending body. */
export function freezeSnapshots(agentDir: string, assertCurrent: () => void): Promise<ReportingState> {
	return update(agentDir, (state, check) => freezeState(agentDir, state, check), assertCurrent)
}

/**
 * Rereads consent before an event batch is frozen, sent or acknowledged. The action runs under the state lock, so
 * turning reporting off cannot interleave with it. Events do not wait for legacy snapshots: one the server never
 * accepts, such as a body above the 1 MiB limit in front of the API, would hold its account's events for good.
 */
export async function withReportingConsent(
	agentDir: string,
	action: (check: () => void) => void,
	assertCurrent: () => void,
): Promise<boolean> {
	let ready = false
	await update(
		agentDir,
		(state, check) => {
			if (!state.enabled) return
			check()
			if (state.followsTelemetry && !isTelemetryEnabled()) return
			const consent = () => {
				check()
				if (state.followsTelemetry && !isTelemetryEnabled()) throw new Error("PR reporting is disabled")
			}
			action(consent)
			consent()
			ready = true
		},
		assertCurrent,
	)
	return ready
}

/** Retained receipts have their own indexed namespace; a bounded scan resumes without dropping pending bodies. */
export async function pendingFrozenSnapshots(
	agentDir: string,
	check: () => void,
	deadline: number,
): Promise<FrozenSnapshot[]> {
	const pending: FrozenSnapshot[] = []
	const backend = backendFor(agentDir)
	const start = backend.getNote("agent", "legacy-snapshot-cursor") ?? ""
	if (start && !SHA256_HEX.test(start)) throw new Error("Invalid frozen PR cursor")
	let after = start
	let wrapped = false
	const save = () =>
		backend.tx(() => {
			check()
			if (backend.getNote("agent", "legacy-snapshot-cursor") !== after)
				backend.putNote("agent", "legacy-snapshot-cursor", after)
			check()
		})
	for (;;) {
		check()
		const page = backend.readNotePage(FROZEN_SNAPSHOTS, after, 16)
		if (!page.length) {
			if (wrapped || !start) {
				save()
				return pending
			}
			after = ""
			wrapped = true
			continue
		}
		for (const row of page) {
			if (wrapped && row.name > start) {
				save()
				return pending
			}
			check()
			const frozen = decodeFrozen(row.name, row.body)
			if (frozen.ack) throw new Error("Completed PR snapshot remains in pending queue")
			refreshFrozenSchedule(agentDir, frozen)
			pending.push(frozen)
			after = row.name
			if (Date.now() >= deadline) {
				save()
				return pending
			}
		}
		await setImmediate()
	}
}

export function frozenSnapshotPending(agentDir: string, sent: FrozenSnapshot): boolean {
	const current = storedFrozen(agentDir, sent.id)
	if (current === undefined) return false
	if (current.body !== sent.body || current.key !== sent.key) throw new Error("Frozen PR snapshot changed")
	return current.ack === undefined
}

function updateFrozen(
	agentDir: string,
	sent: FrozenSnapshot,
	mutate: (state: ReportingState, frozen: FrozenSnapshot, live: PendingRepository | undefined) => void,
	assertCurrent: () => void,
): Promise<ReportingState> {
	return update(
		agentDir,
		(state) => {
			if (!state.enabled) return
			const backend = backendFor(agentDir)
			backend.tx(() => {
				assertCurrent()
				const frozen = storedFrozen(agentDir, sent.id)
				if (frozen === undefined) throw new Error("Frozen PR snapshot disappeared")
				if (frozen.body !== sent.body || frozen.key !== sent.key) throw new Error("Frozen PR snapshot changed")
				if (frozen.ack) return
				refreshFrozenSchedule(agentDir, frozen)
				const entry = state.entries[frozen.key]
				const live = entry?.pending && JSON.stringify(entry.pending) === frozen.body ? entry : undefined
				mutate(state, frozen, live)
				if (frozen.ack) {
					backend.putNote(SNAPSHOT_RECEIPTS, frozen.id, encodeFrozen(frozen))
					backend.deleteNote(FROZEN_SNAPSHOTS, frozen.id)
					unindexFrozen(backend, frozen.key, frozen.id)
				} else backend.putNote(FROZEN_SNAPSHOTS, frozen.id, encodeFrozen(frozen))
				assertCurrent()
			})
		},
		assertCurrent,
	)
}

export function acknowledgeFrozenSnapshot(
	agentDir: string,
	sent: FrozenSnapshot,
	ack: SnapshotAck,
	assertCurrent: () => void,
): Promise<ReportingState> {
	return updateFrozen(
		agentDir,
		sent,
		(state, frozen, live) => {
			validateAck(frozen.entry.revision, ack)
			frozen.ack = { status: ack.status, revision: ack.revision, receivedAt: ack.receivedAt }
			frozen.entry.attempts = 0
			frozen.entry.retryAt = 0
			frozen.entry.lastError = undefined
			if (live) applyAck(state, live, live.revision, ack)
			else if (
				ack.status !== "stale" &&
				frozen.entry.pending &&
				(frozen.entry.pending.requests.length || frozen.entry.pending.pullRequests.length) &&
				state.paused
			) {
				delete state.paused[accountKey(frozen.entry.account)]
				if (!Object.keys(state.paused).length) state.paused = undefined
			}
		},
		assertCurrent,
	)
}

export function deferFrozenSnapshot(
	agentDir: string,
	sent: FrozenSnapshot,
	retryAt: number,
	message: string,
	assertCurrent: () => void,
): Promise<ReportingState> {
	return updateFrozen(
		agentDir,
		sent,
		(_state, frozen, live) => {
			applyDefer(frozen.entry, retryAt, message)
			if (live) applyDefer(live, retryAt, message)
		},
		assertCurrent,
	)
}

/** A 413 trim stops halving here; a body this small is deferred like any other rejection. */
const TRIM_FLOOR_REQUESTS = 16
const TRIM_FLOOR_BYTES = 64 * 1024

/**
 * A body the server rejected for its size is replaced: the same claims, fewer requests, coverage
 * marked incomplete. Without a limit it is halved (the bare 413 an infrastructure layer returns);
 * with a server-stated byte cap it shrinks to the cap the server named, so the retry carries a
 * body the server can accept. The live queue entry keeps the trimmed body so the next capture does
 * not freeze the rejected one again. Resolves false when the body cannot shrink further, so the
 * caller defers or waits as before.
 */
export async function trimFrozenSnapshot(
	agentDir: string,
	sent: FrozenSnapshot,
	assertCurrent: () => void,
	limit?: ServerLimit,
): Promise<boolean> {
	let trimmed = false
	await update(
		agentDir,
		(state, check) => {
			if (!state.enabled) return
			const backend = backendFor(agentDir)
			backend.tx(() => {
				assertCurrent()
				check()
				const frozen = storedFrozen(agentDir, sent.id)
				if (frozen === undefined) throw new Error("Frozen PR snapshot disappeared")
				if (frozen.body !== sent.body || frozen.key !== sent.key) throw new Error("Frozen PR snapshot changed")
				if (frozen.ack) return
				refreshFrozenSchedule(agentDir, frozen)
				const current: WireSnapshot = JSON.parse(frozen.body)
				if (current.requests.length <= TRIM_FLOOR_REQUESTS) {
					// The body cannot shrink further; make the permanent rejection observable.
					diagnostic(agentDir, "frozen-413-floor")
					return
				}
				const { schemaVersion, producerId, revision, generatedAt, ...content } = current
				// A server-stated byte cap is the target; without one the body halves.
				const target =
					(limit ? learnedLimit(current, limit) : undefined) ?? Math.floor(Buffer.byteLength(frozen.body) / 2)
				const fitted = fitSnapshot(
					content,
					{
						// With a stated cap the bytes bind at the cap itself; halving keeps its own floor.
						requests:
							limit !== undefined
								? SNAPSHOT_LIMITS.requests
								: Math.max(TRIM_FLOOR_REQUESTS, Math.floor(current.requests.length / 2)),
						pullRequests: SNAPSHOT_LIMITS.pullRequests,
						bytes: limit !== undefined ? Math.max(1, target) : Math.max(TRIM_FLOOR_BYTES, target),
					},
					legacyUnpriced,
				)
				if (!fitted?.trimmed) {
					// The content cannot shrink further; make the permanent rejection observable.
					diagnostic(agentDir, "frozen-413-floor")
					return
				}
				fitted.content.coverage.trimmedRequests = (current.coverage.trimmedRequests ?? 0) + fitted.trimmed
				const next: WireSnapshot = { schemaVersion, producerId, revision, generatedAt, ...fitted.content }
				validateSnapshot(next)
				const body = JSON.stringify(next)
				const replacement: FrozenSnapshot = {
					version: 1,
					id: frozenId(frozen.entry.account, body),
					key: frozen.key,
					body,
					entry: { ...frozen.entry, attempts: 0, retryAt: 0, uploadedAt: undefined },
					resume: frozenResume(agentDir),
				}
				backend.putNote(FROZEN_SNAPSHOTS, replacement.id, encodeFrozen(replacement))
				backend.deleteNote(FROZEN_SNAPSHOTS, frozen.id)
				unindexFrozen(backend, frozen.key, frozen.id)
				indexFrozen(backend, agentDir, frozen.key, replacement.id, Buffer.byteLength(body), frozen.entry.held)
				// The live entry must not hold the rejected body: the next freeze would recreate its note.
				const live = state.entries[frozen.key]
				if (live?.pending && JSON.stringify(live.pending) === frozen.body) {
					live.pending = next
					live.attempts = 0
					live.retryAt = 0
					live.uploadedAt = undefined
				}
				trimmed = true
			})
		},
		assertCurrent,
	)
	return trimmed
}

export function limitFrozenSnapshot(
	agentDir: string,
	sent: FrozenSnapshot,
	limit: ServerLimit,
	retryAt: number,
	assertCurrent: () => void,
): Promise<ReportingState> {
	return updateFrozen(
		agentDir,
		sent,
		(state, frozen, live) => {
			applyLimit(state, frozen.entry, limit, retryAt)
			if (live) applyLimit(state, live, limit, retryAt)
		},
		assertCurrent,
	)
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
