import { isWorkId } from "../../shared/work-id.js"
import { isWorkScope, sameWorkScope, type WorkScope } from "../work-attribution/scope.js"
import { object, type WorkRecord } from "../work-attribution/summary.js"
import type { StoredRecord } from "./ledger/records.js"
import { type RawUsage, timeNanos, validateAccountingRaw } from "./protocol.js"

export interface NativeObservation {
	requestId: string
	workId: string
	sessionId: string
	scope: WorkScope
	startedAt: string
	dispatchedAt: string
	observeTime: string
	sourceVersion: string
	api: string
	schema: string
	provider: string
	reportedModel: string
	actualModel?: string
	responseId?: string
	serviceTier?: string
	region?: string
	finalized?: boolean
	responseStatus?: string
	incompleteReason?: string
	rawStopReason?: string
	finalUsageObserved?: true
	iterations?: { type?: string; model?: string; raw: RawUsage }[]
	iterationsIncomplete?: true
	raw: RawUsage
	recordHashes: string[]
}

export interface UnresolvedNativeObservation {
	requestId: string
	recordHashes: string[]
	reason: string
}

const schemas = new Map([
	["anthropic-messages", "anthropic-messages-v1"],
	["openai-completions", "openai-chat-completions-v1"],
	["openai-responses", "openai-responses-v1"],
	["azure-openai-responses", "openai-responses-v1"],
	["openai-codex-responses", "openai-responses-v1"],
])

function instant(value: unknown): bigint | undefined {
	if (typeof value !== "string" || !/^(?!0000)\d{4}-/.test(value)) return
	try {
		return timeNanos(value)
	} catch {
		return
	}
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length ? value : undefined
}

function tokens(value: unknown): string {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000)
		throw new Error("invalid_raw_usage")
	return String(value)
}

function rawUsage(value: unknown): RawUsage {
	if (!object(value)) throw new Error("invalid_raw_usage")
	const raw: RawUsage = {}
	for (const field of [
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"reasoningTokens",
	] as const)
		if (value[field] !== undefined) raw[field] = tokens(value[field])
	if (value.cacheWrites !== undefined) {
		if (!Array.isArray(value.cacheWrites)) throw new Error("invalid_raw_usage")
		raw.cacheWrites = value.cacheWrites
			.map((write) => {
				if (!object(write) || typeof write.ttlSeconds !== "number") throw new Error("invalid_raw_usage")
				return { ttlSeconds: write.ttlSeconds, tokens: tokens(write.tokens) }
			})
			.sort((a, b) => a.ttlSeconds - b.ttlSeconds)
	}
	return raw
}

