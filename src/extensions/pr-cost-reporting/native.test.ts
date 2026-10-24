import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, expect, it } from "vitest"
import type { WorkRecord } from "../work-attribution/summary.js"
import type { nativeObservations } from "./native.js"

const requestId = "11111111-1111-4111-8111-111111111111"
const workId = "22222222-2222-4222-8222-222222222222"
const sessionId = "session-one"
const startedAt = "2026-10-24T08:00:00Z"
const dispatchedAt = "2026-10-24T08:00:01Z"
const recordedAt = "2026-10-24T08:00:02Z"
const scope = {
	account: {
		apiUrl: "https://api.cast.ai",
		organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	},
	repository: "/repo/.git",
}
const nativeUsage = {
	harness: "kimchi",
	sourceVersion: "1.2.3",
	api: "anthropic-messages",
	schema: "anthropic-messages-v1",
	provider: "anthropic",
	reportedModel: "requested-model",
	actualModel: "responding-model",
	responseId: "msg-one",
	serviceTier: "standard",
	region: "global",
	dispatchObserved: true,
	finalized: true,
	raw: {
		inputTokens: 12,
		outputTokens: 7,
		cacheReadTokens: 0,
		cacheWriteTokens: 9,
		reasoningTokens: 2,
		cacheWrites: [
			{ ttlSeconds: 3600, tokens: 5 },
			{ ttlSeconds: 300, tokens: 4 },
		],
	},
}

function records(): WorkRecord[] {
	const owner = { version: 1 as const, requestId, workId, sessionId }
	return [
		{ ...owner, type: "request", startedAt, scope, provider: "context-provider", model: "context-model" },
		{ ...owner, type: "request_dispatch", startedAt, dispatchedAt },
		{ ...owner, type: "request_response", recordedAt, nativeUsage: structuredClone(nativeUsage) },
	]
}

