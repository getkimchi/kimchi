import {
	acknowledgeBatch as acknowledge,
	type Fact,
	type OutboxBatch,
	observeEvents as observe,
	pendingBatch as pending,
} from "@getkimchi/kimchi-bridge/work/outbox"
import type { Acknowledgement } from "@getkimchi/kimchi-bridge/work/protocol"
import { isWorkId } from "../../../shared/work-id.js"
import { object } from "../../work-attribution/summary.js"
import { backendFor, type RecordBackend } from "./records.js"

// The queue's rules (revisions, request claims, frozen batches, acknowledgements) live in the bridge
// package. This file binds them to the harness ledger and keeps what only the harness has: the
// delivery schedule and the status read.

export interface DeliveryRetry {
	/** The frozen batch this schedule delays; null while the account's events wait before any batch exists. */
	batchId: string | null
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
		(retry.batchId !== null && !isWorkId(retry.batchId)) ||
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
	observe(backend, accountKey, facts, assertCurrent, () => {
		for (const hash of recordHashes) backend.clearTranslation(hash)
	})
}

/** Freeze the HTTP body once; newer observations cannot replace it while its acknowledgement is pending. */
export function pendingBatch(agentDir: string, accountKey: string, assertCurrent: () => void): OutboxBatch | undefined {
	return pending(backendFor(agentDir), accountKey, assertCurrent)
}

/** Only a complete ACK of this account's persisted bytes can advance events and remove their batch. */
export function acknowledgeBatch(
	agentDir: string,
	accountKey: string,
	sent: OutboxBatch,
	acknowledgement: Acknowledgement,
	assertCurrent: () => void,
): boolean {
	return acknowledge(backendFor(agentDir), accountKey, sent, acknowledgement, assertCurrent)
}
