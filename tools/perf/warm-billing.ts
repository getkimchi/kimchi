import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"

import { buildEvents } from "../../src/extensions/pr-cost-reporting/events.ts"
import {
	acknowledgeBatch,
	effectiveClaim,
	effectiveClaims,
	type Fact,
	observeEvents,
	pendingBatch,
	readOutboxStatus,
} from "../../src/extensions/pr-cost-reporting/ledger/outbox.ts"
import {
	backendFor,
	capture,
	closeBackends,
	readRecords,
	readStoredRecordsAsync,
	type StoredRecord,
} from "../../src/extensions/pr-cost-reporting/ledger/records.ts"
import {
	type Batch,
	encodeEvent,
	eventHash,
	normalizeIngestTimes,
	stableID,
	validateIngestEvent,
} from "../../src/extensions/pr-cost-reporting/protocol.ts"
import { accountKey, type RepositoryIdentity } from "../../src/extensions/pr-cost-reporting/snapshot.ts"
import { readWorkCostReportAsync, reconcileWorkCosts } from "../../src/extensions/work-attribution/cost-sync.ts"
import { isWorkScope, type WorkAccount } from "../../src/extensions/work-attribution/scope.ts"
import type { WorkRecord } from "../../src/extensions/work-attribution/summary.ts"

const LEGACY_API = "https://app.kimchi.dev/api"

function recordExpectations(
	account: Parameters<typeof accountKey>[0],
	facts: readonly Fact[],
	expected: Map<string, Set<string>>,
): void {
	const key = accountKey(account)
	const ids = expected.get(key) ?? new Set<string>()
	for (const fact of facts) {
		const event = normalizeIngestTimes({ ...fact, id: "", revision: "1", baseRevision: "0", baseEventId: "" })
		event.id = stableID(key, event.entityId, eventHash(event))
		validateIngestEvent(event, encodeEvent(event))
		ids.add(event.id)
	}
	expected.set(key, ids)
}

type ExpectedHistory = Map<string, Set<string>>

function repositoriesFor(records: readonly WorkRecord[]): Map<string, RepositoryIdentity> {
	const repositories = [...new Set(records.flatMap((row) => (isWorkScope(row.scope) ? [row.scope.repository] : [])))]
	return new Map(
		repositories.map((repository, index) => [
			repository,
			{
				provider: "github",
				host: "fixture.invalid",
				id: String(index),
				name: "fixture",
			},
		]),
	)
}

/** Translate authority records with the real claim builder and observe its facts through CAS. */
async function seedClaimHistory(agentDir: string, controller: AbortController): Promise<number> {
	const reporting = JSON.parse(readFileSync(join(agentDir, "pr-cost-reporting", "state.json"), "utf8")) as {
		producerId: string
	}
	const expected = Number(process.env.KIMCHI_PERF_EXPECTED_REQUEST_COUNT)
	if (!Number.isSafeInteger(expected) || expected < 3) throw new Error("Missing valid expected request count")
	const requests = readRecords(agentDir, { type: "request" })
	if (requests.length !== expected) throw new Error(`Expected ${expected} requests, found ${requests.length}`)
	const all = await readStoredRecordsAsync(agentDir, () => controller.signal.throwIfAborted())
	const works = new Map<string, StoredRecord[]>()
	for (const row of all) {
		const group = works.get(row.workId) ?? []
		group.push(row)
		works.set(row.workId, group)
	}
	let translated = 0
	const history: ExpectedHistory = new Map()
	const producedRequests = new Set<string>()
	for (const [index, rows] of [...works.values()].entries()) {
		if (process.argv[3] === "--partial-history" && index > 0) break
		controller.signal.throwIfAborted()
		const records = rows.map((row) => JSON.parse(row.body) as WorkRecord)
		const { report } = await readWorkCostReportAsync(records, async () => {})
		const built = await buildEvents(
			rows,
			report,
			repositoriesFor(records),
			reporting.producerId,
			() => controller.signal.throwIfAborted(),
			async (account, entities) => effectiveClaims(backendFor(agentDir), account, entities),
		)
		if (built.unresolved.length) {
			throw new Error(
				`Unresolvable warm evidence: ${[...new Set(built.unresolved.map((row) => row.reason))].join(",")}`,
			)
		}
		for (const unit of built.units) if (unit.requestId !== undefined) producedRequests.add(unit.requestId)
		for (const group of built.accounts) {
			recordExpectations(group.account, group.facts, history)
			observeEvents(agentDir, accountKey(group.account), group.facts, group.recordHashes, () =>
				controller.signal.throwIfAborted(),
			)
			translated += group.facts.length
		}
		if (index % 100 === 0) await setImmediate()
	}
	if (producedRequests.size !== expected)
		throw new Error(`Expected ${expected} translated requests, found ${producedRequests.size}`)
	return { history, translated }
}