const cases: Record<string, WorkRecord[]> = { valid: records() }
function changed(name: string, change: (rows: WorkRecord[]) => void): void {
	const rows = records()
	change(rows)
	cases[name] = rows
}
changed("duplicates", (rows) => {
	rows.push({ ...rows[0], startedAt: "2026-10-24T10:00:00+02:00" })
	rows.push({ ...rows[1], dispatchedAt: "2026-10-24T10:00:01+02:00" })
	rows.push({ ...rows[2], recordedAt: "2026-10-24T08:00:03Z" })
})
changed("cross-repository", (rows) => rows.push({ ...rows[0], scope: { ...scope, repository: "/other/.git" } }))
changed("cross-account", (rows) =>
	rows.push({
		...rows[0],
		scope: { ...scope, account: { ...scope.account, userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } },
	}),
)
changed("cross-work", (rows) => {
	rows[2].workId = "33333333-3333-4333-8333-333333333333"
})
changed("cross-session", (rows) => {
	rows[1].sessionId = "other-session"
})
changed("contradictory-header", (rows) => {
	rows.push({ ...rows[2], sessionId: "other-session", nativeUsage: undefined })
})
changed("malformed-native", (rows) => {
	rows.push({ ...rows[2], nativeUsage: false })
})
changed("different-start", (rows) => rows.push({ ...rows[0], startedAt: dispatchedAt }))
changed("dispatch-different-start", (rows) => {
	rows[1].startedAt = dispatchedAt
})
changed("different-dispatch", (rows) => rows.push({ ...rows[1], dispatchedAt: recordedAt }))
changed("missing-scope", (rows) => {
	rows[0].scope = undefined
})
changed("invalid-start", (rows) => {
	rows[0].startedAt = "not-a-date"
})
changed("missing-dispatch", (rows) => {
	rows.splice(1, 1)
})
changed("unobserved", (rows) => {
	rows[2].nativeUsage = { ...nativeUsage, dispatchObserved: false }
})
changed("ambiguous", (rows) => {
	rows[2].nativeUsage = { ...nativeUsage, responseCorrelation: "ambiguous" }
})
changed("previous-response", (rows) => {
	rows[2].nativeUsage = { ...nativeUsage, previousResponses: [{ raw: { inputTokens: 4 } }] }
})
changed("conflicting-usage", (rows) =>
	rows.push({ ...rows[2], nativeUsage: { ...nativeUsage, raw: { inputTokens: 13 } } }),
)
changed("conflicting-model", (rows) =>
	rows.push({ ...rows[2], nativeUsage: { ...nativeUsage, actualModel: "other-model" } }),
)
changed("schema-mismatch", (rows) => {
	rows[2].nativeUsage = { ...nativeUsage, schema: "openai-responses-v1" }
})
changed("partial", (rows) => {
	rows[2].nativeUsage = {
		...nativeUsage,
		finalized: false,
		responseStatus: "incomplete",
		incompleteReason: "max_output_tokens",
		rawStopReason: "length",
		raw: { inputTokens: 12 },
		sdkUsage: { output: 999, cost: { total: 5 } },
	}
})
changed("empty", (rows) => {
	rows[2].nativeUsage = { ...nativeUsage, raw: {}, sdkUsage: { input: 100, output: 999 } }
})
changed("retry", (rows) => {
	rows[2].nativeUsage = { ...nativeUsage, finalized: false, raw: { inputTokens: 12 } }
	rows.push(...records().map((row) => ({ ...row, requestId: "44444444-4444-4444-8444-444444444444" })))
})
changed("headers-only", (rows) => {
	rows[2] = { ...rows[2], nativeUsage: undefined, responseModel: "headers-model" }
})
changed("final-usage", (rows) => {
	rows[2].nativeUsage = { ...nativeUsage, finalUsageObserved: true }
})
changed("duplicate-final-usage", (rows) => {
	rows.push({ ...rows[2], nativeUsage: { ...nativeUsage, finalUsageObserved: true } })
})
changed("unproven-final-usage", (rows) => {
	rows[2].nativeUsage = { ...nativeUsage, finalUsageObserved: "true" }
})
const invalidRaw = [
	{ inputTokens: "12" },
	{ inputTokens: -1 },
	{ inputTokens: 1.5 },
	{ inputTokens: 1_000_000_000_001 },
	{
		cacheWrites: [
			{ ttlSeconds: 300, tokens: 1 },
			{ ttlSeconds: 300, tokens: 2 },
		],
	},
	{ cacheWrites: [{ ttlSeconds: 0, tokens: 1 }] },
	{ cacheWrites: [{ ttlSeconds: 300, tokens: -1 }] },
	{ cacheWrites: [{ ttlSeconds: 86401, tokens: 1 }] },
	{ cacheWrites: Array.from({ length: 17 }, (_, i) => ({ ttlSeconds: i + 1, tokens: 0 })) },
	{ cacheWriteTokens: 1, cacheWrites: [{ ttlSeconds: 300, tokens: 2 }] },
	{
		cacheWrites: [
			{ ttlSeconds: 300, tokens: 1_000_000_000_000 },
			{ ttlSeconds: 3600, tokens: 1_000_000_000_000 },
		],
	},
	{ outputTokens: 1, reasoningTokens: 2 },
]
for (const [i, raw] of invalidRaw.entries())
	changed(`invalid-raw-${i}`, (rows) => {
		rows[2].nativeUsage = { ...nativeUsage, raw }
	})
changed("invalid-openai-partition", (rows) => {
	rows[2].nativeUsage = {
		...nativeUsage,
		api: "openai-completions",
		schema: "openai-chat-completions-v1",
		raw: { inputTokens: 20, cacheReadTokens: 12, cacheWriteTokens: 9 },
	}
})

let actual: Record<string, ReturnType<typeof nativeObservations>>
beforeAll(() => {
	const moduleUrl = new URL("./native.ts", import.meta.url).href
	actual = JSON.parse(
		execFileSync(
			"bun",
			[
				"--eval",
				`
import { nativeObservations } from ${JSON.stringify(moduleUrl)};
const cases = await Bun.stdin.json();
console.log(JSON.stringify(Object.fromEntries(Object.entries(cases).map(([name, rows]) => [name, nativeObservations(rows)]))));
`,
			],
			{
				input: JSON.stringify(
					Object.fromEntries(
						Object.entries(cases).map(([name, rows]) => [
							name,
							rows.map((row) => ({
								body: JSON.stringify(row),
								recordHash: createHash("sha256").update(JSON.stringify(row)).digest("hex"),
							})),
						]),
					),
				),
				encoding: "utf8",
				timeout: 30_000,
			},
		),
	)
}, 30_000)

