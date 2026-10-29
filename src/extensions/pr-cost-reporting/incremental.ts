import { createHash } from "node:crypto"
import type { PullRequestCostReport, RequestCostAllocation } from "../work-attribution/costs.js"
import { isWorkScope } from "../work-attribution/scope.js"
import type { WorkRecord } from "../work-attribution/summary.js"
import type { CommonEvents, EventUnit } from "./events.js"
import type { Fact } from "./ledger/outbox.js"
import type { RecordBackend, StoredRecord } from "./ledger/records.js"
import { accountKey, type RepositoryIdentity } from "./snapshot.js"

const PREFIX = "capture-incremental-v1:"
const MAX_CONTEXT_ROWS = 512
const MAX_CONTEXT_BYTES = 256 * 1024
const MAX_CHANGED_ROWS = 128

type Shared = {
	account: string
	entityId: string
	fact: Fact
	writer: string
	first: string
	order: number
	headId: string | null
	headHash: string | null
}
export interface GroupCache {
	version: 1
	group: string
	producer: string
	through: number
	context: StoredRecord[]
	scopes: [string, string][]
	repositories: [string, RepositoryIdentity][]
	shared: Shared[]
}

const digest = (body: string) => createHash("sha256").update(body).digest("hex")
export const groupKey = (works: readonly string[]) => `${PREFIX}group:${digest(JSON.stringify(works))}`
const requestKey = (requestId: string) => `${PREFIX}request:${requestId}`
const segmentKey = (segmentId: string) => `${PREFIX}segment:${segmentId}`
const billKey = (billId: string) => `${PREFIX}bill:${billId}`

function indexes(rows: readonly WorkRecord[]) {
	const requests = new Map<string, { workId: string; hashes: string[]; result?: RequestCostAllocation }>()
	const segments = new Map<string, string>()
	const bills = new Map<string, string>()
	for (const row of rows) {
		if (typeof row.requestId !== "string") continue
		if (
			row.type === "request" &&
			row.segment &&
			typeof row.segment === "object" &&
			"id" in row.segment &&
			typeof row.segment.id === "string"
		)
			segments.set(row.segment.id, row.workId)
		if (row.type === "request_cost" && Array.isArray(row.billingRows))
			for (const bill of row.billingRows)
				if (bill && typeof bill === "object" && "id" in bill && typeof bill.id === "string")
					bills.set(bill.id, row.workId)
		requests.set(row.requestId, requests.get(row.requestId) ?? { workId: row.workId, hashes: [] })
	}
	return { requests, segments, bills }
}

/** Derived indexes are written before the group note; without that note none of them can authorize a fast path. */
export function requestIndexEntries(
	stored: readonly StoredRecord[],
	rows: readonly WorkRecord[],
	report: PullRequestCostReport,
): { owner: string; name: string; body: string }[] {
	const { requests, segments, bills } = indexes(rows)
	for (let i = 0; i < rows.length; i++) {
		const requestId = rows[i].requestId
		if (typeof requestId === "string") requests.get(requestId)?.hashes.push(stored[i].recordHash)
	}
	for (const result of report.requests) {
		const entry = requests.get(result.requestId)
		if (entry) entry.result = result
	}
	return [
		...[...requests].map(([requestId, entry]) => ({
			owner: entry.workId,
			name: requestKey(requestId),
			body: JSON.stringify(entry),
		})),
		...[...segments].map(([id, owner]) => ({ owner, name: segmentKey(id), body: "1" })),
		...[...bills].map(([id, owner]) => ({ owner, name: billKey(id), body: "1" })),
	]
}

