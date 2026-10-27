import { createHash, randomUUID } from "node:crypto"
import { isWorkId } from "../../../shared/work-id.js"
import { object } from "../../work-attribution/summary.js"
import {
	type Acknowledgement,
	type Batch,
	type Event,
	encodeBatch,
	encodeEvent,
	eventHash,
	eventKind,
	normalizeIngestTimes,
	stableID,
	timeNanos,
	Version,
	validateIngestBatch,
	validateIngestEvent,
} from "../protocol.js"
import { backendFor, type OutboxBatch, type OutboxEvent, type RecordBackend } from "./records.js"

const BATCH_EVENTS = 100
const BATCH_BYTES = 1 << 20
export type Fact = Omit<Event, "id" | "revision" | "baseRevision" | "baseHash">

export interface DeliveryRetry {
	batchId: string
	attempts: number
	retryAt: number
	resume?: string
	error?: string
}

export function deliveryRetry(
	backend: RecordBackend,
	accountKey: string,
	batchId: string | null,
): DeliveryRetry | undefined {
	const resume = backend.getNote("agent", "legacy-snapshot-resume")
	if (resume !== undefined && !isWorkId(resume)) throw new Error("Invalid PR reporting resume marker")
	const saved = backend.getNote("pr-cost-delivery", accountKey)
	if (saved === undefined) return undefined
	const retry: DeliveryRetry = JSON.parse(saved)
	if (
		!object(retry) ||
		!isWorkId(retry.batchId) ||
		!Number.isSafeInteger(retry.attempts) ||
		Number(retry.attempts) < 0 ||
		!Number.isSafeInteger(retry.retryAt) ||
		Number(retry.retryAt) < 0 ||
		(retry.resume !== undefined && !isWorkId(retry.resume)) ||
		(retry.error !== undefined && typeof retry.error !== "string")
	)
		throw new Error("Invalid PR cost delivery retry state")
	return retry.batchId === batchId && retry.resume === resume ? retry : undefined
}

/** A read never freezes a batch or advances delivery. */
export function readOutboxStatus(agentDir: string) {
	const backend = backendFor(agentDir)
	return backend.tx(() =>
		backend.outboxStatus().map((status) => ({
			...status,
			retry: deliveryRetry(backend, status.accountKey, status.firstBatchId),
		})),
	)
}

function isClaim(event: Event): boolean {
	return (
		event.source === "kimchi" &&
		event.usage?.counterScope === "request" &&
		Boolean(event.allocation || event.claimState || event.correction || event.startedAt)
	)
}

function projectClaim(raw: Event, previous?: Event): Event {
	const effective = { ...raw }
	if (isClaim(raw) && raw.startedAt === undefined) effective.startedAt = raw.observeTime
	if (raw.source === "kimchi" && previous?.source === "kimchi") {
		effective.allocation = raw.allocation ?? previous.allocation
		effective.claimState = raw.claimState || previous.claimState
		effective.correction = raw.correction ?? previous.correction
		effective.startedAt = raw.startedAt ?? previous.startedAt ?? effective.startedAt
	}
	return effective
}

function validateClaimUpdate(next: Event, previous?: Event): void {
	if (!isClaim(next) && (!previous || !isClaim(previous))) return
	if (next.source !== "kimchi" || next.usage?.counterScope !== "request")
		throw new Error("Claim source and request scope are immutable")
	if (previous) {
		if (!isClaim(previous)) throw new Error("Native request identity cannot become a claim")
		const repository = (value: Event["repository"]) => (value ? [value.provider, value.host, value.id] : null)
		if (
			next.usage.requestId?.toLowerCase() !== previous.usage?.requestId?.toLowerCase() ||
			next.deviceId !== previous.deviceId ||
			JSON.stringify(repository(next.repository)) !== JSON.stringify(repository(previous.repository))
		)
			throw new Error("Claim request identity, producer and repository are immutable")
		if (next.startedAt && timeNanos(next.startedAt) !== timeNanos(previous.startedAt ?? previous.observeTime))
			throw new Error("Claim start time is immutable")
		const candidate = next.correction ?? previous.correction
		const old = previous.correction
		if (candidate && old) {
			const same =
				candidate.id === old.id &&
				candidate.revision === old.revision &&
				timeNanos(candidate.recordedAt) === timeNanos(old.recordedAt) &&
				candidate.source === old.source
			if (same) {
				const allocation = (event: Event) =>
					event.allocation
						? [
								event.allocation.kind,
								event.allocation.pullRequestIds ?? [],
								event.allocation.method,
								repository(event.allocation.targetRepository ?? event.repository),
							]
						: null
				if (
					(next.allocation && JSON.stringify(allocation(next)) !== JSON.stringify(allocation(previous))) ||
					(next.claimState &&
						next.claimState !== previous.claimState &&
						!(previous.claimState === undefined && next.claimState === "active"))
				)
					throw new Error("Conflicting contents for one correction receipt")
			} else {
				const at = timeNanos(candidate.recordedAt)
				const before = timeNanos(old.recordedAt)
				if (
					(candidate.id === old.id && (candidate.revision <= old.revision || at < before)) ||
					(candidate.id !== old.id && at <= before)
				)
					throw new Error("Correction receipt is not newer")
			}
		}
	}
	if (next.correction && timeNanos(next.correction.recordedAt) > BigInt(Date.now()) * 1_000_000n)
		throw new Error("Correction receipt is in the future")
}