function identity(request: WorkRecord | undefined, producerId: string) {
	if (
		!request ||
		typeof request.requestId !== "string" ||
		typeof request.workId !== "string" ||
		typeof request.sessionId !== "string" ||
		typeof request.startedAt !== "string" ||
		!isWorkScope(request.scope)
	)
		throw new Error("Incomplete request identity for claim verification")
	const key = accountKey(request.scope.account)
	return {
		key,
		requestId: request.requestId,
		workId: request.workId,
		sessionId: request.sessionId,
		startedAt: request.startedAt,
		scope: request.scope,
		entity: stableID("kimchi", "request", key, producerId, request.requestId.toLowerCase()),
	}
}

/** A real subsequent response must advance, not fork or invalidate, the request claim chain. */
async function verifyNextRevision(agentDir: string, controller: AbortController): Promise<{ key: string; id: string }> {
	const reporting = JSON.parse(readFileSync(join(agentDir, "pr-cost-reporting", "state.json"), "utf8")) as {
		producerId: string
	}
	const id = identity(readRecords(agentDir, { type: "request" })[0], reporting.producerId)
	capture(
		agentDir,
		{
			version: 1,
			type: "request_response",
			requestId: id.requestId,
			workId: id.workId,
			sessionId: id.sessionId,
			scope: id.scope,
			recordedAt: new Date(Date.parse(id.startedAt) + 15_000).toISOString(),
			nativeUsage: {
				harness: "kimchi",
				sourceVersion: "fixture",
				api: "openai-completions",
				schema: "openai-chat-completions-v1",
				provider: "fake",
				reportedModel: "basic",
				actualModel: "basic",
				responseId: id.requestId,
				dispatchObserved: true,
				finalized: true,
				raw: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
			},
		},
		join(agentDir, "native-next-request.jsonl"),
	)
	const stored = (await readStoredRecordsAsync(agentDir, () => {})).filter((row) => row.workId === id.workId)
	const records = stored.map((row) => JSON.parse(row.body) as WorkRecord)
	const { report } = await readWorkCostReportAsync(records, async () => {})
	const built = await buildEvents(
		stored,
		report,
		repositoriesFor(records),
		reporting.producerId,
		() => controller.signal.throwIfAborted(),
		async (account, entities) => effectiveClaims(backendFor(agentDir), account, entities),
	)
	for (const group of built.accounts)
		observeEvents(agentDir, accountKey(group.account), group.facts, group.recordHashes, () =>
			controller.signal.throwIfAborted(),
		)
	const next = effectiveClaim(backendFor(agentDir), id.key, id.entity)
	if (next?.usage?.counterScope !== "request" || next.revision !== "2")
		throw new Error("Next real request did not advance its claim to revision 2")
	return { key: id.key, id: next.id }
}

function verifyLinkedClaims(agentDir: string): number {
	const reporting = JSON.parse(readFileSync(join(agentDir, "pr-cost-reporting", "state.json"), "utf8")) as {
		producerId: string
	}
	const requests = readRecords(agentDir, { type: "request" })
	if (requests.length < 3) throw new Error("Request history is missing link samples")
	for (const request of [requests[0], requests[Math.floor(requests.length / 2)], requests.at(-1)]) {
		const id = identity(request, reporting.producerId)
		const claim = effectiveClaim(backendFor(agentDir), id.key, id.entity)
		if (claim?.usage?.counterScope !== "request" || claim.usage.requestId?.toLowerCase() !== id.requestId.toLowerCase())
			throw new Error("Seeded outbox does not cover its request usage claim")
	}
	return 3
}

function isCurrentAccount(fields: readonly unknown[], endpoint: string, account: WorkAccount): boolean {
	return fields[0] === endpoint && fields[1] === account.organizationId && fields[2] === account.userId
}