it("joins immutable owner and physical dispatch while retaining actual routed usage", () => {
	expect(actual.valid.unresolved).toEqual([])
	expect(actual.valid.observations).toEqual([
		{
			requestId,
			workId,
			sessionId,
			scope,
			startedAt,
			dispatchedAt,
			observeTime: recordedAt,
			sourceVersion: "1.2.3",
			api: "anthropic-messages",
			schema: "anthropic-messages-v1",
			provider: "anthropic",
			reportedModel: "requested-model",
			actualModel: "responding-model",
			responseId: "msg-one",
			serviceTier: "standard",
			region: "global",
			finalized: true,
			raw: {
				inputTokens: "12",
				outputTokens: "7",
				cacheReadTokens: "0",
				cacheWriteTokens: "9",
				reasoningTokens: "2",
				cacheWrites: [
					{ ttlSeconds: 300, tokens: "4" },
					{ ttlSeconds: 3600, tokens: "5" },
				],
			},
			recordHashes: cases.valid.map((row) => createHash("sha256").update(JSON.stringify(row)).digest("hex")),
		},
	])
})

it("collapses equivalent duplicate observations without adding tokens or replacing original identity", () => {
	expect(actual.duplicates.unresolved).toEqual([])
	expect(actual.duplicates.observations).toHaveLength(1)
	expect(actual.duplicates.observations[0]).toMatchObject({
		requestId,
		observeTime: recordedAt,
		raw: { inputTokens: "12" },
	})
	expect(actual.duplicates.observations[0].recordHashes).toHaveLength(6)
})

it.each([
	["cross-repository", "conflicting_request_identity"],
	["cross-account", "conflicting_request_identity"],
	["cross-work", "conflicting_request_owner"],
	["cross-session", "conflicting_request_owner"],
	["contradictory-header", "conflicting_request_owner"],
	["malformed-native", "unobserved_native_dispatch"],
	["different-start", "conflicting_request_identity"],
	["dispatch-different-start", "conflicting_dispatch"],
	["different-dispatch", "conflicting_dispatch"],
	["missing-scope", "missing_request_identity"],
	["invalid-start", "missing_request_identity"],
	["missing-dispatch", "missing_dispatch"],
	["unobserved", "unobserved_native_dispatch"],
	["ambiguous", "ambiguous_response"],
	["previous-response", "ambiguous_response"],
	["conflicting-usage", "conflicting_native_observation"],
	["conflicting-model", "conflicting_native_observation"],
	["schema-mismatch", "invalid_native_schema"],
])("retains unresolved evidence for %s instead of producing a financial observation", (name, reason) => {
	expect(actual[name].observations).toEqual([])
	expect(actual[name].unresolved).toEqual([{ requestId, recordHashes: expect.any(Array), reason }])
	expect(actual[name].unresolved[0].recordHashes.length).toBeGreaterThan(0)
})

it("preserves partial attempts, explicit zeros and absent counters without SDK defaults", () => {
	expect(actual.partial.observations[0]).toMatchObject({
		finalized: false,
		responseStatus: "incomplete",
		incompleteReason: "max_output_tokens",
		rawStopReason: "length",
	})
	expect(actual.partial.observations[0].raw).toEqual({ inputTokens: "12" })
	expect(actual.empty.observations[0].raw).toEqual({})
	expect(actual.retry.observations.map((row) => [row.requestId, row.raw.inputTokens])).toEqual([
		[requestId, "12"],
		["44444444-4444-4444-8444-444444444444", "12"],
	])
	expect(actual.partial.unresolved).toEqual([])
	expect(actual.retry.unresolved).toEqual([])
})

it.each(invalidRaw.map((_, i) => i))("rejects invalid raw usage bucket %s", (i) => {
	expect(actual[`invalid-raw-${i}`].observations).toEqual([])
	expect(actual[`invalid-raw-${i}`].unresolved[0].reason).toBe("invalid_raw_usage")
})

it("rejects complete OpenAI cache partitions exceeding inclusive input", () => {
	expect(actual["invalid-openai-partition"].observations).toEqual([])
	expect(actual["invalid-openai-partition"].unresolved[0].reason).toBe("invalid_raw_usage")
})

it("does not mistake response headers for native token usage", () => {
	expect(actual["headers-only"]).toEqual({ observations: [], unresolved: [] })
})