/** Rebuild only this entity's effective claim facts; raw bytes remain the CAS and upload authority. */
export function effectiveClaim(backend: RecordBackend, accountKey: string, entityId: string): Event | undefined {
	let effective: Event | undefined
	for (const row of backend.outboxEntityEvents(accountKey, entityId)) effective = projectClaim(unpack(row), effective)
	return effective
}

function unpack(row: OutboxEvent): Event {
	const body = Buffer.from(row.body)
	if (createHash("sha256").update(body).digest("hex") !== row.hash) throw new Error("Outbox event hash mismatch")
	const event: Event = JSON.parse(body.toString("utf8"))
	validateIngestEvent(event)
	if (event.id !== row.id || event.entityId !== row.entityId || eventKind(event) !== row.kind)
		throw new Error("Outbox event identity mismatch")
	if (encodeEvent(event) !== encodeEvent(normalizeIngestTimes(event)))
		throw new Error("Outbox event differs from protobuf transport")
	return event
}

function neutral(event: Event): Event {
	return { ...event, id: "", revision: "0", baseRevision: "0", baseHash: "", observeTime: "0001-01-01T00:00:00Z" }
}

/** Event CAS and its fulfilled capture intents commit together; unknown or failed translations do not call this. */
export function observeEvents(
	agentDir: string,
	accountKey: string,
	facts: readonly Fact[],
	recordHashes: readonly string[],
	assertCurrent: () => void,
): void {
	if (!accountKey || (recordHashes.length && !facts.length))
		throw new Error("Missing outbox account or translated events")
	const backend = backendFor(agentDir)
	backend.tx(() => {
		assertCurrent()
		for (const fact of facts) {
			const event = normalizeIngestTimes({ ...fact, id: "", revision: "1", baseRevision: "0", baseHash: "" })
			event.id = stableID(accountKey, event.entityId, eventHash(event))
			validateIngestEvent(event)
			const previous = backend.latestOutboxEvent(accountKey, event.entityId)
			let old: Event | undefined
			if (previous) {
				old = unpack(previous)
				if (eventKind(old) !== eventKind(event)) throw new Error("Outbox entity kind is immutable")
			}
			const raw: Event = JSON.parse(encodeEvent(event))
			validateClaimUpdate(
				raw,
				old && (old.source === "kimchi" || raw.source === "kimchi")
					? effectiveClaim(backend, accountKey, event.entityId)
					: old,
			)
			if (previous && old) {
				if (eventHash(neutral(old)) === eventHash(neutral(event))) continue
				event.revision = (BigInt(old.revision) + 1n).toString()
				event.baseRevision = old.revision
				event.baseHash = previous.hash
			}
			event.id = ""
			event.id = stableID(accountKey, event.entityId, eventHash(event))
			validateIngestEvent(event)
			const body = Buffer.from(encodeEvent(event))
			backend.insertOutboxEvent({
				id: event.id,
				accountKey,
				entityId: event.entityId,
				kind: eventKind(event),
				body,
				hash: eventHash(event),
				createdAt: Date.now(),
				ackedAt: null,
				blocked: "",
			})
		}
		for (const hash of recordHashes) backend.clearTranslation(hash)
		assertCurrent()
	})
}