/** A cache is eligible only when every request produced a validated unit and all shared contributors were seen. */
export function prepareGroupCache(
	backend: RecordBackend,
	works: readonly string[],
	producer: string,
	through: number,
	stored: readonly StoredRecord[],
	rows: readonly WorkRecord[],
	report: PullRequestCostReport,
	repositories: Map<string, RepositoryIdentity>,
	built: CommonEvents,
): GroupCache | undefined {
	if (
		built.unresolved.length ||
		built.units.filter((unit) => unit.requestId !== undefined).length !== report.requests.length
	)
		return undefined
	const context = stored.filter((row) =>
		["commit", "work_link", "file_transition", "file_observation"].includes(row.type),
	)
	if (context.length > MAX_CONTEXT_ROWS || Buffer.byteLength(JSON.stringify(context)) > MAX_CONTEXT_BYTES)
		return undefined
	const scopes = new Map<string, string>()
	for (const row of rows) {
		if (row.type !== "request" || !isWorkScope(row.scope)) continue
		const scope = JSON.stringify(row.scope)
		if (scopes.has(row.workId) && scopes.get(row.workId) !== scope) return undefined
		scopes.set(row.workId, scope)
	}
	const facts = new Map<string, Fact>()
	for (const account of built.accounts)
		for (const fact of account.facts) facts.set(`${accountKey(account.account)}\0${fact.entityId}`, fact)
	const writers = new Map<string, { last: string; first: string; order: number }>()
	for (const unit of built.units) {
		if (unit.requestId === undefined) continue
		for (const [order, entityId] of unit.entities.slice(1).entries()) {
			const identity = `${unit.account}\0${entityId}`
			const prior = writers.get(identity)
			writers.set(identity, {
				last: unit.requestId,
				first: prior?.first ?? unit.requestId,
				order: prior?.order ?? order,
			})
		}
	}
	const shared: Shared[] = []
	for (const [identity, writer] of writers) {
		const fact = facts.get(identity)
		if (!fact) return undefined
		const account = identity.slice(0, identity.indexOf("\0"))
		const head = backend.latestOutboxEvent(account, fact.entityId)
		shared.push({
			account,
			entityId: fact.entityId,
			fact,
			writer: writer.last,
			first: writer.first,
			order: writer.order,
			headId: head?.id ?? null,
			headHash: head?.hash ?? null,
		})
	}
	if (Buffer.byteLength(JSON.stringify(shared)) > MAX_CONTEXT_BYTES) return undefined
	return {
		version: 1,
		group: groupKey(works),
		producer,
		through,
		context,
		scopes: [...scopes],
		repositories: [...repositories],
		shared,
	}
}

export function saveGroupCache(backend: RecordBackend, cache: GroupCache): void {
	const body = JSON.stringify(cache)
	backend.putNote("agent", cache.group, JSON.stringify({ digest: digest(body), body }))
}

export function sameCachedRepositories(cache: GroupCache, current: Map<string, RepositoryIdentity>): boolean {
	const previous = new Map(cache.repositories)
	return [...current].every(([path, identity]) => JSON.stringify(previous.get(path)) === JSON.stringify(identity))
}

export function verifySharedHeads(backend: RecordBackend, cache: GroupCache): boolean {
	return cache.shared.every((entry) => {
		const head = backend.latestOutboxEvent(entry.account, entry.entityId)
		return (head?.id ?? null) === entry.headId && (head?.hash ?? null) === entry.headHash
	})
}