it("retains affirmative final-usage evidence across equivalent copies without inventing it", () => {
	expect(actual["final-usage"].observations[0].finalUsageObserved).toBe(true)
	expect(actual["duplicate-final-usage"].observations).toHaveLength(1)
	expect(actual["duplicate-final-usage"].observations[0].finalUsageObserved).toBe(true)
	expect(actual["duplicate-final-usage"].unresolved).toEqual([])
	expect(actual.valid.observations[0].finalUsageObserved).not.toBe(true)
	expect(actual["unproven-final-usage"].observations[0].finalUsageObserved).not.toBe(true)
})

it("fulfills exact imported-line markers only with a durable outbox observation, including rollback and reopen", {
	timeout: 30_000,
}, () => {
	const agent = mkdtempSync(join(tmpdir(), "kimchi-native-import-"))
	try {
		const moduleUrl = new URL("./native.ts", import.meta.url).href
		const recordsUrl = new URL("./ledger/records.ts", import.meta.url).href
		const outboxUrl = new URL("./ledger/outbox.ts", import.meta.url).href
		const output = JSON.parse(
			execFileSync(
				"bun",
				[
					"--eval",
					`
import { nativeObservations } from ${JSON.stringify(moduleUrl)};
import { backendFor, importBatchInTx, recordHashOf, closeBackends } from ${JSON.stringify(recordsUrl)};
import { observeEvents, pendingBatch } from ${JSON.stringify(outboxUrl)};
const { agent, rows } = await Bun.stdin.json();
let backend = backendFor(agent);
backend.tx(() => importBatchInTx(backend, rows.map((record, i) => ({
  line: JSON.stringify(record).replace("{", "{ "), record,
  sourcePath: "/owned-fixture/work.jsonl", sourceGeneration: 0, sourceOffset: i * 1000
}))));
const stored = backend.readRecords({});
const differentHashes = stored.filter(row => row.recordHash !== recordHashOf(JSON.parse(row.body))).length;
const { observations, unresolved } = nativeObservations(stored);
if (unresolved.length || observations.length !== 1) throw new Error("Native join failed");
const observation = observations[0];
const hashes = observation.recordHashes;
const pending = () => backend.pendingTranslations(0, backend.recordWatermark(), 100).map(row => row.recordHash).sort();
const retainedBefore = pending().length;
if (JSON.stringify(pending()) !== JSON.stringify([...hashes].sort())) throw new Error("Wrong imported markers");
const fact = {
  entityId: observation.requestId, source: "kimchi", sourceVersion: observation.sourceVersion,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", observeTime: observation.observeTime,
  workId: observation.workId, sessionId: observation.sessionId,
  usage: { channel: "native", requestId: observation.requestId, schema: observation.schema,
    counterScope: "request", observedRoute: "unknown", billingBasis: "unknown", correlation: "request-id",
    provider: observation.provider, reportedModel: observation.reportedModel, actualModel: observation.actualModel,
    serviceTier: observation.serviceTier, region: observation.region, attemptsComplete: false, raw: observation.raw }
};
let checks = 0;
try { observeEvents(agent, "account", [fact], hashes, () => { if (++checks === 2) throw new Error("lease lost") }); }
catch (error) { if (error.message !== "lease lost") throw error; }
const rollback = pending().length === retainedBefore && backend.pendingOutboxEvents("account", 10).length === 0;
observeEvents(agent, "account", [fact], hashes, () => {});
const after = pending().length;
const batch = pendingBatch(agent, "account", () => {});
const events = batch ? JSON.parse(Buffer.from(batch.body).toString()).batch.events.length : 0;
closeBackends(); backend = backendFor(agent);
const reopened = pending().length === 0 && backend.readRecords({}).length === 3 && backend.pendingOutboxEvents("account", 10).length === 1;
closeBackends();
console.log(JSON.stringify({ differentHashes, retainedBefore, rollback, after, events, reopened }));
`,
				],
				{ input: JSON.stringify({ agent, rows: records() }), encoding: "utf8", timeout: 30_000 },
			),
		)
		expect(output).toEqual({
			differentHashes: 3,
			retainedBefore: 3,
			rollback: true,
			after: 0,
			events: 1,
			reopened: true,
		})
	} finally {
		rmSync(agent, { recursive: true, force: true })
	}
})