function unpackBatch(row: OutboxBatch, backend: RecordBackend): { batch: Batch; events: OutboxEvent[] } {
	const body = Buffer.from(row.body)
	const batch: Batch = JSON.parse(body.toString("utf8")).batch
	validateIngestBatch(batch)
	if (
		batch.id !== row.id ||
		!Array.isArray(row.eventIds) ||
		row.eventIds.length !== batch.events.length ||
		batch.events.some((event, index) => event.id !== row.eventIds[index])
	)
		throw new Error("Outbox batch identity mismatch")
	const events = batch.events.map((event) => {
		const stored = backend.getOutboxEvent(row.accountKey, event.id)
		if (!stored) throw new Error("Outbox batch event mismatch")
		return stored
	})
	for (const stored of events) unpack(stored)
	const expected = wireBody(
		row.id,
		events.map((stored) => stored.body),
	)
	if (!body.equals(expected)) throw new Error("Outbox batch identity mismatch")
	return { batch, events }
}

/** Splice stored event bodies verbatim so fields from newer builds survive delivery. */
function wireBody(id: string, bodies: readonly Uint8Array[]): Buffer {
	const head = encodeBatch({ version: Version, id, events: [] }).slice(0, -2)
	const events = bodies.map((bytes) => Buffer.from(bytes).toString("utf8")).join(",")
	return Buffer.from(`{"batch":${head}${events}]}}`)
}

/** Freeze the HTTP body once; newer observations cannot replace it while its acknowledgement is pending. */
export function pendingBatch(agentDir: string, accountKey: string, assertCurrent: () => void): OutboxBatch | undefined {
	if (!accountKey) throw new Error("Missing outbox account")
	const backend = backendFor(agentDir)
	return backend.tx(() => {
		assertCurrent()
		const existing = backend.getOutboxBatch(accountKey)
		if (existing) {
			unpackBatch(existing, backend)
			return existing
		}
		const batch: Batch = { version: Version, id: randomUUID(), events: [] }
		const bodies: Uint8Array[] = []
		for (const row of backend.pendingOutboxEvents(accountKey, BATCH_EVENTS)) {
			batch.events.push(unpack(row))
			bodies.push(row.body)
			if (wireBody(batch.id, bodies).length > BATCH_BYTES) {
				batch.events.pop()
				bodies.pop()
				break
			}
		}
		if (!batch.events.length) return undefined
		validateIngestBatch(batch)
		const frozen: OutboxBatch = {
			id: batch.id,
			accountKey,
			body: wireBody(batch.id, bodies),
			eventIds: batch.events.map((event) => event.id),
			createdAt: Date.now(),
			orderKey: "",
		}
		backend.insertOutboxBatch(frozen)
		assertCurrent()
		return frozen
	})
}

/** Only a complete ACK of this account's persisted bytes can advance events and remove their batch. */
export function acknowledgeBatch(
	agentDir: string,
	accountKey: string,
	sent: OutboxBatch,
	acknowledgement: Acknowledgement,
	assertCurrent: () => void,
): boolean {
	if (sent.accountKey !== accountKey) throw new Error("Outbox account changed")
	const backend = backendFor(agentDir)
	return backend.tx(() => {
		assertCurrent()
		const current = backend.getOutboxBatch(accountKey)
		if (!current || current.id !== sent.id) return false
		if (!Buffer.from(current.body).equals(Buffer.from(sent.body))) throw new Error("Outbox batch changed")
		const { batch, events } = unpackBatch(current, backend)
		if (
			acknowledgement.batchId !== batch.id ||
			!Array.isArray(acknowledgement.receipts) ||
			acknowledgement.receipts.length !== batch.events.length
		)
			throw new Error("Incomplete batch acknowledgement")
		const expected = new Map(batch.events.map((event) => [event.id, event.revision]))
		for (const receipt of acknowledgement.receipts) {
			if (
				!expected.has(receipt.id) ||
				expected.get(receipt.id) !== receipt.revision ||
				!["accepted", "unchanged"].includes(receipt.status)
			)
				throw new Error("Invalid event acknowledgement")
			expected.delete(receipt.id)
		}
		if (expected.size) throw new Error("Missing event acknowledgement")
		const at = Date.now()
		for (const stored of events)
			if (!backend.ackOutboxEvent(accountKey, stored.id, stored.hash, at)) throw new Error("Outbox event changed")
		if (!backend.deleteOutboxBatch(accountKey, batch.id)) throw new Error("Outbox batch changed")
		assertCurrent()
		return true
	})
}
