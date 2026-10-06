import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { lock } from "proper-lockfile"
import { readTelemetryConfig } from "../../config.js"
import { isWorkId } from "../../shared/work-id.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"
import { isWorkAccount, type WorkAccount } from "../work-attribution/scope.js"
import {
	accountKey,
	MAX_REVISION,
	type ReportingRepository,
	type RepositorySnapshot,
	repositoryKey,
	revision,
	validateSnapshot,
	validTime,
	type WireSnapshot,
} from "./snapshot.js"

export interface SnapshotAck {
	status: "accepted" | "unchanged" | "stale"
	revision: string
	receivedAt: string
}
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
}
export interface ReportingState {
	version: 1
	enabled: boolean
	/** New queues follow SaaS uploads until an explicit /pr-reporting choice is saved. */
	followsTelemetry?: true
	defaultNoticeShown?: true
	producerId: string
	entries: Record<string, PendingRepository>
	error?: string
}
export function reportingDirectory(agentDir: string): string {
	return join(agentDir, "pr-cost-reporting")
}
const statePath = (agentDir: string) => join(reportingDirectory(agentDir), "state.json")
const requestHash = (requestId: string) => createHash("sha256").update(requestId).digest("hex")
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
				entry.requestHashes.some((hash) => typeof hash !== "string" || !/^[a-f\d]{64}$/.test(hash)) ||
				key !== `${accountKey(entry.account)}:${repositoryKey(entry.repository)}`
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
		trackPRCostMetric({
			kind: "queueDepth",
			value: Object.values(value.entries).filter((entry) => entry.pending).length,
		})
		return value
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
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
	const temp = join(directory, `${randomUUID()}.tmp`)
	try {
		const state = await readReportingState(agentDir)
		mutate(state)
		const body = `${JSON.stringify(state)}\n`
		if (Buffer.byteLength(body) > 24 * 1024 * 1024) throw new Error("PR reporting queue exceeds its local size limit")
		const file = await open(temp, "wx", 0o600)
		try {
			await file.writeFile(body)
			await file.sync()
		} finally {
			await file.close()
		}
		if (compromised) throw compromised
		await rename(temp, statePath(agentDir))
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
		await rm(temp, { force: true })
		if (!compromised) await release()
	}
}

export function setReportingEnabled(agentDir: string, enabled: boolean): Promise<ReportingState> {
	return update(agentDir, (state) => {
		state.enabled = enabled
		state.followsTelemetry = undefined
		state.error = undefined
		if (!enabled)
			for (const entry of Object.values(state.entries)) {
				// The discarded replacement may have arrived even if its acknowledgement did not.
				if (entry.pending) entry.acceptedDigest = undefined
				entry.pending = undefined
				entry.pendingDigest = undefined
				entry.lastError = undefined
				entry.held = undefined
				entry.attempts = 0
				entry.retryAt = 0
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

/** Replaces a repository's entire inventory. The fsynced rename completes before delivery can begin. */
export function queueSnapshots(
	agentDir: string,
	snapshots: RepositorySnapshot[],
	completeInventory = false,
): Promise<ReportingState> {
	return update(agentDir, (state) => {
		if (!state.enabled) return
		const invalid = new Set<string>()
		const current = new Map<string, RepositorySnapshot>()
		for (const snapshot of snapshots) {
			const key = `${accountKey(snapshot.account)}:${repositoryKey(snapshot.content.repository)}`
			try {
				if (!isWorkAccount(snapshot.account)) throw new Error("Missing account")
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
			for (const request of snapshot.content.requests) members.add(requestHash(request.requestId))
			reported.set(key, members)
		}
		let held = 0
		for (const [key, entry] of Object.entries(state.entries))
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
				} else {
					entry.held = true
					held++
				}
			}
		for (const [key, snapshot] of current) {
			const digest = createHash("sha256").update(JSON.stringify(snapshot.content)).digest("hex")
			let entry = state.entries[key]
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
			const next = BigInt(entry?.revision ?? "0") + 1n
			if (next > MAX_REVISION) throw new Error("PR reporting revision limit reached")
			const pending: WireSnapshot = {
				schemaVersion: 1,
				producerId: state.producerId,
				revision: String(next),
				generatedAt: new Date().toISOString(),
				...snapshot.content,
			}
			validateSnapshot(pending)
			entry = {
				account: snapshot.account,
				repository: snapshot.content.repository,
				revision: String(next),
				requestHashes: [
					...new Set([
						...(entry?.requestHashes ?? []),
						...snapshot.content.requests.map((request) => requestHash(request.requestId)),
					]),
				].sort(),
				...(entry?.acceptedDigest ? { acceptedDigest: entry.acceptedDigest } : {}),
				pendingDigest: digest,
				pending,
				attempts: entry?.attempts ?? 0,
				retryAt: entry?.retryAt ?? 0,
				...(entry?.lastError ? { lastError: entry.lastError } : {}),
				...(entry?.lastAcknowledgedAt ? { lastAcknowledgedAt: entry.lastAcknowledgedAt } : {}),
			}
			state.entries[key] = entry
		}
		state.error =
			[
				...(held ? [`PR reporting held ${held} repository snapshot(s) because earlier evidence is missing`] : []),
				...(invalid.size
					? [`PR reporting held ${invalid.size} invalid snapshot(s) or snapshots exceeding upload limits`]
					: []),
			].join(". ") || undefined
	})
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
		} else entry.acceptedDigest = undefined
		entry.revision = ack.revision
		entry.pending = undefined
		entry.pendingDigest = undefined
		entry.lastError = undefined
		entry.attempts = 0
		entry.retryAt = 0
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
	})
}