/** Drain current history while retaining legacy and foreign pending history. */
async function acknowledgeCurrentHistory(agentDir: string, controller: AbortController, history: ExpectedHistory) {
	const endpoint = process.env.KIMCHI_REMOTE_ENDPOINT
	if (!endpoint) throw new Error("Missing fixture API endpoint")
	const current = readRecords(agentDir, { type: "request" }).find(
		(request) => isWorkScope(request.scope) && request.scope.account.apiUrl === endpoint,
	)
	if (!current?.scope || !isWorkScope(current.scope)) throw new Error("Missing current fixture account")
	const currentAccount = current.scope.account
	const seenLegacy = new Set<string>()
	const expectedByAccount = new Map<string, { events: number; pending: number; acknowledged: number }>()
	for (const [rawKey, ids] of history) {
		const fields: unknown = JSON.parse(rawKey)
		if (!Array.isArray(fields) || fields.length !== 3 || typeof fields[0] !== "string")
			throw new Error("Invalid stored account key")
		const expectedAcknowledged =
			fields[0] === LEGACY_API
				? Math.min(100, ids.size)
				: isCurrentAccount(fields, endpoint, currentAccount)
					? ids.size
					: 0
		expectedByAccount.set(rawKey, {
			events: ids.size,
			acknowledged: expectedAcknowledged,
			pending: ids.size - expectedAcknowledged,
		})
	}
	let batches = 0
	for (const status of readOutboxStatus(agentDir)) {
		const fields: unknown = JSON.parse(status.accountKey)
		if (!Array.isArray(fields) || fields.length !== 3 || typeof fields[0] !== "string")
			throw new Error("Invalid stored account key")
		const rawKey = status.accountKey
		const isLegacy = fields[0] === LEGACY_API
		const isCurrent = isCurrentAccount(fields, endpoint, currentAccount)
		if (isLegacy ? seenLegacy.has(rawKey) : !isCurrent) continue
		const ids = history.get(rawKey)
		if (!ids) throw new Error("Stored account is absent from the expected history")
		if (isLegacy) seenLegacy.add(rawKey)
		let remaining = isLegacy ? 1 : Number.MAX_SAFE_INTEGER
		while (remaining > 0) {
			const frozen = pendingBatch(agentDir, rawKey, () => controller.signal.throwIfAborted())
			if (!frozen) break
			const batch = JSON.parse(Buffer.from(frozen.body).toString()).batch as Batch
			const acknowledgement = {
				batchId: batch.id,
				receipts: batch.events.map((event) => ({
					id: event.id,
					revision: event.revision,
					status: "accepted" as const,
				})),
			}
			if (!acknowledgeBatch(agentDir, rawKey, frozen, acknowledgement, () => controller.signal.throwIfAborted()))
				throw new Error("Frozen acknowledgement did not make progress")
			batches++
			remaining--
			if (batches % 20 === 0) await setImmediate()
		}
	}
	const actual = new Map(readOutboxStatus(agentDir).map((status) => [status.accountKey, status]))
	if (actual.size !== expectedByAccount.size) throw new Error("Unexpected number of reporting accounts")
	for (const [key, expected] of expectedByAccount) {
		const status = actual.get(key)
		if (status?.pending !== expected.pending || status.acknowledged !== expected.acknowledged)
			throw new Error(
				`Account acknowledgement shape mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(status)}`,
			)
	}
	return { batches, expectedByAccount }
}

const agentDir = process.argv[2]
if (!agentDir) throw new Error("warm-billing requires the fixture agent directory")
if (process.argv[3] === "--verify-claims") {
	try {
		console.log(JSON.stringify({ ok: true, claims_verified: verifyLinkedClaims(agentDir) }))
	} finally {
		closeBackends()
	}
	process.exit(0)
}
const controller = new AbortController()
const deadline = setTimeout(() => controller.abort(new Error("warm-billing deadline exceeded")), 900_000)
try {
	// The application has exited. This driver is the only database/outbox owner.
	const initial = readOutboxStatus(agentDir).map((status) => ({
		pending: status.pending,
		acknowledged: status.acknowledged,
		batches: status.batches,
	}))
	const { history, translated } = await seedClaimHistory(agentDir, controller)
	const claimsVerified = verifyLinkedClaims(agentDir)
	const next = await verifyNextRevision(agentDir, controller)
	const ids = history.get(next.key)
	if (!ids) throw new Error("Next request account is absent from the expected history")
	ids.add(next.id)
	const before = readOutboxStatus(agentDir).map((status) => status.pending)
	const acknowledgements = await acknowledgeCurrentHistory(agentDir, controller, history)
	await reconcileWorkCosts(agentDir, controller.signal)
	writeFileSync(
		join(agentDir, "warm-summary.json"),
		JSON.stringify({
			fixture_generation: process.env.KIMCHI_PERF_FIXTURE_GENERATION,
			expected_requests: Number(process.env.KIMCHI_PERF_EXPECTED_REQUEST_COUNT),
			requests: readRecords(agentDir, { type: "request" }).length,
			outbox_events: [...acknowledgements.expectedByAccount.values()].reduce(
				(total, account) => total + account.events,
				0,
			),
			outbox_pending: [...acknowledgements.expectedByAccount.values()].reduce(
				(total, account) => total + account.pending,
				0,
			),
			outbox_accounts: acknowledgements.expectedByAccount.size,
			expected_by_account: Object.fromEntries(acknowledgements.expectedByAccount),
		}),
	)
	console.log(
		JSON.stringify({
			ok: true,
			requests: readRecords(agentDir, { type: "request" }).length,
			events_written: translated,
			claims_verified: claimsVerified,
			accounts: readOutboxStatus(agentDir).map((status) => ({
				pending: status.pending,
				acknowledged: status.acknowledged,
			})),
			initial,
			before,
			acknowledgements,
		}),
	)
} finally {
	clearTimeout(deadline)
	closeBackends()
}
