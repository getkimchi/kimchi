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
	type SnapshotContent,
	validateSnapshot,
	validTime,
	type WireSnapshot,
} from "./snapshot.js"

export interface SnapshotAck {
	status: "accepted" | "unchanged" | "stale"
	revision: string
	receivedAt: string
}
/** Ordinary changes upload at most once in this window per repository. */
export const UPLOAD_INTERVAL_MS = 5 * 60_000
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
	error?: string
}
export function reportingDirectory(agentDir: string): string {
	return join(agentDir, "pr-cost-reporting")
}
const statePath = (agentDir: string) => join(reportingDirectory(agentDir), "state.json")
const requestHash = (requestId: string) => createHash("sha256").update(requestId).digest("hex")
function validEntryExtras(entry: PendingRepository): boolean {
	return (
		(entry.uploadedAt === undefined || Number.isFinite(entry.uploadedAt)) &&
		(entry.urgent === undefined || entry.urgent === true) &&
		(entry.markers === undefined ||
			(Array.isArray(entry.markers) &&
				entry.markers.every((marker) => typeof marker === "string" && marker.length <= 256)))
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
	try {
		const file = await open(statePath(agentDir), "r")
		let value: ReportingState
		try {
			if ((await file.stat()).size > 24 * 1024 * 1024)
				throw new Error("PR reporting state exceeds its local size limit")
			value = JSON.parse(await file.readFile("utf8"))
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
		if (value.followsTelemetry) value.enabled = readTelemetryConfig().enabled
		const machine = await machineFingerprint()
		// Two machines sharing a producer would keep replacing each other's claims; the server deduplicates bills across producers.
		if (machine && value.machine && value.machine !== machine) {
			value.producerId = randomUUID()
			value.machine = machine
			value.entries = {}
		}
		trackPRCostMetric({
			kind: "queueDepth",
			value: Object.values(value.entries).filter((entry) => entry.pending).length,
		})
		return value
	} catch (error) {
		if (object(error) && error.code === "ENOENT") {
			trackPRCostMetric({ kind: "queueDepth", value: 0 })
			return empty()
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
		const state = await readReportingState(agentDir)
		state.machine ??= await machineFingerprint()
		mutate(state)
		const body = `${JSON.stringify(state)}\n`
		if (Buffer.byteLength(body) > 24 * 1024 * 1024) throw new Error("PR reporting queue exceeds its local size limit")
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
					held++
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
			state.entries[key] = {
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
				attempts: entry?.attempts ?? 0,
				retryAt: entry?.retryAt ?? 0,
			}
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
