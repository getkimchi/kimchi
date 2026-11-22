import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { effectiveClaim } from "../../src/extensions/pr-cost-reporting/ledger/outbox.js"
import { backendFor, closeBackends, readRecords } from "../../src/extensions/pr-cost-reporting/ledger/records.js"
import {
	type Event,
	encodeEvent,
	eventHash,
	eventHashEncoded,
	eventKind,
	stableID,
	validateIngestEvent,
	type WorkAccount,
} from "../../src/extensions/pr-cost-reporting/protocol.js"
import { accountKey } from "../../src/extensions/pr-cost-reporting/snapshot.js"
import { reconcileWorkCosts } from "../../src/extensions/work-attribution/cost-sync.js"
import { isWorkAccount } from "../../src/extensions/work-attribution/scope.js"

const EVENTS_PER_REQUEST = 6

/** Produce the same request-linked history the producer would have captured. */
async function seedClaimHistory(agentDir: string, requests: ReturnType<typeof readRecords>): Promise<number> {
	const backend = backendFor(agentDir)
	const reporting = JSON.parse(readFileSync(join(agentDir, "pr-cost-reporting", "state.json"), "utf8")) as {
		producerId: string
		entries: Record<string, { account: WorkAccount }>
	}
	const producer = reporting.producerId
	const current = Object.values(reporting.entries)[0]?.account
	if (!producer || !isWorkAccount(current) || !requests.length) throw new Error("Incomplete warm-request fixture")
	const foreign: WorkAccount = {
		apiUrl: current.apiUrl,
		organizationId: requests[0].requestId,
		userId: requests[1]?.requestId ?? requests[0].requestId,
	}
	let written = 0
	for (const [index, request] of requests.entries()) {
		const account = request.scope?.account
		if (!isWorkAccount(account)) throw new Error("Request has no valid account scope")
		const key = accountKey(account)
		const requestId = request.requestId.toLowerCase()
		const entityId = stableID("kimchi", "request", key, producer, requestId)
		const recordKind = index === 9 ? foreign : account
		let previous: Event | undefined
		backend.tx(() => {
			for (let revision = 1; revision <= EVENTS_PER_REQUEST; revision++) {
				const start = new Date(
					Date.parse(request.startedAt ?? request.recordedAt) + (revision - 1) * 1000,
				).toISOString()
				const title = `linked-request-${index}-${revision}`
				const event: Event = {
					id: "",
					entityId,
					revision: String(revision),
					baseRevision: previous ? previous.revision : "0",
					baseEventId: previous?.id ?? "",
					source: "kimchi",
					sourceVersion: "fixture",
					deviceId: producer,
					observeTime: start,
					work: { title, reason: "observed", quality: "observed" },
				}
				event.id = stableID(key, entityId, eventHash(event))
				const body = encodeEvent(event)
				validateIngestEvent(event, body)
				if (!backend.getOutboxEvent(key, event.id)) {
					backend.insertOutboxEvent({
						id: event.id,
						accountKey: key,
						entityId,
						kind: eventKind(event),
						body: Buffer.from(body),
						hash: eventHashEncoded(body),
						createdAt: Date.parse(start),
						ackedAt: recordKind === account ? Date.parse(start) : null,
						blocked: "",
					})
					written++
				}
				previous = event
			}
		})
		if (index % 1000 === 0) {
			controller.signal.throwIfAborted()
			await setImmediate()
		}
	}
	return written
}

/** End-to-end proof that generated outbox entities are reachable from request identities. */
function verifyLinkedClaims(agentDir: string, requests: ReturnType<typeof readRecords>): number {
	const backend = backendFor(agentDir)
	if (requests.length < 3) throw new Error("Request history is missing link samples")
	let verified = 0
	for (const request of [requests[0], requests[Math.floor(requests.length / 2)], requests.at(-1)]) {
		const reporting = JSON.parse(readFileSync(join(agentDir, "pr-cost-reporting", "state.json"), "utf8")) as {
			producerId: string
			entries: Record<string, { account: WorkAccount }>
		}
		if (!request?.scope) throw new Error("Request identity is incomplete")
		const key = accountKey(request.scope.account)
		const entityId = stableID("kimchi", "request", key, reporting.producerId, request.requestId.toLowerCase())
		if (!effectiveClaim(backend, key, entityId)) throw new Error("Seeded outbox does not cover its request claim")
		verified++
	}
	return verified
}

const agentDir = process.argv[2]
if (!agentDir) throw new Error("warm-billing requires the fixture agent directory")
const controller = new AbortController()
const deadline = setTimeout(() => controller.abort(new Error("warm-billing deadline exceeded")), 240_000)
deadline.unref()
try {
	// Called only after Kimchi has exited, so this driver shares neither its
	// database-write path nor its outbox with a concurrently running application.
	const requests = readRecords(agentDir, { type: "request" })
	const written = await seedClaimHistory(agentDir, requests)
	const claimsVerified = verifyLinkedClaims(agentDir, requests)
	await reconcileWorkCosts(agentDir, controller.signal)
	console.log(
		JSON.stringify({ ok: true, requests: requests.length, events_written: written, claims_verified: claimsVerified }),
	)
} finally {
	clearTimeout(deadline)
	closeBackends()
}
