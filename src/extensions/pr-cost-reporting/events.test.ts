import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { requestTagSelector } from "../work-attribution/billing-source.js"
import type { CommonEvents } from "./events.js"

it("uploads real SDK capture through the worker with exact legacy drainage and account/consent-safe retries", {
	timeout: 30_000,
}, () => {
	const directory = mkdtempSync(join(tmpdir(), "kimchi-worker-events-"))
	try {
		const driver = fileURLToPath(new URL("../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
		const result = JSON.parse(
			execFileSync("bun", [driver, "native-common-delivery", directory], { encoding: "utf8", timeout: 30_000 }),
		)
		expect(result).toMatchObject({
			initialPending: 0,
			finalPending: 0,
			legacyExact: true,
			legacyFirst: true,
			noNewLegacy: true,
			reopened: true,
			backoff: true,
			idle: true,
			replayed: true,
			invalidAckRetained: true,
			optOutRetained: true,
			accountFenced: true,
			otherBackoff: true,
			rejectedBackoff: true,
			keyFenced: true,
			redirectsRejected: true,
			legacyBoundary: true,
			failedPassAborted: true,
			abandonedRetained: true,
		})
		expect(result.capturedByWorker).toHaveLength(2)
		expect(
			result.capturedByWorker.filter((event: { usage: { schema: string } }) => event.usage.schema === "unknown"),
		).toHaveLength(1)
		const native = result.capturedByWorker.find(
			(event: { usage: { schema: string } }) => event.usage.schema === "anthropic-messages-v1",
		)
		expect(native.usage).toMatchObject({
			serviceTier: "standard",
			region: "global",
			attemptsComplete: false,
			iterations: [
				{ model: "sdk-primary", raw: { inputTokens: "100", outputTokens: "0" } },
				{ model: "sdk-fallback", raw: { inputTokens: "90", outputTokens: "7" } },
			],
		})
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

const requestId = "11111111-1111-4111-8111-111111111111"
const workId = "22222222-2222-4222-8222-222222222222"
const producer = "33333333-3333-4333-8333-333333333333"
const account = {
	apiUrl: "https://api.cast.ai",
	organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
}
const scope = { account, repository: "/private/repo/.git" }
const start = "2026-10-24T08:00:00Z"
const owner = { version: 1, requestId, workId, sessionId: "original-session" }
const nativeUsage = {
	harness: "kimchi",
	sourceVersion: "1.2.3",
	api: "anthropic-messages",
	schema: "anthropic-messages-v1",
	provider: "anthropic",
	reportedModel: "requested",
	actualModel: "responding",
	dispatchObserved: true,
	finalized: true,
	finalUsageObserved: true,
	raw: {
		inputTokens: 12,
		outputTokens: 7,
		cacheReadTokens: 0,
		cacheWriteTokens: 9,
		cacheWrites: [{ ttlSeconds: 300, tokens: 9 }],
	},
}
const records = [
	{ ...owner, type: "request", startedAt: start, scope, prompt: "private prompt", issue: { key: "LLM-42" } },
	{ ...owner, type: "request_dispatch", startedAt: start, dispatchedAt: "2026-10-24T08:00:01Z" },
	{
		...owner,
		type: "request_response",
		recordedAt: "2026-10-24T08:00:02Z",
		nativeUsage,
	},
]
const report = {
	pullRequests: [],
	requests: [
		{
			requestId,
			account,
			workIds: [workId],
			sessionIds: [owner.sessionId],
			startedAt: start,
			pullRequestIds: [],
			allocation: "unlinked",
			billingRecordIds: [] as string[],
			priceStatus: "missing",
			knownCostUsd: "0",
			totalCostUsd: null,
		},
	],
	unallocated: {},
}
const repositories = [[scope.repository, { provider: "github", host: "github.com", id: "999", name: "fork/repo" }]]

function build(
	rows: unknown[],
	inputReport: unknown = report,
	touched?: { requests: string[]; records: string[] },
): CommonEvents & { claims: number } {
	const stored = rows.map((row, index) => ({
		body: JSON.stringify(row),
		recordHash: createHash("sha256").update(`original-${index}`).digest("hex"),
		sourcePath: null,
	}))
	return JSON.parse(
		execFileSync(
			"bun",
			[
				"--eval",
				`
import {buildEvents} from ${JSON.stringify(new URL("./events.ts", import.meta.url).href)};
const input = await Bun.stdin.json();
let claims = 0;
const touched = input.touched && { requests: new Set(input.touched.requests), records: new Set(input.touched.records) };
const built = buildEvents(input.stored, input.report, new Map(input.repositories), input.producer, () => {}, () => { claims++ }, touched);
console.log(JSON.stringify({ ...built, claims }));
`,
			],
			{
				input: JSON.stringify({ stored, report: inputReport, repositories, producer, touched }),
				encoding: "utf8",
				timeout: 30_000,
			},
		),
	)
}

it("exports captured tool, file, plan and commit facts with explicit snapshot coverage", () => {
	const at = "2026-10-24T08:00:03Z"
	const common = { ...owner, recordedAt: at, repository: scope.repository }
	const rows = [
		...records,
		{
			...common,
			type: "tool_execution",
			toolCallId: "edit",
			toolName: "edit",
			outcome: "failed",
			durationMs: 12.75,
			args: { content: "private arguments" },
			result: { content: "private result" },
		},
		{
			...common,
			type: "file_transition",
			transitionId: "transition-one",
			toolCallId: "edit",
			path: "src/private.ts",
			before: { blob: "a".repeat(40), mode: "100644" },
			after: { blob: "b".repeat(40), mode: "100644" },
		},
		{
			...common,
			type: "plan",
			path: "plans/private.md",
			snapshotPath: "/private/retained",
			contentHash: "c".repeat(64),
		},
		{ ...common, type: "commit", sha: "d".repeat(40) },
		{
			...common,
			type: "file_observation",
			observationId: "observation-one",
			toolCallId: "shell",
			source: "bash",
			complete: false,
			truncated: true,
			changedPaths: 3,
			files: [{ path: "src/another-private.ts", before: null, after: { blob: "e".repeat(40), mode: "100644" } }],
		},
	]
	const result = build(rows)
	expect(result.unresolved).toEqual([])
	const group = result.accounts[0]
	const usage = group.facts.find((fact) => fact.usage)
	expect(group.facts.find((fact) => fact.tool)?.tool).toMatchObject({
		callId: expect.any(String),
		name: "edit",
		category: "edit",
		outcome: "failed",
		durationMs: "12",
		requestEntityId: usage?.entityId,
	})
	expect(group.facts.find((fact) => fact.file)?.file?.toolCallId).toBe(
		group.facts.find((fact) => fact.tool)?.tool?.callId,
	)
	expect(group.facts.filter((fact) => fact.file).map((fact) => [fact.file?.operation, fact.file?.quality])).toEqual([
		["modified", "observed"],
		["created", "ambiguous"],
	])
	expect(group.facts.find((fact) => fact.work?.planId)?.work).toMatchObject({
		planId: expect.any(String),
		planRevision: expect.any(String),
		reason: "saved_plan",
		quality: "observed",
	})
	expect(group.facts.find((fact) => fact.commit)?.commit).toEqual({ id: "d".repeat(40), quality: "observed" })
	expect(group.facts.flatMap((fact) => (fact.coverage ? [fact.coverage] : []))).toEqual([
		{ code: "file_snapshot_incomplete", count: "1" },
		{ code: "file_paths_omitted", count: "2" },
	])
	expect(group.recordHashes).toHaveLength(rows.length)
	for (const value of [
		"src/private.ts",
		"src/another-private.ts",
		"plans/private.md",
		"/private/retained",
		"a".repeat(40),
		"b".repeat(40),
		"c".repeat(64),
		"private arguments",
		"private result",
	])
		expect(JSON.stringify(group.facts)).not.toContain(value)
})

it("links nested tool and file facts through the same opaque call identity", () => {
	const common = { ...owner, recordedAt: start, repository: scope.repository, toolCallId: "parent/1" }
	const result = build([
		...records,
		{ ...common, type: "tool_execution", toolName: "read", outcome: "completed" },
		{
			...common,
			type: "file_transition",
			transitionId: "nested-file",
			path: "private.ts",
			before: null,
			after: { blob: "a".repeat(40), mode: "100644" },
		},
	])
	expect(result.unresolved).toEqual([])
	const facts = result.accounts[0].facts
	const call = facts.find((fact) => fact.tool)?.tool?.callId
	expect(call).toBeTruthy()
	expect(call).not.toContain("parent/1")
	expect(facts.find((fact) => fact.file)?.file?.toolCallId).toBe(call)
})

it("exports nonfinancial work with a unique captured owner without inventing a dispatched request", () => {
	const rows = [
		records[0],
		{
			...owner,
			requestId: undefined,
			type: "plan",
			recordedAt: start,
			path: "plans/early.md",
			contentHash: "c".repeat(64),
		},
		{
			...owner,
			requestId: undefined,
			type: "commit",
			recordedAt: start,
			repository: scope.repository,
			sha: "d".repeat(40),
		},
	]
	const result = build(rows)
	expect(result.accounts).toHaveLength(1)
	expect(result.accounts[0].facts.some((fact) => fact.usage)).toBe(false)
	expect(result.accounts[0].facts.some((fact) => fact.work?.planId)).toBe(true)
	expect(result.accounts[0].facts.some((fact) => fact.commit)).toBe(true)
	expect(result.accounts[0].recordHashes).toHaveLength(2)
})

it("retains ambiguous auxiliary ownership across reporting accounts", () => {
	const otherId = "44444444-4444-4444-8444-444444444444"
	const otherAccount = { ...account, userId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }
	const rows = [
		records[0],
		{ ...records[0], requestId: otherId, scope: { ...scope, account: otherAccount } },
		{
			...owner,
			requestId: undefined,
			type: "plan",
			recordedAt: start,
			path: "plans/ambiguous.md",
			contentHash: "c".repeat(64),
		},
	]
	const result = build(rows, {
		...report,
		requests: [...report.requests, { ...report.requests[0], requestId: otherId, account: otherAccount }],
	})
	expect(result.accounts).toEqual([])
	expect(result.unresolved).toEqual([
		expect.objectContaining({ reason: "ambiguous_auxiliary_owner", recordHashes: expect.any(Array) }),
	])
})

it("retains the original intent when an observation cannot represent every captured file", () => {
	const row = {
		...owner,
		type: "file_observation",
		recordedAt: start,
		repository: scope.repository,
		observationId: "damaged",
		toolCallId: "shell",
		source: "bash",
		complete: true,
		files: [
			{ path: "valid.ts", before: null, after: { blob: "a".repeat(40), mode: "100644" } },
			{ path: "bad.ts", before: null, after: { blob: "not-a-git-blob", mode: "100644" } },
		],
	}
	const result = build([...records, row])
	expect(result.unresolved).toHaveLength(1)
	expect(result.accounts[0].recordHashes).toHaveLength(records.length)
	expect(result.accounts[0].facts.filter((fact) => fact.file)).toEqual([])
})

it("retains future versions of a known evidence kind instead of interpreting them as version one", () => {
	const result = build([
		...records,
		{
			...owner,
			version: 2,
			type: "file_transition",
			recordedAt: start,
			repository: scope.repository,
			transitionId: "future",
			toolCallId: "edit",
			path: "future.ts",
			before: null,
			after: { blob: "a".repeat(40), mode: "100644" },
		},
	])
	expect(result.unresolved).toEqual([expect.objectContaining({ reason: "unsupported_auxiliary_version" })])
	expect(result.accounts[0].recordHashes).toHaveLength(records.length)
	expect(result.accounts[0].facts.some((fact) => fact.file)).toBe(false)
})

it("translates observed native counters and original identity without inventing complete-attempt coverage", () => {
	const result = build(records)
	expect(result.accounts).toHaveLength(1)
	expect(result.accounts[0].account).toEqual(account)
	const usage = result.accounts[0].facts.find((fact) => fact.usage)
	expect(usage).toMatchObject({
		source: "kimchi",
		sourceVersion: "1.2.3",
		deviceId: producer,
		workId,
		sessionId: owner.sessionId,
		startedAt: start,
		repository: { id: "999" },
		allocation: { kind: "unlinked" },
		usage: {
			requestId,
			actualModel: "responding",
			schema: "anthropic-messages-v1",
			attemptsComplete: false,
			raw: {
				inputTokens: "12",
				outputTokens: "7",
				cacheReadTokens: "0",
				cacheWriteTokens: "9",
				cacheWrites: [{ ttlSeconds: 300, tokens: "9" }],
			},
		},
	})
	expect(result.accounts[0].recordHashes).toEqual(
		records.map((_, index) => createHash("sha256").update(`original-${index}`).digest("hex")),
	)
	expect(JSON.stringify(result.accounts[0].facts)).not.toContain("private prompt")
	expect(JSON.stringify(result.accounts[0].facts)).not.toContain(scope.repository)
})

it("keeps fork origin separate from parent PR allocation and recorded Jira metadata", () => {
	const input = {
		...report,
		requests: [{ ...report.requests[0], allocation: "pull-request", pullRequestIds: ["parent-pr"] }],
		pullRequests: [
			{
				key: "parent-pr",
				account,
				workIds: [workId],
				pullRequest: {
					id: "PR1",
					repositoryId: "42",
					provider: "github",
					host: "github.com",
					repository: "parent/repo",
					number: 1,
					url: "https://github.com/parent/repo/pull/1",
					state: "open",
					title: "Provider title",
					author: "provider-user",
					branchIssueKeys: ["LLM-43"],
					mergeCommitSha: null,
					mergedAt: null,
					closedAt: null,
					checkedAt: "2026-10-24T08:00:03Z",
				},
			},
		],
	}
	const result = build(records, input)
	const facts = result.accounts[0].facts
	expect(facts.find((fact) => fact.usage)).toMatchObject({
		repository: { id: "999" },
		allocation: { kind: "pull-request", pullRequestIds: ["PR1"], targetRepository: { id: "42" } },
	})
	expect(facts.find((fact) => fact.pullRequest)).toMatchObject({
		repository: { id: "42" },
		pullRequest: {
			id: "PR1",
			author: "provider-user",
			title: "Provider title",
			issueKeys: [
				{ key: "LLM-42", source: "work" },
				{ key: "LLM-43", source: "branch" },
			],
		},
	})
	expect(facts.find((fact) => fact.work)?.work?.issueKeys).toEqual([{ key: "LLM-42", source: "work" }])
	expect(facts.find((fact) => fact.link)?.link).toMatchObject({
		fromKind: "work",
		fromId: workId,
		toKind: "pull_request",
		toId: "PR1",
		quality: "confirmed",
	})
})

it("makes units and reads claims only for touched requests while shared facts aggregate every request", () => {
	const otherId = "44444444-4444-4444-8444-444444444444"
	const other = records.map((row) => ({
		...row,
		requestId: otherId,
		issue: row.type === "request" ? { key: "LLM-44" } : undefined,
	}))
	const both = { ...report, requests: [...report.requests, { ...report.requests[0], requestId: otherId }] }
	const result = build([...records, ...other], both, { requests: [otherId], records: [] })
	expect(result.units.map((unit) => unit.requestId)).toEqual([otherId])
	expect(result.claims).toBe(1)
	const work = result.accounts[0].facts.find((fact) => fact.work?.reason === "observed_request")
	expect(work?.work?.issueKeys?.map(({ key }) => key)).toEqual(["LLM-42", "LLM-44"])
	expect(build([...records, ...other], both).units).toHaveLength(2)
})

it("sends a PR on a host with a port and drops one the service would reject without holding back its request", () => {
	const pullRequest = {
		id: "PR1",
		repositoryId: "42",
		provider: "gitlab",
		host: "gitlab.example.com:8443",
		repository: "parent/repo",
		number: 1,
		url: "https://gitlab.example.com:8443/parent/repo/-/merge_requests/1",
		state: "open",
		mergeCommitSha: null,
		mergedAt: null,
		closedAt: null,
		checkedAt: "2026-10-24T08:00:03Z",
	}
	const input = (url: string) => ({
		...report,
		requests: [{ ...report.requests[0], allocation: "pull-request", pullRequestIds: ["parent-pr"] }],
		pullRequests: [{ key: "parent-pr", account, workIds: [workId], pullRequest: { ...pullRequest, url } }],
	})
	const sent = build(records, input(pullRequest.url)).accounts[0].facts.find((fact) => fact.pullRequest)
	expect(sent).toMatchObject({ repository: { host: "gitlab.example.com:8443" }, pullRequest: { uri: pullRequest.url } })
	const result = build(records, input("https://gitlab.example.com/parent/repo/-/merge_requests/1"))
	const facts = result.accounts[0].facts
	// A link without the repository's port names another host, so the service would refuse this PR state.
	expect(facts.find((fact) => fact.pullRequest)).toBeUndefined()
	expect(facts.find((fact) => fact.usage)?.allocation).toMatchObject({ kind: "pull-request", pullRequestIds: ["PR1"] })
	expect(result.units).toEqual([expect.objectContaining({ requestId })])
	expect(result.unresolved).toEqual([])
})

it("does not interpret an unknown iteration type as independently billable usage", () => {
	const response = {
		...records[2],
		nativeUsage: {
			...nativeUsage,
			iterations: [
				{ type: "message", model: "known", raw: { inputTokens: 12, outputTokens: 7 } },
				{ type: "future_summary", model: "known", raw: { inputTokens: 999, outputTokens: 999 } },
			],
		},
	}
	const result = build([...records.slice(0, 2), response])
	const usage = result.accounts[0].facts.find((fact) => fact.usage)?.usage
	expect(usage?.iterations?.[1]).toMatchObject({ schema: "unknown", raw: { inputTokens: "999", outputTokens: "999" } })
	expect(result.accounts[0].recordHashes).toEqual([])
	expect(result.unresolved).toHaveLength(1)
})

it("gives a lone message iteration the reply's model", () => {
	const response = {
		...records[2],
		nativeUsage: { ...nativeUsage, iterations: [{ type: "message", raw: { inputTokens: 12, outputTokens: 7 } }] },
	}
	const usage = build([...records.slice(0, 2), response]).accounts[0].facts.find((fact) => fact.usage)?.usage
	expect(usage?.iterations?.[0]).toMatchObject({ model: "responding" })
})

it("keeps unreported iteration models unknown and retains oversized input for later translation", () => {
	const response = {
		...records[2],
		nativeUsage: {
			...nativeUsage,
			iterations: [{ type: "fallback_message", raw: { inputTokens: 12, outputTokens: 7 } }],
		},
	}
	const single = build([...records.slice(0, 2), response]).accounts[0].facts.find((fact) => fact.usage)?.usage
	expect(single?.iterations?.[0]).not.toHaveProperty("model")
	expect(single?.actualModel).toBe("responding")
	const oversized = {
		...response,
		nativeUsage: {
			...response.nativeUsage,
			iterations: Array.from({ length: 17 }, () => response.nativeUsage.iterations[0]),
		},
	}
	const result = build([...records.slice(0, 2), oversized])
	expect(result.accounts[0].facts.find((fact) => fact.usage)?.usage).toMatchObject({
		schema: "unknown",
		raw: {},
		attemptsComplete: false,
	})
	expect(result.accounts[0].facts.find((fact) => fact.usage)?.usage).not.toHaveProperty("iterations")
	expect(result.accounts[0].recordHashes).toEqual([])
})

const dispatchedAt = "2026-10-24T08:00:01.000Z"
const billingSource = {
	apiUrl: "https://api.cast.ai",
	gatewayUrl: "https://llm.cast.ai/openai/v1/chat/completions",
	credentialHash: "a".repeat(64),
}
it.each([
	[
		"carried the gateway's billing tag",
		"castai",
		{ billingSource, billingSelector: requestTagSelector(requestId, dispatchedAt) },
	],
	["went straight to its provider", "unknown", { billingTagSkipped: "unsupported-source" }],
	["reached the gateway without its billing tag", "unknown", { billingSource, billingTagSkipped: "tag-limit" }],
])("reports a request that %s with the %s route", (_, route, billing) => {
	const dispatch = { ...records[1], dispatchedAt, ...billing }
	const usage = build([records[0], dispatch, records[2]]).accounts[0].facts.find((fact) => fact.usage)?.usage
	expect(usage?.observedRoute).toBe(route)
})

it("retains an observed dispatch with no returned usage as unknown", () => {
	const result = build(records.slice(0, 2))
	expect(result.accounts).toHaveLength(1)
	const usage = result.accounts[0].facts.find((fact) => fact.usage)
	expect(usage?.usage).toMatchObject({ requestId, schema: "unknown", raw: {}, attemptsComplete: false })
	expect(usage?.usage).not.toHaveProperty("actualModel")
})

it("keeps genuine historical bill identity without manufacturing native counters or dispatch", () => {
	const bill = "44444444-4444-4444-8444-444444444444"
	const input = structuredClone(report)
	input.requests[0].billingRecordIds = [bill]
	const result = build(records.slice(0, 1), input)
	expect(result.accounts).toHaveLength(1)
	const usage = result.accounts[0].facts.find((fact) => fact.usage)
	expect(usage?.usage).toMatchObject({
		requestId,
		schema: "unknown",
		raw: {},
		attemptsComplete: false,
		aliases: [{ namespace: "castai-request-id", id: bill, source: "telemetry" }],
	})
})

it("feeds both physical requests from an actual SDK retry into the durable common outbox", () => {
	const agent = mkdtempSync(join(tmpdir(), "kimchi-sdk-common-events-"))
	try {
		const driver = fileURLToPath(new URL("../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
		const result = JSON.parse(
			execFileSync("bun", [driver, "native-common-events", agent], { encoding: "utf8", timeout: 30_000 }),
		)
		expect(result.reopened).toBe(true)
		expect(result.calls).toHaveLength(2)
		const events = result.body.batch.events as {
			usage?: {
				requestId: string
				raw: unknown
				attemptsComplete: boolean
				iterations?: { id: string; model: string; raw: unknown }[]
				finalIterationId?: string
			}
		}[]
		const usage = events.flatMap((event) => (event.usage ? [event.usage] : []))
		expect(usage).toHaveLength(2)
		expect(usage.find((value) => value.requestId === result.calls[0].id)).toMatchObject({
			raw: {},
			schema: "unknown",
			attemptsComplete: false,
		})
		const success = usage.find((value) => value.requestId === result.calls[1].id)
		expect(success).toMatchObject({
			attemptsComplete: false,
			iterations: [
				{ model: "sdk-primary", raw: { inputTokens: "100", outputTokens: "0" } },
				{ model: "sdk-fallback", raw: { inputTokens: "90", outputTokens: "7" } },
			],
		})
		expect(success?.finalIterationId).toBe(success?.iterations?.[1].id)
		expect(result.unresolved).toEqual([])
		expect(JSON.stringify(result.body)).not.toContain("Say ok")
	} finally {
		rmSync(agent, { recursive: true, force: true })
	}
})

it("does not assign contradictory response ownership to an account", () => {
	const result = build([...records, { ...records[2], sessionId: "other-session", nativeUsage: undefined }])
	expect(result.accounts).toHaveLength(0)
	expect(result.unresolved).toHaveLength(1)
})

it("retains translation intent for evidence this builder does not understand", () => {
	const result = build([...records, { ...owner, type: "future_evidence", content: "private future evidence" }])
	expect(result.accounts[0].recordHashes).toEqual(
		records.map((_, index) => createHash("sha256").update(`original-${index}`).digest("hex")),
	)
})

it.each([
	"known",
	"unsupported",
])("stores native usage and pins its first repository in the SQLite outbox (%s)", (mode) => {
	const agent = mkdtempSync(join(tmpdir(), "kimchi-common-events-"))
	try {
		const result = JSON.parse(
			execFileSync(
				"bun",
				[
					"--eval",
					`
import {buildEvents} from ${JSON.stringify(new URL("./events.ts", import.meta.url).href)};
import {capture,readStoredRecordsAsync,closeBackends,backendFor} from ${JSON.stringify(new URL("./ledger/records.ts", import.meta.url).href)};
import {observeEvents,pendingBatch,effectiveClaim} from ${JSON.stringify(new URL("./ledger/outbox.ts", import.meta.url).href)};
import {accountKey} from ${JSON.stringify(new URL("./snapshot.ts", import.meta.url).href)};
const input=await Bun.stdin.json();
for(const row of input.records)capture(input.agent,row,input.agent+"/native-observations.jsonl");
const stored=await readStoredRecordsAsync(input.agent,()=>{});
const repositories=new Map(input.repositories);
if(input.mode==="unsupported")repositories.set(input.repositories[0][0],"unsupported");
const prior=(key,id)=>effectiveClaim(backendFor(input.agent),key,id);
const built=buildEvents(stored,input.report,repositories,input.producer,()=>{},prior);
for(const group of built.accounts)observeEvents(input.agent,accountKey(group.account),group.facts,group.recordHashes,()=>{});
const key=accountKey(input.report.requests[0].account);
const first=pendingBatch(input.agent,key,()=>{});
repositories.set(input.repositories[0][0],{...input.repositories[0][1],id:"new-remote"});
const changed=buildEvents(stored,input.report,repositories,input.producer,()=>{},prior);
for(const group of changed.accounts)observeEvents(input.agent,accountKey(group.account),group.facts,group.recordHashes,()=>{});
const current=effectiveClaim(backendFor(input.agent),key,built.accounts[0].facts.find(fact=>fact.usage).entityId);
const pending=backendFor(input.agent).pendingTranslations(0,backendFor(input.agent).recordWatermark(),100).length;
closeBackends();
const reopened=pendingBatch(input.agent,key,()=>{});
console.log(JSON.stringify({body:JSON.parse(Buffer.from(first.body).toString()),same:Buffer.from(first.body).equals(Buffer.from(reopened.body)),pending,origin:current.repository?.id??null,target:current.allocation?.targetRepository??null}));
closeBackends();
`,
				],
				{
					input: JSON.stringify({ agent, records, report, repositories, producer, mode }),
					encoding: "utf8",
					timeout: 30_000,
				},
			),
		)
		expect(result.same).toBe(true)
		expect(result.pending).toBe(0)
		expect(result.origin).toBe(mode === "known" ? "999" : null)
		expect(result.target).toBe(null)
		expect(result.body.batch.events.find((event: { usage?: unknown }) => event.usage)).toMatchObject({
			usage: { requestId, raw: { inputTokens: "12", cacheWriteTokens: "9" }, attemptsComplete: false },
		})
	} finally {
		rmSync(agent, { recursive: true, force: true })
	}
})