/** Extend the complete shared projection only after all new units were built and their facts merged. */
export function advanceGroupCache(
	backend: RecordBackend,
	cache: GroupCache,
	through: number,
	rows: readonly WorkRecord[],
	report: PullRequestCostReport,
	repositories: Map<string, RepositoryIdentity>,
	built: CommonEvents,
): GroupCache | undefined {
	if (
		built.unresolved.length ||
		built.units.filter((unit) => unit.requestId !== undefined).length !== report.requests.length
	)
		return undefined
	if (!sameCachedRepositories(cache, repositories)) return undefined
	const scopes = new Map(cache.scopes)
	for (const row of rows) {
		if (row.type !== "request" || !isWorkScope(row.scope)) continue
		if (scopes.get(row.workId) !== JSON.stringify(row.scope)) return undefined
	}
	const facts = new Map<string, Fact>()
	for (const account of built.accounts)
		for (const fact of account.facts) facts.set(`${accountKey(account.account)}\0${fact.entityId}`, fact)
	const shared = new Map(cache.shared.map((entry) => [`${entry.account}\0${entry.entityId}`, entry]))
	for (const unit of built.units) {
		if (!unit.requestId) continue
		for (const [order, entityId] of unit.entities.slice(1).entries()) {
			const identity = `${unit.account}\0${entityId}`
			const fact = facts.get(identity)
			if (!fact) return undefined
			const prior = shared.get(identity)
			const earlier = prior && prior.first <= unit.requestId
			shared.set(identity, {
				account: unit.account,
				entityId,
				fact,
				writer: prior && prior.writer > unit.requestId ? prior.writer : unit.requestId,
				first: earlier ? prior.first : unit.requestId,
				order: earlier ? prior.order : order,
				headId: null,
				headHash: null,
			})
		}
	}
	if (Buffer.byteLength(JSON.stringify([...shared.values()])) > MAX_CONTEXT_BYTES) return undefined
	return {
		...cache,
		through,
		repositories: [...new Map([...cache.repositories, ...repositories])],
		shared: [...shared.values()].map((entry) => {
			const head = backend.latestOutboxEvent(entry.account, entry.entityId)
			return { ...entry, headId: head?.id ?? null, headHash: head?.hash ?? null }
		}),
	}
}

/** Returns only rows committed after the cached watermark, never a partial group snapshot. */
export function readChangedGroup(
	backend: RecordBackend,
	works: readonly string[],
	producer: string,
	changed: ReadonlyMap<string, string>,
	check: () => void,
): { cache: GroupCache; through: number; stored: StoredRecord[]; rows: WorkRecord[] } | undefined {
	const raw = backend.getNote("agent", groupKey(works))
	if (!raw) return undefined
	let cache: GroupCache
	try {
		const saved: { digest: string; body: string } = JSON.parse(raw)
		if (digest(saved.body) !== saved.digest) return undefined
		cache = JSON.parse(saved.body)
		if (
			cache.version !== 1 ||
			cache.group !== groupKey(works) ||
			cache.producer !== producer ||
			!Number.isSafeInteger(cache.through) ||
			!Array.isArray(cache.shared) ||
			cache.shared.some((entry) => typeof entry.first !== "string" || !Number.isSafeInteger(entry.order))
		)
			return undefined
	} catch {
		return undefined
	}
	const stored: StoredRecord[] = []
	const through = backend.recordWatermark()
	for (const workId of works) {
		let after = cache.through
		while (true) {
			check()
			const page = backend.readRecordPage(after, through, MAX_CHANGED_ROWS, check, workId)
			for (const { position: _position, ...row } of page) stored.push(row)
			if (stored.length > MAX_CHANGED_ROWS || page.length < MAX_CHANGED_ROWS) break
			after = page.at(-1)?.position ?? after
		}
		if (stored.length > MAX_CHANGED_ROWS) return undefined
	}
	if (stored.length !== changed.size || stored.some((row) => changed.get(row.recordHash) !== row.type)) return undefined
	for (const row of cache.context) {
		check()
		const authority = backend.getRecord(row.recordHash)
		if (!authority || authority.body !== row.body) return undefined
	}
	check()
	if (!verifySharedHeads(backend, cache)) return undefined
	const rows = stored.map((row) => JSON.parse(row.body) as WorkRecord)
	const scopeByWork = new Map(cache.scopes)
	const known = indexes(rows)
	for (const row of rows)
		if (["commit", "work_link", "file_transition", "file_observation"].includes(row.type)) return undefined
	for (const [requestId, entry] of known.requests) {
		if (!rows.some((row) => row.type === "request" && row.requestId === requestId)) return undefined
		if (works.some((workId) => backend.hasNote(workId, requestKey(requestId)))) return undefined
		const scope = rows.find((row) => row.type === "request" && row.requestId === requestId)
		if (!scope || !isWorkScope(scope.scope) || scopeByWork.get(entry.workId) !== JSON.stringify(scope.scope))
			return undefined
	}
	for (const segment of known.segments.keys())
		if (works.some((workId) => backend.hasNote(workId, segmentKey(segment)))) return undefined
	for (const bill of known.bills.keys())
		if (works.some((workId) => backend.hasNote(workId, billKey(bill)))) return undefined
	for (const link of cache.context)
		if (link.type === "work_link") {
			const row: WorkRecord = JSON.parse(link.body)
			if (Array.isArray(row.requestIds) && row.requestIds.some((id) => known.requests.has(String(id)))) return undefined
		}
	return { cache, through, stored, rows }
}