/** Resolve native identity from the immutable prefix; summary projections and today's account cannot repair it. */
export function nativeObservations(records: readonly Pick<StoredRecord, "body" | "recordHash">[]): {
	observations: NativeObservation[]
	unresolved: UnresolvedNativeObservation[]
} {
	const groups = new Map<string, { record: WorkRecord; recordHash: string }[]>()
	for (const stored of records) {
		const row: WorkRecord = JSON.parse(stored.body)
		if (
			typeof row.requestId !== "string" ||
			!(row.type === "request" || row.type === "request_dispatch" || row.type === "request_response")
		)
			continue
		const rows = groups.get(row.requestId) ?? []
		rows.push({ record: row, recordHash: stored.recordHash })
		groups.set(row.requestId, rows)
	}
	const observations: NativeObservation[] = []
	const unresolved: UnresolvedNativeObservation[] = []
	for (const [requestId, stored] of groups) {
		const rows = stored.map((row) => row.record)
		const responses = rows.filter((row) => row.type === "request_response" && row.nativeUsage !== undefined)
		if (!responses.length) continue
		const recordHashes = [...new Set(stored.map((row) => row.recordHash))]
		try {
			if (!isWorkId(requestId)) throw new Error("invalid_request_id")
			const requests = rows.filter((row) => row.type === "request")
			const request = requests[0]
			if (
				!request ||
				!isWorkId(request.workId) ||
				!text(request.sessionId) ||
				!isWorkScope(request.scope) ||
				instant(request.startedAt) === undefined
			)
				throw new Error("missing_request_identity")
			for (const row of rows) {
				if (row.version !== 1 || row.workId !== request.workId || row.sessionId !== request.sessionId)
					throw new Error("conflicting_request_owner")
				if (
					row.type === "request" &&
					(!isWorkScope(row.scope) ||
						!sameWorkScope(request.scope, row.scope) ||
						instant(row.startedAt) !== instant(request.startedAt))
				)
					throw new Error("conflicting_request_identity")
			}
			const dispatches = rows.filter((row) => row.type === "request_dispatch")
			const dispatch = dispatches[0]
			if (!dispatch || instant(dispatch.dispatchedAt) === undefined) throw new Error("missing_dispatch")
			for (const row of dispatches)
				if (
					instant(row.dispatchedAt) !== instant(dispatch.dispatchedAt) ||
					instant(row.startedAt) !== instant(request.startedAt)
				)
					throw new Error("conflicting_dispatch")
			let observation: NativeObservation | undefined
			let signature: string | undefined
			for (const row of responses) {
				const usage = row.nativeUsage
				if (
					!object(usage) ||
					usage.harness !== "kimchi" ||
					usage.dispatchObserved !== true ||
					instant(row.recordedAt) === undefined
				)
					throw new Error("unobserved_native_dispatch")
				if (
					usage.responseCorrelation === "ambiguous" ||
					(usage.previousResponses !== undefined &&
						(!Array.isArray(usage.previousResponses) || usage.previousResponses.length))
				)
					throw new Error("ambiguous_response")
				const sourceVersion = text(usage.sourceVersion)
				const api = text(usage.api)
				const schema = text(usage.schema)
				const provider = text(usage.provider)
				const reportedModel = text(usage.reportedModel)
				if (!sourceVersion || !api || !schema || !provider || !reportedModel) throw new Error("missing_native_metadata")
				if (schema !== (schemas.get(api) ?? "unknown")) throw new Error("invalid_native_schema")
				const raw = rawUsage(usage.raw)
				let iterations: NativeObservation["iterations"]
				if (usage.iterations !== undefined) {
					if (!Array.isArray(usage.iterations) || schema !== "anthropic-messages-v1")
						throw new Error("invalid_native_iterations")
					iterations = usage.iterations.map((value) => {
						if (
							!object(value) ||
							(value.type !== undefined && typeof value.type !== "string") ||
							(value.model !== undefined && typeof value.model !== "string")
						)
							throw new Error("invalid_native_iterations")
						return { type: text(value.type), model: text(value.model), raw: rawUsage(value.raw) }
					})
				}
				if (usage.iterationsIncomplete !== undefined && typeof usage.iterationsIncomplete !== "boolean")
					throw new Error("invalid_native_iterations")
				try {
					validateAccountingRaw(schema, raw, true)
					for (const iteration of iterations ?? []) validateAccountingRaw(schema, iteration.raw, true)
				} catch {
					throw new Error("invalid_raw_usage")
				}
				const candidate = {
					sourceVersion,
					api,
					schema,
					provider,
					reportedModel,
					actualModel: text(usage.actualModel),
					responseId: text(usage.responseId),
					serviceTier: text(usage.serviceTier),
					region: text(usage.region),
					finalized: typeof usage.finalized === "boolean" ? usage.finalized : undefined,
					responseStatus: text(usage.responseStatus),
					incompleteReason: text(usage.incompleteReason),
					rawStopReason: text(usage.rawStopReason),
					raw,
					iterations,
				}
				const next = JSON.stringify(candidate)
				if (signature !== undefined && signature !== next) throw new Error("conflicting_native_observation")
				signature = next
				observation ??= {
					requestId,
					workId: request.workId,
					sessionId: request.sessionId,
					scope: request.scope,
					startedAt: String(request.startedAt),
					dispatchedAt: String(dispatch.dispatchedAt),
					observeTime: String(row.recordedAt),
					...candidate,
					recordHashes,
				}
				if (usage.finalUsageObserved === true) observation.finalUsageObserved = true
				if (
					usage.iterationsIncomplete === true ||
					(iterations !== undefined &&
						(!iterations.length ||
							iterations.length > 16 ||
							iterations.some(
								(value) => !["message", "fallback_message", "advisor_message", "compaction"].includes(value.type ?? ""),
							)))
				)
					observation.iterationsIncomplete = true
			}
			if (observation) observations.push(observation)
		} catch (error) {
			unresolved.push({
				requestId,
				recordHashes,
				reason: error instanceof Error ? error.message : "invalid_native_observation",
			})
		}
	}
	return { observations, unresolved }
}