/** Replay shared facts at their first request, not at the newly changed request's position. */
export function observationUnits(cache: GroupCache, built: CommonEvents): EventUnit[] {
	const affected = new Set(
		built.units.flatMap((unit) => unit.entities.slice(1).map((entityId) => `${unit.account}\0${entityId}`)),
	)
	const carriers = cache.shared
		.filter((entry) => affected.has(`${entry.account}\0${entry.entityId}`))
		.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.order - b.order))
	const units: EventUnit[] = []
	let index = 0
	for (const unit of built.units) {
		while (index < carriers.length && carriers[index].first < (unit.requestId ?? "\uffff")) {
			const entry = carriers[index++]
			units.push({ account: entry.account, requestId: entry.first, entities: [entry.entityId], recordHashes: [] })
		}
		units.push(unit)
	}
	for (; index < carriers.length; index++) {
		const entry = carriers[index]
		units.push({ account: entry.account, requestId: entry.first, entities: [entry.entityId], recordHashes: [] })
	}
	return units
}

/** Shared union and last-writer rules are identical to the full builder; additions never subtract contributors. */
export function mergeSharedFacts(cache: GroupCache, built: CommonEvents): CommonEvents {
	const accounts = new Map(built.accounts.map((entry) => [accountKey(entry.account), entry]))
	const current = new Map(cache.shared.map((entry) => [`${entry.account}\0${entry.entityId}`, entry]))
	for (const unit of built.units) {
		if (!unit.requestId) continue
		for (const entityId of unit.entities.slice(1)) {
			const prior = current.get(`${unit.account}\0${entityId}`)
			const group = accounts.get(unit.account)
			const index = group?.facts.findIndex((fact) => fact.entityId === entityId) ?? -1
			if (!prior || !group || index < 0) continue
			const next = group.facts[index]
			const later = unit.requestId > prior.writer
			const newer = later ? next : prior.fact
			if (prior.fact.work && next.work) {
				const chosen = later ? next.work : prior.fact.work
				const keys = new Set([
					...(prior.fact.work.issueKeys ?? []).map((issue) => issue.key),
					...(next.work.issueKeys ?? []).map((issue) => issue.key),
				])
				group.facts[index] = {
					...newer,
					work: {
						...chosen,
						issueKeys: [...keys]
							.sort()
							.slice(0, 20)
							.map((key) => ({ key, source: "work" })),
					},
				}
			} else if (prior.fact.pullRequest && next.pullRequest) {
				const chosen = later ? next.pullRequest : prior.fact.pullRequest
				const keys = new Map(
					[...(prior.fact.pullRequest.issueKeys ?? []), ...(next.pullRequest.issueKeys ?? [])].map((issue) => [
						`${issue.source}:${issue.key}`,
						issue,
					]),
				)
				group.facts[index] = {
					...newer,
					pullRequest: {
						...chosen,
						issueKeys: [...keys.values()]
							.sort((a, b) => Number(b.source === "work") - Number(a.source === "work") || a.key.localeCompare(b.key))
							.slice(0, 20),
					},
				}
			} else group.facts[index] = newer
		}
	}
	return built
}
