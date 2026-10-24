/**
 * Bun-spawned driver for PR-cost ledger real-DB assertions. Node/vitest cannot
 * load bun:sqlite, so each command runs one scenario inside a Bun subprocess and
 * prints JSON result lines to stdout, exactly like memory-seed.ts.
 *
 *   bun tests/e2e/tui/support/ledger-driver.ts <command> <agentDir> [arg]
 *
 * Commands:
 *   probe          open the store; report user_version, tables, dir/file modes
 *   foreign-check  plant a foreign user_version, then prove openStore refuses it
 *   hold-writer    BEGIN IMMEDIATE, print {"held":true}, sleep <arg>ms, COMMIT
 *   read-only      open the store in a second process; count meta rows
 *   write-probe    try BEGIN IMMEDIATE; report acquisition or lock error + elapsed
 *   capture        capture one record JSON (<arg>) via the v2 records seam
 *   head           print the saved projection head for work <arg>
 *   rows           print the saved projection view for work <arg>
 *   listfiles      print every file path under <agentDir> (zero-write evidence)
 */

import { Database } from "bun:sqlite"
import { mkdirSync, readdirSync, readSync, statSync, writeSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { createInterface } from "node:readline"
import { importJournals } from "../../../../src/extensions/pr-cost-reporting/ledger/import.js"
import {
	capture,
	fingerprint,
	getNote,
	readRecords,
	readWorkHead,
	readWorkSummary,
} from "../../../../src/extensions/pr-cost-reporting/ledger/records.js"
import { ledgerDbPath, openStore } from "../../../../src/extensions/pr-cost-reporting/ledger/store.js"
import {
	readWorkRecords,
	readWorkRecordsAsync,
	type WorkRecord,
	type WorkRecordProblem,
} from "../../../../src/extensions/work-attribution/summary.js"

const [, , command, agentDir, arg] = process.argv

function out(value: unknown): void {
	console.log(JSON.stringify(value))
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function probe(agent: string): Promise<void> {
	const store = openStore(agent)
	const version = store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
	const tables = store.db
		.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all()
		.map((row) => row.name)
	const path = ledgerDbPath(agent)
	out({
		version,
		tables,
		dirMode: statSync(dirname(path)).mode & 0o777,
		fileMode: statSync(path).mode & 0o777,
	})
	store.close()
}

async function foreignCheck(agent: string): Promise<void> {
	const path = ledgerDbPath(agent)
	mkdirSync(dirname(path), { recursive: true })
	const plant = new Database(path, { create: true })
	plant.exec("PRAGMA user_version=777")
	plant.close()
	let refused: { opened: boolean; code?: string; name?: string }
	try {
		openStore(agent).close()
		refused = { opened: true }
	} catch (error) {
		const e = error as Error & { code?: string }
		refused = { opened: false, code: e.code, name: e.name }
	}
	const check = new Database(path)
	const version = check.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
	const tables = check
		.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'")
		.get()?.count
	check.close()
	out({ ...refused, version, tables })
}

async function holdWriter(agent: string, ms: number | "release"): Promise<void> {
	const store = openStore(agent)
	let committed = false
	try {
		store.db.exec("BEGIN IMMEDIATE")
		store.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('hold', '1')")
		out({ held: true })
		if (ms === "release") {
			const input = createInterface({ input: process.stdin })
			let released = false
			try {
				for await (const line of input) {
					if (line !== "release") continue
					released = true
					break
				}
				if (!released) throw new Error("Holder input closed before release")
			} finally {
				input.close()
			}
		} else await sleep(ms)
		store.db.exec("COMMIT")
		committed = true
		out({ held: false })
	} finally {
		if (!committed) store.db.exec("ROLLBACK")
		store.close()
	}
}

async function readOnly(agent: string): Promise<void> {
	const store = openStore(agent)
	const count = store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM meta").get()?.count ?? -1
	out({ count })
	store.close()
}

async function writeProbe(agent: string): Promise<void> {
	const started = Date.now()
	const store = openStore(agent)
	try {
		store.db.exec("BEGIN IMMEDIATE")
		store.db.exec("COMMIT")
		out({ acquired: true, elapsedMs: Date.now() - started })
	} catch (error) {
		out({ acquired: false, elapsedMs: Date.now() - started, message: String((error as Error).message ?? error) })
	} finally {
		store.close()
	}
}

async function captureRecord(agent: string, recordJson: string): Promise<void> {
	capture(agent, JSON.parse(recordJson) as WorkRecord, "ledger-driver")
	out({ captured: true, records: fingerprint(agent) })
}

async function printHead(agent: string, workId: string): Promise<void> {
	out(readWorkHead(agent, workId) ?? null)
}

async function printRows(agent: string, workId: string): Promise<void> {
	out(readWorkSummary(agent, workId) ?? null)
}

async function listFiles(agent: string): Promise<void> {
	const found: string[] = []
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name)
			if (entry.isDirectory()) walk(full)
			else if (entry.isFile()) found.push(relative(agent, full))
		}
	}
	try {
		walk(agent)
	} catch {}
	out(found.sort())
}

async function printRecords(agent: string, workId?: string): Promise<void> {
	out(readRecords(agent, workId ? { workId } : {}))
}

async function importJournalsCommand(agent: string): Promise<void> {
	out(await importJournals(agent))
}

async function nativeUsage(agent: string, anthropic = false, common = false, delivery = false): Promise<void> {
	process.env.PI_CODING_AGENT_DIR = agent
	if (delivery) {
		process.env.KIMCHI_API_KEY = "fake-reporting"
		process.env.KIMCHI_REMOTE_ENDPOINT = "https://api.cast.ai"
		process.env.KIMCHI_TELEMETRY_ENABLED = "true"
	}
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent")
	const { installGlobalFetchInstrumentation } = await import("../../../../src/http/instrument-fetch.js")
	const { getWorkId, prepareProviderRequest, recordProviderRequest, recordProviderResponse, setWorkId } = await import(
		"../../../../src/extensions/work-attribution.js"
	)
	const { withNativeUsage } = await import("../../../../src/extensions/work-attribution/native-usage.js")
	const { closeBackends } = await import("../../../../src/extensions/pr-cost-reporting/ledger/records.js")
	let sessionId = "sdk-original"
	const ctx = { cwd: agent, sessionManager: { getSessionId: () => sessionId } }
	const calls: { id: string | null; persisted: boolean }[] = []
	globalThis.fetch = async (_url, options) => {
		const id = new Headers(options?.headers).get("X-Request-Id")
		calls.push({
			id,
			persisted: readRecords(agent).some((row) => row.type === "request_dispatch" && row.requestId === id),
		})
		if (calls.length === 1) {
			sessionId = "sdk-next"
			setWorkId(ctx)
			return Response.json({ error: { message: "retry" } }, { status: 503, headers: { "Retry-After": "0" } })
		}
		if (anthropic) {
			const accounting = delivery
				? {
						service_tier: "standard",
						inference_geo: "global",
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					}
				: {}
			const events = [
				{
					type: "message_start",
					message: {
						id: "msg-sdk",
						type: "message",
						role: "assistant",
						model: "sdk-primary",
						content: [],
						stop_reason: null,
						usage: { input_tokens: 100, output_tokens: 1, ...accounting },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: {
						...accounting,
						input_tokens: 90,
						output_tokens: 7,
						iterations: [
							{ type: "message", model: "sdk-primary", input_tokens: 100, output_tokens: 0, ...accounting },
							{ type: "fallback_message", model: "sdk-fallback", input_tokens: 90, output_tokens: 7, ...accounting },
						],
					},
				},
				{ type: "message_stop" },
			]
			return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "Content-Type": "text/event-stream" },
			})
		}
		return new Response(
			`data: ${JSON.stringify({
				id: "chat-sdk",
				model: "sdk-responding",
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
			})}\n\ndata: ${JSON.stringify({
				id: "chat-sdk",
				model: "sdk-responding",
				choices: [],
				usage: { prompt_tokens: 100, completion_tokens: 7 },
			})}\n\ndata: [DONE]\n\n`,
			{ headers: { "Content-Type": "text/event-stream" } },
		)
	}
	installGlobalFetchInstrumentation({
		userAgent: "native-usage-test",
		onModelRequest: prepareProviderRequest,
		onModelResponse: recordProviderResponse,
	})
	const runtime = await withNativeUsage(ModelRuntime.create.bind(ModelRuntime))({
		authPath: join(agent, "auth.json"),
		modelsPath: join(agent, "models.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	})
	const provider = common ? "anthropic" : "native-test"
	runtime.registerProvider(provider, {
		api: anthropic ? "anthropic-messages" : "openai-completions",
		baseUrl: "https://native.invalid/v1",
		models: [
			{
				id: "requested",
				name: "requested",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10000,
				maxTokens: 1000,
			},
		],
	})
	await runtime.setRuntimeApiKey(provider, "fake")
	await runtime.refresh({ allowNetwork: false })
	const model = runtime.getModel(provider, "requested")
	if (!model) throw new Error("Missing registered native model")
	if (common) {
		const { saveNewWorkScope } = await import("../../../../src/extensions/work-attribution/scope.js")
		saveNewWorkScope(getWorkId(ctx), {
			repository: agent,
			account: {
				apiUrl: "https://api.cast.ai",
				organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			},
		})
	}
	const original = recordProviderRequest(ctx, model)
	const message = await runtime.completeSimple(
		model,
		{ messages: [{ role: "user", content: "Say ok", timestamp: Date.now() }] },
		{
			maxRetries: 1,
			maxRetryDelayMs: 1,
			transformHeaders: (headers) => ({ ...headers, "X-Request-Id": original.requestId }),
		},
	)
	closeBackends()
	const captured = readRecords(agent).filter((row) => row.nativeUsage)
	if (delivery) {
		await nativeDelivery(agent)
		return
	}
	if (common) {
		const { buildEvents } = await import("../../../../src/extensions/pr-cost-reporting/events.js")
		const { backendFor, readStoredRecordsAsync } = await import(
			"../../../../src/extensions/pr-cost-reporting/ledger/records.js"
		)
		const { effectiveClaim, observeEvents, pendingBatch } = await import(
			"../../../../src/extensions/pr-cost-reporting/ledger/outbox.js"
		)
		const { accountKey } = await import("../../../../src/extensions/pr-cost-reporting/snapshot.js")
		const { readWorkCostReport } = await import("../../../../src/extensions/work-attribution/cost-sync.js")
		const stored = await readStoredRecordsAsync(agent, () => {})
		const { report } = readWorkCostReport(
			agent,
			stored.map((row) => JSON.parse(row.body)),
		)
		const producer = "33333333-3333-4333-8333-333333333333"
		const built = buildEvents(
			stored,
			report,
			new Map([[agent, { provider: "github", host: "github.com", id: "999", name: "fork/repo" }]]),
			producer,
			() => {},
			(key, id) => effectiveClaim(backendFor(agent), key, id),
		)
		for (const group of built.accounts)
			observeEvents(agent, accountKey(group.account), group.facts, group.recordHashes, () => {})
		if (built.accounts.length !== 1) throw new Error("Missing original SDK reporting account")
		const key = accountKey(built.accounts[0].account)
		const first = pendingBatch(agent, key, () => {})
		if (!first) throw new Error("Missing native SDK delta batch")
		closeBackends()
		const reopened = pendingBatch(agent, key, () => {})
		if (!reopened) throw new Error("Missing reopened native SDK delta batch")
		out({
			original,
			calls,
			captured,
			body: JSON.parse(Buffer.from(first.body).toString()),
			reopened: Buffer.from(first.body).equals(Buffer.from(reopened.body)),
			unresolved: built.unresolved,
		})
		closeBackends()
		return
	}
	out({ original, calls, stopReason: message.stopReason, captured })
	closeBackends()
}

async function nativeDelivery(agent: string): Promise<void> {
	const { isWorkScope } = await import("../../../../src/extensions/work-attribution/scope.js")
	const request = readRecords(agent).find((row) => row.type === "request" && isWorkScope(row.scope))
	if (
		!request ||
		!isWorkScope(request.scope) ||
		typeof request.requestId !== "string" ||
		typeof request.startedAt !== "string"
	)
		throw new Error("Missing original native scope")
	const account = request.scope.account
	const { backendFor, closeBackends } = await import("../../../../src/extensions/pr-cost-reporting/ledger/records.js")
	const { deliverEvents, reconcileReporting } = await import("../../../../src/extensions/pr-cost-reporting/worker.js")
	const { pendingBatch, observeEvents } = await import("../../../../src/extensions/pr-cost-reporting/ledger/outbox.js")
	const { accountKey } = await import("../../../../src/extensions/pr-cost-reporting/snapshot.js")
	const { queueSnapshots, readReportingState, setReportingEnabled } = await import(
		"../../../../src/extensions/pr-cost-reporting/queue.js"
	)
	const key = accountKey(account)
	const check = () => {}
	const posts: { url: string; body: string }[] = []
	let mode = "success"
	let redirected = false
	let legacyInterleaved = false
	let racedLegacy = false
	let abandonedSignal: AbortSignal | null | undefined
	globalThis.fetch = async (input, init) => {
		const url = String(input)
		redirected ||= init?.redirect !== "error"
		if (url.endsWith("api-keys:verify")) {
			if (mode === "key-change") process.env.KIMCHI_API_KEY = "changed-key"
			return Response.json({
				organizationId: account.organizationId,
				userId: mode === "other-user" ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc" : account.userId,
			})
		}
		if (!url.startsWith(account.apiUrl)) throw new Error("Unexpected network destination")
		const body = String(init?.body)
		posts.push({ url, body })
		const parsed = JSON.parse(body)
		if (url.endsWith("pr-cost-snapshots"))
			return Response.json({ status: "accepted", revision: parsed.revision, receivedAt: new Date().toISOString() })
		if (!url.endsWith("pr-cost-events:batchIngest")) throw new Error("Unexpected reporting route")
		if (mode === "lease-loss") {
			abandonedSignal = init?.signal
			return new Promise((_resolve, reject) => {
				abandonedSignal?.addEventListener("abort", () => reject(new Error("aborted held upload")), { once: true })
			})
		}
		if (mode === "interleave" && legacyInterleaved) racedLegacy = true
		if (mode === "lost") throw new Error("ACK lost")
		if (mode === "invalid") return Response.json({ batchId: "wrong", receipts: [] })
		if (mode === "off") await setReportingEnabled(agent, false)
		return Response.json({
			batchId: parsed.batch.id,
			generation: "1",
			receiveTime: new Date().toISOString(),
			receipts: parsed.batch.events.map(({ id, revision }: { id: string; revision: string }) => ({
				id,
				revision,
				status: "accepted",
			})),
		})
	}
	await setReportingEnabled(agent, true)
	await queueSnapshots(agent, [
		{
			account,
			content: {
				repository: { provider: "github", host: "github.com", id: "999" },
				pullRequests: [],
				requests: [
					{
						requestId: request.requestId,
						startedAt: request.startedAt,
						billingRecordIds: [],
						allocation: { kind: "unlinked", pullRequestIds: [], method: "native" },
					},
				],
				coverage: { observedRequests: 1, unpricedRequests: 1, historyComplete: true },
			},
		},
	])
	const originalLegacy = JSON.stringify(Object.values((await readReportingState(agent)).entries)[0].pending)
	await reconcileReporting(agent, agent, new AbortController().signal, check)
	const initial = posts.filter((post) => post.url.endsWith("pr-cost-events:batchIngest"))
	const initialEvents = initial.flatMap((post) => JSON.parse(post.body).batch.events)
	const after = await readReportingState(agent)
	const initialPending = backendFor(agent).pendingOutboxEvents(key, 1000).length
	const capturedByWorker = initialEvents.filter((event: { usage?: object }) => event.usage)
	const run = () => deliverEvents(agent, agent, new AbortController().signal, check)
	const seed = () =>
		observeEvents(
			agent,
			key,
			[
				{
					entityId: crypto.randomUUID(),
					source: "kimchi",
					sourceVersion: "test",
					deviceId: request.workId,
					observeTime: new Date().toISOString(),
					coverage: { code: "fixture", count: "1" },
				},
			],
			[],
			check,
		)
	const body = () => {
		const batch = pendingBatch(agent, key, check)
		if (!batch) throw new Error("Missing pending worker batch")
		return Buffer.from(batch.body).toString()
	}
	seed()
	mode = "lost"
	await run()
	const lostBody = body()
	closeBackends()
	const reopened = body() === lostBody
	const attempts = posts.length
	mode = "success"
	await run()
	const backoff = posts.length === attempts && body() === lostBody
	const retry = JSON.parse(backendFor(agent).getNote("pr-cost-delivery", key) ?? "null")
	const clock = Date.now
	Date.now = () => retry.retryAt + 1
	try {
		await run()
	} finally {
		Date.now = clock
	}
	const replayed = posts.at(-1)?.body === lostBody && !backendFor(agent).getOutboxBatch(key)
	seed()
	mode = "invalid"
	await run()
	const invalidBody = body()
	mode = "success"
	await setReportingEnabled(agent, true)
	await run()
	const invalidAckRetained = posts.at(-1)?.body === invalidBody && !backendFor(agent).getOutboxBatch(key)
	seed()
	mode = "off"
	await run()
	const offBody = body()
	mode = "success"
	await setReportingEnabled(agent, true)
	await run()
	const optOutRetained = posts.at(-1)?.body === offBody && !backendFor(agent).getOutboxBatch(key)
	seed()
	const originalBody = body()
	mode = "other-user"
	const beforeOther = posts.length
	await run()
	const accountFenced = posts.length === beforeOther && body() === originalBody
	mode = "key-change"
	let keyFenced = false
	try {
		await run()
	} catch {
		keyFenced = posts.length === beforeOther && body() === originalBody
	}
	process.env.KIMCHI_API_KEY = "fake-reporting"
	mode = "success"
	await run()
	const { readFileSync, writeFileSync, existsSync } = await import("node:fs")
	const { lockSync } = await import("proper-lockfile")
	const queueDirectory = join(agent, "pr-cost-reporting")
	const statePath = join(queueDirectory, "state.json")
	const drainedState = readFileSync(statePath)
	await queueSnapshots(agent, [
		{
			account,
			content: {
				repository: { provider: "github", host: "github.com", id: "999" },
				pullRequests: [],
				requests: [
					{
						requestId: crypto.randomUUID(),
						startedAt: new Date().toISOString(),
						billingRecordIds: [],
						allocation: { kind: "unlinked", pullRequestIds: [], method: "native" },
					},
				],
				coverage: { observedRequests: 1, unpricedRequests: 1, historyComplete: true },
			},
		},
	])
	const oldWriterState = readFileSync(statePath)
	writeFileSync(statePath, drainedState)
	seed()
	const backend = backendFor(agent)
	const readPage = backend.readNotePage.bind(backend)
	let scans = 0
	let armed = false
	backend.readNotePage = (...args) => {
		const page = readPage(...args)
		if (args[0] === "legacy-pr-cost-snapshots" && !page.length && ++scans === 2) armed = true
		return page
	}
	mode = "interleave"
	try {
		await deliverEvents(agent, agent, new AbortController().signal, () => {
			if (!armed || legacyInterleaved || existsSync(`${queueDirectory}.lock`)) return
			const release = lockSync(queueDirectory)
			try {
				writeFileSync(statePath, oldWriterState)
			} finally {
				release()
			}
			legacyInterleaved = true
		})
	} finally {
		backend.readNotePage = readPage
	}
	mode = "success"
	const { deliverSnapshots } = await import("../../../../src/extensions/pr-cost-reporting/worker.js")
	await deliverSnapshots(agent, agent, new AbortController().signal, check)
	await run()
	seed()
	const abandonedBody = body()
	mode = "lease-loss"
	try {
		await deliverEvents(agent, agent, new AbortController().signal, () => {
			if (abandonedSignal) throw new Error("lease lost after dispatch")
		})
	} catch {}
	const failedPassAborted = abandonedSignal?.aborted === true
	const abandonedRetained = body() === abandonedBody
	mode = "success"
	await run()
	out({
		capturedByWorker,
		initialBody: initial[0]?.body,
		initialPending,
		legacyExact: posts[0]?.body === originalLegacy,
		legacyFirst: posts[0]?.url.endsWith("pr-cost-snapshots"),
		noNewLegacy: Object.values(after.entries).every((entry) => entry.revision === "1" && !entry.pending),
		reopened,
		backoff,
		replayed,
		invalidAckRetained,
		optOutRetained,
		accountFenced,
		keyFenced,
		legacyBoundary: legacyInterleaved && !racedLegacy,
		failedPassAborted,
		abandonedRetained,
		redirectsRejected: !redirected,
		finalPending: backendFor(agent).pendingOutboxEvents(key, 1000).length,
	})
	closeBackends()
}

async function readWorkRecordsCommand(agent: string): Promise<void> {
	out(readWorkRecords(agent))
}

async function legacyFreezeScenario(agent: string): Promise<void> {
	const { readFileSync, writeFileSync } = await import("node:fs")
	const {
		acknowledgeFrozenSnapshot,
		freezeSnapshots,
		pendingFrozenSnapshots,
		queueSnapshots,
		readReportingState,
		reportingStatePath,
		setReportingEnabled,
	} = await import("../../../../src/extensions/pr-cost-reporting/queue.js")
	const { backendFor, closeBackends } = await import("../../../../src/extensions/pr-cost-reporting/ledger/records.js")
	const check = () => {}
	const path = reportingStatePath(agent)
	const originalState = readFileSync(path)
	const initial = Object.values((await readReportingState(agent)).entries)[0]
	if (!initial.pending) throw new Error("Missing original legacy fixture")
	const originalBody = JSON.stringify(initial.pending)
	const all = () => pendingFrozenSnapshots(agent, check, Date.now() + 30_000)
	await freezeSnapshots(agent, check)
	const [first] = await all()
	if (!first || first.body !== originalBody) throw new Error("Legacy bytes changed during freeze")
	const backend = backendFor(agent)
	const remove = backend.deleteNote.bind(backend)
	let removed = false
	backend.deleteNote = (workId, name) => {
		remove(workId, name)
		removed = true
		throw new Error("after actual pending deletion")
	}
	let rejected = false
	try {
		await acknowledgeFrozenSnapshot(
			agent,
			first,
			{ status: "accepted", revision: "1", receivedAt: new Date().toISOString() },
			check,
		)
	} catch (error) {
		rejected = error instanceof Error && error.message === "after actual pending deletion"
	} finally {
		backend.deleteNote = remove
	}
	const ackRollback =
		removed &&
		rejected &&
		(await all())[0]?.body === originalBody &&
		backend.readNotePage("legacy-pr-cost-snapshot-receipts", "", 64).length === 0
	if (!ackRollback) throw new Error("Frozen ACK did not roll back")
	await acknowledgeFrozenSnapshot(
		agent,
		first,
		{ status: "accepted", revision: "1", receivedAt: new Date().toISOString() },
		check,
	)
	const receipt = backend.getNote("legacy-pr-cost-snapshot-receipts", first.id)
	if (receipt === undefined) throw new Error("Missing completed legacy receipt")
	const { ack: _ack, ...invalidReceipt } = JSON.parse(receipt)
	backend.putNote("legacy-pr-cost-snapshot-receipts", first.id, JSON.stringify(invalidReceipt))
	writeFileSync(path, originalState)
	let receiptCorruptionRejected = false
	try {
		await freezeSnapshots(agent, check)
	} catch {
		receiptCorruptionRejected = readFileSync(path).equals(originalState)
	}
	backend.putNote("legacy-pr-cost-snapshot-receipts", first.id, receipt)
	await freezeSnapshots(agent, check)
	const cleanupReplay =
		(await all()).length === 0 && !Object.values((await readReportingState(agent)).entries)[0].pending
	for (let index = 0; index < 20; index++) {
		await queueSnapshots(agent, [
			{
				account: initial.account,
				content: {
					repository: initial.pending.repository,
					pullRequests: initial.pending.pullRequests,
					coverage: initial.pending.coverage,
					requests: initial.pending.requests.map((request) => ({
						...request,
						allocation: { ...request.allocation, kind: index % 2 ? "unlinked" : "unknown" },
					})),
				},
			},
		])
		await freezeSnapshots(agent, check)
	}
	const [partial] = await pendingFrozenSnapshots(agent, check, Date.now() - 1)
	closeBackends()
	const [next] = await pendingFrozenSnapshots(agent, check, Date.now() - 1)
	const partialScanProgress = !!partial && !!next && partial.id !== next.id
	const pending = await all()
	if (pending.length !== 20) throw new Error(`Expected twenty frozen versions, got ${pending.length}`)
	const latest = pending.reduce((a, b) => (BigInt(a.entry.revision) > BigInt(b.entry.revision) ? a : b))
	for (const frozen of pending) {
		if (frozen.id === latest.id) continue
		await acknowledgeFrozenSnapshot(
			agent,
			frozen,
			{
				status: "accepted",
				revision: frozen.entry.revision,
				receivedAt: new Date().toISOString(),
			},
			check,
		)
	}
	const reopened = backendFor(agent)
	const page = reopened.readNotePage.bind(reopened)
	const namespaces: string[] = []
	reopened.readNotePage = (workId, after, limit) => {
		namespaces.push(workId)
		return page(workId, after, limit)
	}
	await setReportingEnabled(agent, true)
	const resumeScans = namespaces.length
	const remaining = await all()
	const receiptScan = namespaces.some((name) => name === "legacy-pr-cost-snapshot-receipts")
	reopened.readNotePage = page
	const receipts = page("legacy-pr-cost-snapshot-receipts", "", 64)
	const archived = receipts.map((row) => JSON.parse(row.body))
	out({
		initialBytes: first.body === originalBody,
		ackRollback,
		receiptCorruptionRejected,
		cleanupReplay,
		partialScanProgress,
		retainedReceipts: receipts.length,
		archivedOriginalBytes: archived.some((row) => row.body === originalBody),
		pendingAfterArchive: remaining.length,
		latestRetained: remaining[0]?.body === latest.body,
		receiptScan,
		resumeScans,
		reopened: true,
	})
	closeBackends()
}

async function producerScenario(agent: string): Promise<void> {
	const { readReportingState, reportingProducer } = await import(
		"../../../../src/extensions/pr-cost-reporting/queue.js"
	)
	const { backendFor, closeBackends } = await import("../../../../src/extensions/pr-cost-reporting/ledger/records.js")
	const { observeEvents, pendingBatch } = await import("../../../../src/extensions/pr-cost-reporting/ledger/outbox.js")
	const { machineFingerprint } = await import("../../../../src/extensions/pr-cost-reporting/machine.js")
	const { accountKey } = await import("../../../../src/extensions/pr-cost-reporting/snapshot.js")
	const state = await readReportingState(agent)
	const entry = Object.values(state.entries)[0]
	if (!entry?.pending) throw new Error("Missing legacy pending producer fixture")
	const account = accountKey(entry.account)
	const current = () => {}
	observeEvents(
		agent,
		account,
		[
			{
				entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				source: "kimchi",
				sourceVersion: "test",
				deviceId: state.producerId,
				observeTime: "2026-10-24T00:00:00Z",
				coverage: { code: "observed", count: "1" },
			},
		],
		[],
		current,
	)
	const frozen = pendingBatch(agent, account, current)
	if (!frozen) throw new Error("Missing frozen producer fixture")
	const producerId = await reportingProducer(agent, current)
	const pending = pendingBatch(agent, account, current)
	out({
		producerId,
		machineKnown: !!(await machineFingerprint()),
		note: JSON.parse(backendFor(agent).getNote("agent", "reporting-producer") ?? "null"),
		legacyRetained: JSON.stringify(await readReportingState(agent)) === JSON.stringify(state),
		batchRetained: pending?.id === frozen.id && sameBytes(pending.body, frozen.body),
		frozenProducer: JSON.parse(Buffer.from(frozen.body).toString("utf8")).batch.events[0].deviceId,
	})
	closeBackends()
}

async function outboxScenario(agent: string, mode: string): Promise<void> {
	const { observeEvents, pendingBatch, acknowledgeBatch } = await import(
		"../../../../src/extensions/pr-cost-reporting/ledger/outbox.js"
	)
	const { backendFor, closeBackends, recordHashOf, useBackendFactory } = await import(
		"../../../../src/extensions/pr-cost-reporting/ledger/records.js"
	)
	const { createMemoryRecords } = await import("../../../../src/extensions/pr-cost-reporting/ledger/memory-records.js")
	const { encodeBatch, eventHash } = await import("../../../../src/extensions/pr-cost-reporting/protocol.js")
	if (mode === "memory") useBackendFactory(() => createMemoryRecords())
	const backend = backendFor(agent)
	const required = <T>(value: T | undefined): T => {
		if (value === undefined) throw new Error("Missing outbox test row")
		return value
	}
	const fence = () => {}
	const fact = {
		entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		source: "codex",
		sourceVersion: "test",
		deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		observeTime: "2026-10-24T00:00:00.123456789Z",
		coverage: { code: "observed", count: "1" },
	}
	const record: WorkRecord = {
		version: 1,
		type: "request_response",
		workId: "11111111-1111-4111-8111-111111111111",
		requestId: "22222222-2222-4222-8222-222222222222",
		sessionId: "original-session",
		recordedAt: fact.observeTime,
	}
	capture(agent, record, "outbox-test")
	const hash = recordHashOf(record)
	observeEvents(agent, "account-a", [fact], [hash], fence)
	const first = required(backend.latestOutboxEvent("account-a", fact.entityId))
	observeEvents(agent, "account-a", [{ ...fact, observeTime: "2026-10-24T01:00:00Z" }], [], fence)
	const noOp = backend.latestOutboxEvent("account-a", fact.entityId)?.id === first.id
	observeEvents(agent, "account-a", [{ ...fact, coverage: { code: "observed", count: "2" } }], [], fence)
	const second = required(backend.latestOutboxEvent("account-a", fact.entityId))
	observeEvents(agent, "account-b", [fact], [], fence)
	const other = required(backend.latestOutboxEvent("account-b", fact.entityId))
	const parse = (body: Uint8Array) => JSON.parse(Buffer.from(body).toString("utf8"))
	const one = parse(first.body)
	const two = parse(second.body)
	const frozen = required(pendingBatch(agent, "account-a", fence))
	const detachedEvent = required(backend.getOutboxEvent("account-a", first.id))
	detachedEvent.body[0] = 0
	const detachedBatch = required(backend.getOutboxBatch("account-a"))
	detachedBatch.body[0] = 0
	detachedBatch.eventIds[0] = "changed"
	const byteIsolation =
		sameBytes(required(backend.getOutboxEvent("account-a", first.id)).body, first.body) &&
		sameBytes(required(backend.getOutboxBatch("account-a")).body, frozen.body) &&
		required(backend.getOutboxBatch("account-a")).eventIds[0] === frozen.eventIds[0]
	backend.insertOutboxBatch({ ...frozen, id: "order-a", accountKey: "ordering", orderKey: "a" })
	backend.insertOutboxBatch({ ...frozen, id: "order-Z", accountKey: "ordering", orderKey: "Z" })
	const binaryBatchOrder = backend.getOutboxBatch("ordering")?.id === "order-Z"
	const ack = (batch: typeof frozen) => ({
		batchId: batch.id,
		receipts: parse(batch.body).batch.events.map((event: { id: string; revision: string }) => ({
			id: event.id,
			revision: event.revision,
			status: "accepted",
		})),
	})
	const same = (left: Uint8Array, right: Uint8Array) => Buffer.from(left).equals(Buffer.from(right))
	const rejects = (operation: () => unknown) => {
		try {
			operation()
			return false
		} catch {
			return true
		}
	}
	const corrupted = parse(frozen.body).batch
	corrupted.events[0].coverage.count = "99"
	const getBatch = backend.getOutboxBatch.bind(backend)
	backend.getOutboxBatch = (account) =>
		account === "account-a"
			? { ...frozen, body: Buffer.from(`{"batch":${encodeBatch(corrupted)}}`) }
			: getBatch(account)
	const corruptedEventRejected = rejects(() => pendingBatch(agent, "account-a", fence))
	const badBatchIdentity = { ...parse(frozen.body).batch, id: "invalid-batch" }
	backend.getOutboxBatch = (account) =>
		account === "account-a"
			? { ...frozen, id: badBatchIdentity.id, body: Buffer.from(`{"batch":${encodeBatch(badBatchIdentity)}}`) }
			: getBatch(account)
	const corruptionRejected = corruptedEventRejected && rejects(() => pendingBatch(agent, "account-a", fence))
	backend.getOutboxBatch = getBatch
	const usage = {
		channel: "native",
		counterScope: "request",
		observedRoute: "unknown",
		schema: "unknown",
		billingBasis: "unknown",
		correlation: "exact",
		raw: {},
		attemptsComplete: true,
	}
	const badFacts = [
		{ ...fact, coverage: { ...fact.coverage, windowStartTime: "0000-01-01T00:00:00Z" } },
		{ ...fact, entityId: "not-a-uuid" },
		{ ...fact, deviceId: "not-a-uuid" },
		{ ...fact, observeTime: "1969-12-31T23:59:59Z" },
		{ ...fact, observeTime: new Date(Date.now() + 3_600_000).toISOString() },
		{ ...fact, coverage: undefined, usage: { ...usage, iterations: [{ id: "", schema: "unknown", raw: {} }] } },
		{
			...fact,
			coverage: undefined,
			usage: {
				...usage,
				iterations: [
					{ id: "one", schema: "unknown", raw: {} },
					{ id: "one", schema: "unknown", raw: {} },
				],
			},
		},
		{ ...fact, coverage: undefined, usage: { ...usage, finalIterationId: "missing" } },
		{
			...fact,
			coverage: undefined,
			usage: { ...usage, iterations: [{ id: "one", schema: "unknown", raw: {} }], finalIterationId: "missing" },
		},
		{
			...fact,
			coverage: undefined,
			usage: {
				...usage,
				raw: {
					cacheWrites: [
						{ ttlSeconds: 300, tokens: "600000000000" },
						{ ttlSeconds: 3600, tokens: "600000000000" },
					],
				},
			},
		},
		{
			...fact,
			coverage: undefined,
			usage: {
				...usage,
				schema: "openai-responses-v1",
				raw: { inputTokens: "10", cacheReadTokens: "10", cacheWriteTokens: "1" },
			},
		},
		{
			...fact,
			coverage: undefined,
			usage: {
				...usage,
				iterations: [
					{
						id: "one",
						schema: "openai-chat-completions-v1",
						raw: { inputTokens: "10", cacheReadTokens: "10", cacheWriteTokens: "1" },
					},
				],
			},
		},
	]
	const admissionRejected =
		badFacts.every((event) => rejects(() => observeEvents(agent, "admission", [event], [], fence))) &&
		backend.pendingOutboxEvents("admission", 100).length === 0
	observeEvents(
		agent,
		"supplemental",
		[
			{
				...fact,
				coverage: undefined,
				usage: {
					...usage,
					counterScope: "cumulative",
					iterations: [
						{ id: "same", schema: "unknown", raw: {} },
						{ id: "same", schema: "unknown", raw: {} },
					],
				},
			},
		],
		[],
		fence,
	)
	const cumulativePreserved = backend.pendingOutboxEvents("supplemental", 100).length === 1
	const claim = {
		...fact,
		source: "kimchi",
		observeTime: "2026-10-23T10:00:00Z",
		coverage: undefined,
		repository: { provider: "github", host: "github.com", id: "repo-one" },
		usage: { ...usage, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
		allocation: { kind: "unlinked", method: "native" },
	}
	observeEvents(agent, "claims", [claim], [], fence)
	observeEvents(
		agent,
		"claims",
		[
			{
				...claim,
				observeTime: "2026-10-23T12:00:00Z",
				allocation: undefined,
				usage: { ...claim.usage, actualModel: "first-model" },
			},
		],
		[],
		fence,
	)
	observeEvents(
		agent,
		"claims",
		[
			{
				...claim,
				observeTime: "2026-10-23T13:00:00Z",
				allocation: undefined,
				startedAt: "2026-10-23T11:00:00+01:00",
				usage: { ...claim.usage, actualModel: "first-model" },
			},
		],
		[],
		fence,
	)
	const receipt = {
		id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
		revision: 1,
		recordedAt: "2026-10-23T12:00:00Z",
		source: "work-command",
	}
	const allocated = {
		...claim,
		observeTime: "2026-10-23T14:00:00Z",
		correction: receipt,
		allocation: { kind: "pull-request", pullRequestIds: ["pr-one"], method: "user-correction" },
		claimState: "active",
	}
	observeEvents(agent, "claims", [allocated], [], fence)
	const metadata = {
		...claim,
		observeTime: "2026-10-23T15:00:00Z",
		allocation: undefined,
		usage: { ...claim.usage, actualModel: "later-model" },
	}
	observeEvents(agent, "claims", [metadata], [], fence)
	observeEvents(
		agent,
		"claims",
		[{ ...metadata, observeTime: "2026-10-23T16:00:00Z", startedAt: claim.observeTime }],
		[],
		fence,
	)
	const afterOmission = required(backend.latestOutboxEvent("claims", claim.entityId))
	const claimInheritance =
		parse(afterOmission.body).startedAt === claim.observeTime &&
		!Object.hasOwn(parse(afterOmission.body), "correction") &&
		!Object.hasOwn(parse(afterOmission.body), "allocation")
	const corrected = {
		...allocated,
		observeTime: "2026-10-23T17:00:00Z",
		startedAt: claim.observeTime,
		correction: { ...receipt, revision: 2 },
		allocation: { ...allocated.allocation, pullRequestIds: ["pr-two"] },
	}
	observeEvents(agent, "claims", [corrected], [], fence)
	const badClaims = [
		{ ...corrected, source: "claude-code" },
		{ ...corrected, usage: { ...corrected.usage, requestId: "11111111-1111-4111-8111-111111111111" } },
		{ ...corrected, deviceId: "11111111-1111-4111-8111-111111111111" },
		{ ...corrected, repository: { ...corrected.repository, id: "other-repo" } },
		{ ...corrected, startedAt: "2026-10-23T15:00:00Z" },
		{ ...corrected, allocation: { ...corrected.allocation, pullRequestIds: ["pr-three"] }, correction: undefined },
		{ ...corrected, claimState: "retracted" },
		{ ...corrected, correction: receipt },
		{ ...corrected, correction: { ...receipt, revision: 3, recordedAt: "2026-10-23T11:59:59Z" } },
		{ ...corrected, correction: { ...receipt, id: "11111111-1111-4111-8111-111111111111", revision: 3 } },
		{
			...corrected,
			correction: { ...receipt, revision: 3, recordedAt: new Date(Date.now() + 3_600_000).toISOString() },
		},
	]
	const claimUpdateRejected = badClaims.every((candidate) =>
		rejects(() => observeEvents(agent, "claims", [candidate], [], fence)),
	)
	const nextReceipt = {
		...corrected,
		correction: {
			...receipt,
			id: "11111111-1111-4111-8111-111111111111",
			recordedAt: "2026-10-23T12:00:00.000000001Z",
		},
		repository: { ...claim.repository, name: "renamed" },
	}
	observeEvents(agent, "claims", [nextReceipt], [], fence)
	const correctionProgression =
		parse(required(backend.latestOutboxEvent("claims", claim.entityId)).body).correction.id ===
		nextReceipt.correction.id
	const target = { provider: "github", host: "github.com", id: "parent-repo", name: "parent/repo" }
	const targetClaim = { ...allocated, allocation: { ...allocated.allocation, targetRepository: target } }
	observeEvents(agent, "target-claims", [targetClaim], [], fence)
	const renamedTarget = {
		...targetClaim,
		allocation: { ...targetClaim.allocation, targetRepository: { ...target, name: "renamed/repo" } },
	}
	observeEvents(agent, "target-claims", [renamedTarget], [], fence)
	observeEvents(
		agent,
		"target-claims",
		[{ ...renamedTarget, allocation: undefined, usage: { ...claim.usage, responseId: "target-metadata" } }],
		[],
		fence,
	)
	const targetChangeRejected = rejects(() =>
		observeEvents(
			agent,
			"target-claims",
			[
				{
					...renamedTarget,
					allocation: { ...renamedTarget.allocation, targetRepository: { ...target, id: "other-parent" } },
				},
			],
			[],
			fence,
		),
	)
	const targetDefaultRejected = rejects(() =>
		observeEvents(agent, "target-claims", [{ ...renamedTarget, allocation: allocated.allocation }], [], fence),
	)
	const newerTarget = {
		...renamedTarget,
		correction: { ...receipt, revision: 2 },
		allocation: { ...renamedTarget.allocation, targetRepository: { ...target, id: "other-parent" } },
	}
	observeEvents(agent, "target-claims", [newerTarget], [], fence)
	const claimTargetIdentity =
		targetChangeRejected &&
		targetDefaultRejected &&
		parse(required(backend.latestOutboxEvent("target-claims", claim.entityId)).body).allocation.targetRepository.id ===
			"other-parent"
	observeEvents(agent, "default-target", [allocated], [], fence)
	observeEvents(
		agent,
		"default-target",
		[
			{
				...allocated,
				allocation: { ...allocated.allocation, targetRepository: { ...claim.repository, name: "renamed/fork" } },
			},
		],
		[],
		fence,
	)
	observeEvents(agent, "default-target", [allocated], [], fence)
	observeEvents(agent, "native-claim", [{ ...claim, allocation: undefined }], [], fence)
	const noNativeUpgrade = rejects(() => observeEvents(agent, "native-claim", [claim], [], fence))
	const validAck = ack(frozen)
	const badAcks = [
		{ ...validAck, batchId: "other-batch" },
		{ ...validAck, receipts: validAck.receipts.slice(1) },
		{ ...validAck, receipts: [validAck.receipts[0], validAck.receipts[0]] },
		{ ...validAck, receipts: validAck.receipts.map((receipt: object) => ({ ...receipt, revision: "999" })) },
		{ ...validAck, receipts: validAck.receipts.map((receipt: object) => ({ ...receipt, status: "stale" })) },
	]
	const invalidAckRetained =
		badAcks.every((response) => rejects(() => acknowledgeBatch(agent, "account-a", frozen, response, fence))) &&
		rejects(() => acknowledgeBatch(agent, "account-b", frozen, validAck, fence)) &&
		same(required(pendingBatch(agent, "account-a", fence)).body, frozen.body)
	const changed = { ...record, recordedAt: "2026-10-24T02:00:00Z" }
	capture(agent, changed, "outbox-test")
	const changedHash = recordHashOf(changed)
	const clear = backend.clearTranslation.bind(backend)
	backend.clearTranslation = (id) => {
		clear(id)
		throw new Error("after marker removal")
	}
	const failedObservation = rejects(() =>
		observeEvents(agent, "account-a", [{ ...fact, coverage: { code: "observed", count: "3" } }], [changedHash], fence),
	)
	backend.clearTranslation = clear
	const observationRollback =
		failedObservation &&
		backend.latestOutboxEvent("account-a", fact.entityId)?.id === second.id &&
		backend.pendingTranslations(0, backend.recordWatermark(), 100).some((row) => row.recordHash === changedHash)
	observeEvents(agent, "account-a", [{ ...fact, coverage: { code: "observed", count: "3" } }], [changedHash], fence)
	const third = required(backend.latestOutboxEvent("account-a", fact.entityId))
	const frozenReplay =
		same(required(pendingBatch(agent, "account-a", fence)).body, frozen.body) &&
		parse(frozen.body).batch.events.length === 2
	const markAck = backend.ackOutboxEvent.bind(backend)
	backend.ackOutboxEvent = (...args) => {
		markAck(...args)
		throw new Error("after event ACK")
	}
	const failedAck = rejects(() => acknowledgeBatch(agent, "account-a", frozen, validAck, fence))
	backend.ackOutboxEvent = markAck
	const ackRollback =
		failedAck &&
		backend.pendingOutboxEvents("account-a", 100).length === 3 &&
		same(required(pendingBatch(agent, "account-a", fence)).body, frozen.body)
	const paused = () => {
		throw new Error("lease or account changed")
	}
	const leasePause =
		rejects(() => acknowledgeBatch(agent, "account-a", frozen, validAck, paused)) &&
		rejects(() =>
			observeEvents(agent, "account-a", [{ ...fact, coverage: { code: "observed", count: "4" } }], [], paused),
		) &&
		same(required(pendingBatch(agent, "account-a", fence)).body, frozen.body)
	acknowledgeBatch(agent, "account-a", frozen, validAck, fence)
	const insert = backend.insertOutboxBatch.bind(backend)
	backend.insertOutboxBatch = (batch) => {
		insert(batch)
		throw new Error("after batch insert")
	}
	const failedBatch = rejects(() => pendingBatch(agent, "account-a", fence))
	backend.insertOutboxBatch = insert
	const batchRollback =
		failedBatch && !backend.getOutboxBatch("account-a") && backend.pendingOutboxEvents("account-a", 100).length === 1
	const next = required(pendingBatch(agent, "account-a", fence))
	const oldAckRetainedNewBatch =
		acknowledgeBatch(agent, "account-a", frozen, validAck, fence) === false &&
		same(required(pendingBatch(agent, "account-a", fence)).body, next.body)
	capture(agent, { ...record, requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, "outbox-unresolved")
	capture(agent, { ...record, requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, "outbox-later")
	const watermark = backend.recordWatermark()
	const page = backend.pendingTranslations(0, watermark, 1)
	const later = page[0] ? backend.pendingTranslations(page[0].position, watermark, 1) : []
	const markerPaging =
		page.length === 1 &&
		later.length === 1 &&
		page[0].recordHash !== later[0].recordHash &&
		backend.pendingTranslations(0, watermark, 100).length === 2
	const kindImmutable = rejects(() =>
		observeEvents(
			agent,
			"account-a",
			[{ ...fact, coverage: undefined, work: { reason: "explicit", quality: "confirmed" } }],
			[],
			fence,
		),
	)
	let reopened = false
	if (mode === "sqlite") {
		closeBackends()
		reopened = same(required(pendingBatch(agent, "account-a", fence)).body, next.body)
	}
	out({
		revisions: [one.revision, two.revision, parse(third.body).revision],
		cas: two.baseRevision === "1" && two.baseHash === first.hash && first.hash === eventHash(one),
		noOp,
		byteIsolation,
		binaryBatchOrder,
		corruptionRejected,
		admissionRejected,
		cumulativePreserved,
		markerPaging,
		kindImmutable,
		claimInheritance,
		claimUpdateRejected,
		correctionProgression,
		claimTargetIdentity,
		noNativeUpgrade,
		accountIsolation:
			other.id !== first.id &&
			parse(other.body).revision === "1" &&
			backendFor(agent).pendingOutboxEvents("account-b", 100).length === 1,
		frozenReplay,
		invalidAckRetained,
		observationRollback,
		batchRollback,
		ackRollback,
		leasePause,
		oldAckRetainedNewBatch,
		acknowledgedHistoryRetained:
			Boolean(backendFor(agent).getOutboxEvent("account-a", first.id)?.ackedAt) &&
			Boolean(backendFor(agent).getOutboxEvent("account-a", second.id)?.ackedAt) &&
			same(required(backendFor(agent).getOutboxEvent("account-a", first.id)).body, first.body) &&
			backendFor(agent).pendingOutboxEvents("account-a", 100).length === 1,
		reopened,
	})
	closeBackends()
}

async function outboxTransport(agent: string): Promise<void> {
	const { observeEvents, pendingBatch, acknowledgeBatch } = await import(
		"../../../../src/extensions/pr-cost-reporting/ledger/outbox.js"
	)
	const { eventHash } = await import("../../../../src/extensions/pr-cost-reporting/protocol.js")
	const { closeBackends } = await import("../../../../src/extensions/pr-cost-reporting/ledger/records.js")
	const current = () => {}
	const coverage = {
		entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		source: "codex",
		sourceVersion: "test",
		deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		observeTime: "2026-10-24T01:00:00.123456789+01:00",
		startedAt: "2026-10-24T00:59:00+01:00",
		correction: {
			id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			revision: 1,
			recordedAt: "2026-10-24T00:30:00+01:00",
			source: "work-command",
		},
		coverage: {
			code: "transport_time",
			count: "1",
			windowStartTime: "2026-10-24T00:00:00.000000001+01:00",
			windowEndTime: "2026-10-24T00:30:00.000000002+01:00",
		},
	}
	const pullRequest = {
		...coverage,
		entityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		startedAt: undefined,
		correction: undefined,
		coverage: undefined,
		repository: { provider: "github", host: "github.com", id: "repo" },
		pullRequest: {
			id: "pr",
			number: 1,
			uri: "https://github.com/example/repo/pull/1",
			state: "merged",
			createTime: "2026-10-23T09:00:00.123456789+01:00",
			closeTime: "2026-10-24T00:30:00+01:00",
			mergeTime: "2026-10-24T00:31:00+01:00",
		},
	}
	observeEvents(agent, "transport", [coverage, pullRequest], [], current)
	const first = pendingBatch(agent, "transport", current)
	if (!first) throw new Error("Missing first transport batch")
	const firstBody = JSON.parse(Buffer.from(first.body).toString("utf8"))
	acknowledgeBatch(
		agent,
		"transport",
		first,
		{
			batchId: first.id,
			receipts: firstBody.batch.events.map((event: { id: string; revision: string }) => ({
				id: event.id,
				revision: event.revision,
				status: "accepted",
			})),
		},
		current,
	)
	observeEvents(
		agent,
		"transport",
		[
			{
				...coverage,
				observeTime: "2026-10-24T02:00:01.123456789+02:00",
				coverage: { ...coverage.coverage, count: "2" },
			},
		],
		[],
		current,
	)
	const second = pendingBatch(agent, "transport", current)
	if (!second) throw new Error("Missing second transport batch")
	out({
		first: firstBody,
		second: JSON.parse(Buffer.from(second.body).toString("utf8")),
		hashes: firstBody.batch.events.map(eventHash),
	})
	closeBackends()
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return Buffer.from(left).equals(Buffer.from(right))
}

async function knownAsyncReadRegressions(agent: string, recordJson: string, stored = false): Promise<void> {
	const { backendFor, closeBackends, recordHashOf, readStoredRecordsAsync, rebuildWork } = await import(
		"../../../../src/extensions/pr-cost-reporting/ledger/records.js"
	)
	const readAsync = stored
		? async (signal: AbortSignal): Promise<WorkRecord[]> =>
				(await readStoredRecordsAsync(agent, () => signal.throwIfAborted())).map((row) => JSON.parse(row.body))
		: (signal: AbortSignal) => readWorkRecordsAsync(agent, signal)
	const base = JSON.parse(recordJson) as WorkRecord
	const native = [
		base,
		...Array.from(
			{ length: 1024 },
			(_, index): WorkRecord => ({
				...base,
				type: "request",
				requestId: `native-${index}`,
				scope: null,
				padding: "x".repeat(1024),
			}),
		),
	]
	const sourcePath = join(agent, "work-attribution", `${encodeURIComponent(base.sessionId)}.jsonl`)
	const backend = backendFor(agent)
	backend.tx(() => {
		for (const record of native) {
			const recordHash = recordHashOf(record)
			backend.insertRecord({
				recordHash,
				type: record.type,
				workId: record.workId,
				sessionId: record.sessionId,
				body: JSON.stringify(record),
				sourcePath,
				sourceGeneration: 0,
				sourceOffset: null,
				importedAt: Date.now(),
			})
			backend.upsertMarker(recordHash, record.workId, record.type)
		}
	})
	rebuildWork(agent, base.workId)
	const read = backend.readRecords.bind(backend)
	const page = backend.readRecordPage.bind(backend)
	const before = read({})
	const controller = new AbortController()
	const sentinel = new Error("native reader closed")
	let visited = 0
	let callbackRan = false
	let rowsAtAbort = 0
	backend.readRecordPage = (after, through, limit, checkBudget) => {
		return page(after, through, limit, () => {
			if (++visited === 2)
				setImmediate(() => {
					callbackRan = true
					rowsAtAbort = visited
					controller.abort(sentinel)
				})
			checkBudget?.()
		})
	}
	let cancelled = false
	try {
		await readAsync(controller.signal)
	} catch (error) {
		if (error !== sentinel) throw error
		cancelled = true
	} finally {
		await new Promise<void>((resolve) => setImmediate(resolve))
		backend.readRecordPage = page
	}
	const sameConnectionComplete = JSON.stringify(read({})) === JSON.stringify(before)
	const added: WorkRecord = { ...base, type: "request", requestId: "native-after-abort", scope: null }
	capture(agent, added, sourcePath)
	const committed = read({})
	let insertedDuringRead = false
	backend.readRecordPage = (after, through, limit, checkBudget) => {
		const rows = page(after, through, limit, checkBudget)
		if (!insertedDuringRead) {
			insertedDuringRead = true
			setImmediate(() => capture(agent, { ...added, requestId: "native-during-page" }, sourcePath))
		}
		return rows
	}
	const snapshot = await readAsync(new AbortController().signal)
	backend.readRecordPage = page
	const next = await readAsync(new AbortController().signal)
	const afterCapture = read({})
	closeBackends()
	const reopened = backendFor(agent).readRecords({})
	out({
		observerEntered: visited > 0,
		callbackRan,
		cancelled,
		nativeRows: before.length,
		rowsAtAbort,
		sameConnectionComplete,
		captureCommitted: committed.length === before.length + 1,
		snapshotComplete: JSON.stringify(snapshot) === JSON.stringify(committed.map((row) => JSON.parse(row.body))),
		nextReadSeesCapture: next.length === snapshot.length + 1 && next.at(-1)?.requestId === "native-during-page",
		reopenedComplete: JSON.stringify(reopened) === JSON.stringify(afterCapture),
		noLegacyJournal: !readdirSync(agent).includes("work-attribution"),
	})
	closeBackends()
}

function summaryState(agent: string, workId: string) {
	const store = openStore(agent)
	try {
		return store.db
			.transaction(() => ({
				authority: store.db.query("SELECT * FROM work_records WHERE work_id = ? ORDER BY rowid").all(workId),
				markers: store.db.query("SELECT * FROM pending_translation WHERE work_id = ? ORDER BY record_hash").all(workId),
				head:
					store.db
						.query<{ body: string }, [string]>("SELECT body FROM work_projection_head WHERE work_id = ?")
						.get(workId)?.body ?? null,
				rows: store.db.query("SELECT * FROM work_projection_rows WHERE work_id = ? ORDER BY log, pos").all(workId),
			}))
			.deferred()
	} finally {
		store.close()
	}
}

async function summaryAtomic(agent: string, json: string): Promise<void> {
	const { backendFor, closeBackends } = await import("../../../../src/extensions/pr-cost-reporting/ledger/records.js")
	const { record, failure, failedWorkId } = JSON.parse(json) as {
		record: WorkRecord
		failure: "authority" | "translation" | "projection"
		failedWorkId: string
	}
	capture(agent, { ...record, type: "work" }, "summary-native")
	capture(agent, { ...record, requestId: "prior" }, "summary-native")
	const before = summaryState(agent, record.workId)
	const backend = backendFor(agent)
	const insert = backend.insertRecord
	const mark = backend.upsertMarker
	const publish = backend.putHead
	const sentinel = new Error("after-write cancellation")
	let mutations = 0
	if (failure === "authority")
		backend.insertRecord = (row) => {
			const inserted = insert(row)
			if (inserted) {
				mutations++
				throw sentinel
			}
			return inserted
		}
	if (failure === "translation")
		backend.upsertMarker = (...args) => {
			mark(...args)
			mutations++
			throw sentinel
		}
	if (failure === "projection")
		backend.putHead = (head) => {
			publish(head)
			mutations++
			throw sentinel
		}
	let rejected = 0
	try {
		for (const next of [record, { ...record, type: "work" as const, workId: failedWorkId }]) {
			try {
				capture(agent, next, "summary-native")
			} catch (error) {
				if (error !== sentinel) throw error
				rejected++
			}
		}
	} finally {
		backend.insertRecord = insert
		backend.upsertMarker = mark
		backend.putHead = publish
		closeBackends()
	}
	const after = summaryState(agent, record.workId)
	const failedHeader = summaryState(agent, failedWorkId)
	capture(agent, record, "summary-native")
	capture(agent, record, "summary-native")
	closeBackends()
	out({ before, after, failedHeader, mutations, rejected, recovered: summaryState(agent, record.workId) })
}

/** A synchronous pipe gate holds a real transaction after its head write, never across await. */
async function summaryWriter(agent: string, json: string): Promise<void> {
	const { backendFor, closeBackends } = await import("../../../../src/extensions/pr-cost-reporting/ledger/records.js")
	const { flushWorkSummaries } = await import("../../../../src/extensions/work-attribution/summary.js")
	const {
		record,
		count = 1,
		beforeFlush = false,
	} = JSON.parse(json) as {
		record: WorkRecord
		count?: number
		beforeFlush?: boolean
	}
	const backend = backendFor(agent)
	const publish = backend.putHead
	const cancelled = new Error("writer ownership cancelled before commit")
	const gate = () => {
		const byte = Buffer.alloc(1)
		if (readSync(0, byte, 0, 1, null) !== 1) throw new Error("Missing writer release")
		return byte[0] === 99
	}
	const signal = (phase: string) => writeSync(1, `${JSON.stringify({ phase })}\n`)
	backend.putHead = (head) => {
		publish(head)
		signal("pending")
		if (!gate()) throw cancelled
	}
	try {
		signal("ready")
		for (let index = 0; index < count; index++) {
			try {
				capture(
					agent,
					count === 1 ? record : { ...record, requestId: `${record.sessionId}-${index}` },
					"summary-native",
				)
			} catch (error) {
				if (error !== cancelled) throw error
				signal("rolled-back")
				// Stay alive while the competing writer commits: the cancelled head must never reappear.
				gate()
				return
			}
			signal("committed")
		}
		if (beforeFlush && !gate()) throw new Error("Missing flush release")
		await flushWorkSummaries()
		signal("flushed")
	} finally {
		backend.putHead = publish
		closeBackends()
	}
}

async function knownRecordRegressions(agent: string, recordJson: string): Promise<void> {
	const { backendFor, closeBackends, ledgerSessionInfo, recoverDirty } = await import(
		"../../../../src/extensions/pr-cost-reporting/ledger/records.js"
	)
	const base = JSON.parse(recordJson) as WorkRecord
	const requestId = "22222222-2222-4222-8222-222222222222"
	capture(agent, base, "ledger-driver")
	capture(agent, { ...base, type: "request", requestId, startedAt: "2026-10-01T00:01:00.000Z" }, "ledger-driver")
	capture(agent, { ...base, type: "request_response", requestId, responseId: "regression-response" }, "ledger-driver")
	closeBackends()

	const counts = (): Record<string, number> => {
		const store = openStore(agent)
		try {
			return Object.fromEntries(
				[
					["authority", "work_records"],
					["markers", "pending_translation"],
					["heads", "work_projection_head"],
					["rows", "work_projection_rows"],
					["notes", "bookkeeping"],
					["dirty", "work_dirty"],
					["diagnostics", "diagnostics"],
				].map(([name, table]) => [
					name,
					store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM " + table).get()?.count ?? -1,
				]),
			)
		} finally {
			store.close()
		}
	}
	// Reopen through the real SQL backend, including its session-column mapping.
	const session = ledgerSessionInfo(agent, base.sessionId)
	const responseId = readWorkSummary(agent, base.workId)?.requests[0]?.responseId
	const before = counts()
	let constraintRejected = false
	try {
		capture(agent, { ...base, sessionId: null } as unknown as WorkRecord, "ledger-driver")
	} catch {
		constraintRejected = true
	}
	closeBackends()
	const afterConstraint = counts()
	const backend = backendFor(agent)
	let rolledBack = false
	try {
		backend.tx(() => {
			capture(agent, { ...base, recordedAt: "2026-10-01T00:05:00.000Z" }, "ledger-driver")
			backend.putNote(base.workId, "rollback-probe", "written")
			backend.markDirty(base.workId)
			backend.diagnostic("rollback-probe")
			throw new Error("rollback-probe")
		})
	} catch {
		rolledBack = true
	}
	closeBackends()
	const afterRollback = counts()
	const replay = backendFor(agent)
	const originalRows = replay.readRecords({})
	let budgetChecks = 0
	let iterationAborted = false
	try {
		// The backend checks once before iteration, then once per SQL row: abort on row two.
		replay.readRecords({}, () => {
			if (++budgetChecks === 3) throw new Error("iteration budget exhausted")
		})
	} catch (error) {
		iterationAborted = error instanceof Error && error.message === "iteration budget exhausted"
	}
	// No reconnect: this must reuse the same prepared statement after its iterator was interrupted.
	const afterAbort = replay.readRecords({})
	replay.tx(() => replay.putNote(base.workId, "iteration-reuse", "committed"))
	const transactionWrite = replay.getNote(base.workId, "iteration-reuse") === "committed"
	closeBackends()
	const reopened = backendFor(agent)
	const reopenedRows = reopened.readRecords({})
	const iteration = {
		aborted: iterationAborted,
		budgetChecks,
		sameConnectionRows: afterAbort.length,
		sameConnectionUnchanged: JSON.stringify(afterAbort) === JSON.stringify(originalRows),
		transactionWrite,
		reopenedRows: reopenedRows.length,
		reopenedUnchanged: JSON.stringify(reopenedRows) === JSON.stringify(originalRows),
		reopenedNote: reopened.getNote(base.workId, "iteration-reuse") === "committed",
		noLegacyJournal: !readdirSync(agent).includes("work-attribution"),
	}
	closeBackends()
	const dirty = backendFor(agent)
	const beforeRecovery = dirty.readRecords({})
	const recoveryView = readWorkSummary(agent, base.workId)
	dirty.tx(() => {
		dirty.clearProjection(base.workId)
		dirty.markDirty(base.workId)
	})
	const clearDirty = dirty.clearDirty
	let recoveryFailed = false
	dirty.clearDirty = (workId) => {
		clearDirty(workId)
		throw new Error("recovery marker failure")
	}
	try {
		recoverDirty(agent)
	} catch (error) {
		recoveryFailed = error instanceof Error && error.message === "recovery marker failure"
	} finally {
		dirty.clearDirty = clearDirty
	}
	closeBackends()
	const afterFailure = backendFor(agent)
	const recoveryRolledBack =
		afterFailure.dirtyWorks().includes(base.workId) &&
		afterFailure.getHead(base.workId) === undefined &&
		afterFailure.readLog(base.workId, "requests").length === 0 &&
		afterFailure.readLog(base.workId, "sessions").length === 0 &&
		JSON.stringify(afterFailure.readRecords({})) === JSON.stringify(beforeRecovery)
	afterFailure.tx(() => afterFailure.clearProjection(base.workId))
	closeBackends()
	const afterReopen = backendFor(agent)
	const reopenedDirty = afterReopen.dirtyWorks().includes(base.workId)
	const reopenedMissingHead = afterReopen.getHead(base.workId) === undefined
	recoverDirty(agent)
	const recovery = {
		failed: recoveryFailed,
		rolledBack: recoveryRolledBack,
		reopenedDirty,
		reopenedMissingHead,
		headRestored: afterReopen.getHead(base.workId)?.workId === base.workId,
		viewRestored: JSON.stringify(readWorkSummary(agent, base.workId)) === JSON.stringify(recoveryView),
		dirtyCleared: !afterReopen.dirtyWorks().includes(base.workId),
		authorityUnchanged: JSON.stringify(afterReopen.readRecords({})) === JSON.stringify(beforeRecovery),
		persistedAfterReopen: false,
	}
	closeBackends()
	const final = backendFor(agent)
	recovery.persistedAfterReopen =
		final.getHead(base.workId)?.workId === base.workId &&
		!final.dirtyWorks().includes(base.workId) &&
		JSON.stringify(final.readRecords({})) === JSON.stringify(beforeRecovery) &&
		JSON.stringify(readWorkSummary(agent, base.workId)) === JSON.stringify(recoveryView)
	closeBackends()
	out({
		sessionWorkId: session.work?.workId,
		sessionRecords: session.recordCount,
		responseId,
		before,
		constraintRejected,
		afterConstraint,
		rolledBack,
		afterRollback,
		recovery,
		iteration,
	})
}

async function knownSchemaRaceOpen(agent: string): Promise<void> {
	// Signal after the real initial PRAGMA read, so the parent commits only after this opener saw version 0.
	type VersionStatement = { get: (...args: unknown[]) => { user_version?: number } | null }
	const prototype = Database.prototype as unknown as { query: (sql: string) => VersionStatement }
	const original = prototype.query
	let announced = false
	prototype.query = function (sql: string): VersionStatement {
		const statement = original.call(this, sql)
		if (sql === "PRAGMA user_version" && !announced) {
			const get = statement.get
			statement.get = function (...args: unknown[]) {
				const value = get.apply(this, args)
				if (!announced) {
					announced = true
					out({ versionRead: value?.user_version })
				}
				return value
			}
		}
		return statement
	}
	try {
		openStore(agent).close()
		out({ opened: true })
	} catch (error) {
		out({ opened: false, code: (error as { code?: string }).code })
	} finally {
		prototype.query = original
	}
}

async function knownSchemaRace(agent: string): Promise<void> {
	const { spawn } = await import("node:child_process")
	const { fileURLToPath } = await import("node:url")
	const path = ledgerDbPath(agent)
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const writer = new Database(path, { create: true })
	writer.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; PRAGMA user_version=777; CREATE TABLE future_only(value TEXT)")
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "known-schema-race-open", agent], {
		stdio: ["ignore", "pipe", "pipe"],
	})
	let output = ""
	let errors = ""
	let sawVersion = false
	let committed = false
	let timer: ReturnType<typeof setTimeout> | undefined
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("exit", resolve)
		child.once("error", reject)
	})
	const readVersion = new Promise<void>((resolve, reject) => {
		timer = setTimeout(() => reject(new Error("schema opener never read version 0: " + errors)), 10_000)
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString()
			if (output.includes('"versionRead":0')) {
				sawVersion = true
				resolve()
			}
		})
		child.stderr.on("data", (chunk: Buffer) => {
			errors += chunk.toString()
		})
		child.once("error", reject)
		child.once("exit", () => {
			if (!sawVersion) reject(new Error("schema opener exited before stale read: " + output + errors))
		})
	})
	try {
		await readVersion
		writer.exec("COMMIT")
		committed = true
		const code = await exited
		if (code !== 0) throw new Error("schema opener failed: " + errors)
		const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
		out({
			...result,
			version: writer.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
			tables: writer
				.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
				.all()
				.map((row) => row.name),
		})
	} finally {
		clearTimeout(timer)
		if (!committed) writer.exec("ROLLBACK")
		if (child.exitCode === null) child.kill("SIGKILL")
		await exited.catch(() => {})
		writer.close()
	}
}

const commands: Record<string, (agent: string, arg?: string) => Promise<void>> = {
	probe: (agent) => probe(agent),
	"foreign-check": (agent) => foreignCheck(agent),
	"hold-writer": (agent, ms) => holdWriter(agent, ms === "release" ? ms : Number(ms ?? "0")),
	"read-only": (agent) => readOnly(agent),
	"write-probe": (agent) => writeProbe(agent),
	capture: (agent, json) => captureRecord(agent, json ?? "{}"),
	head: (agent, workId) => printHead(agent, workId ?? ""),
	rows: (agent, workId) => printRows(agent, workId ?? ""),
	note: async (agent, json) => {
		const [workId, name] = JSON.parse(json ?? "[]")
		out(getNote(agent, workId, name) ?? null)
	},
	"pr-checks": async (agent) => {
		process.env.PI_CODING_AGENT_DIR = agent
		const { reconcileWorkPullRequests } = await import(
			"../../../../src/extensions/pull-request-status/pull-requests.js"
		)
		await reconcileWorkPullRequests(agent, new AbortController().signal, () => {})
		out({ note: getNote(agent, "agent", "pr-checks"), records: readRecords(agent).length })
	},
	"remove-note": async (agent, json) => {
		const [workId, name] = JSON.parse(json ?? "[]")
		const store = openStore(agent)
		try {
			store.db.query("DELETE FROM bookkeeping WHERE work_id = ? AND name = ?").run(workId, name)
			out(null)
		} finally {
			store.close()
		}
	},
	records: (agent, workId) => printRecords(agent, workId || undefined),
	"import-journals": (agent) => importJournalsCommand(agent),
	"native-usage": (agent) => nativeUsage(agent),
	"native-usage-anthropic": (agent) => nativeUsage(agent, true),
	"native-common-events": (agent) => nativeUsage(agent, true, true),
	"native-common-delivery": (agent) => nativeUsage(agent, true, true, true),
	producer: (agent) => producerScenario(agent),
	"legacy-freeze": (agent) => legacyFreezeScenario(agent),
	outbox: (agent, mode) => outboxScenario(agent, mode ?? "sqlite"),
	"outbox-transport": (agent) => outboxTransport(agent),
	"read-work-records": (agent) => readWorkRecordsCommand(agent),
	"read-history": async (agent) => {
		const problems: WorkRecordProblem[] = []
		const records = readWorkRecords(agent, undefined, undefined, (problem) => problems.push(problem))
		out({ records, problems })
	},
	"read-history-async": async (agent) => {
		const problems: WorkRecordProblem[] = []
		let turns = 0
		let reading = true
		const spin = () => {
			turns++
			if (reading) setImmediate(spin)
		}
		setImmediate(spin)
		try {
			const records = await readWorkRecordsAsync(agent, new AbortController().signal, (problem) =>
				problems.push(problem),
			)
			out({
				records: records.length,
				requestIds: records.filter((row) => row.type === "request").map((row) => row.requestId),
				problems,
				turns,
			})
		} finally {
			reading = false
		}
	},
	listfiles: (agent) => listFiles(agent),
	"summary-state": async (agent, workId) => out(summaryState(agent, workId ?? "")),
	"summary-reader": async (agent, workId) => {
		// Process startup must finish before the test holds any writer transaction.
		summaryState(agent, workId ?? "")
		const input = createInterface({ input: process.stdin })
		out({ phase: "ready" })
		try {
			for await (const _ of input) out({ phase: "snapshot", state: summaryState(agent, workId ?? "") })
		} finally {
			input.close()
		}
	},
	"summary-atomic": (agent, json) => summaryAtomic(agent, json ?? "{}"),
	"summary-writer": (agent, json) => summaryWriter(agent, json ?? "{}"),
	"known-record-regressions": (agent, json) => knownRecordRegressions(agent, json ?? "{}"),
	"known-async-read-regressions": (agent, json) => knownAsyncReadRegressions(agent, json ?? "{}"),
	"known-async-stored-read-regressions": (agent, json) => knownAsyncReadRegressions(agent, json ?? "{}", true),
	"known-schema-race": (agent) => knownSchemaRace(agent),
	"known-schema-race-open": (agent) => knownSchemaRaceOpen(agent),
}

if (!command || !agentDir || !commands[command]) {
	console.error(`usage: ledger-driver.ts <${Object.keys(commands).join("|")}> <agentDir> [arg]`)
	process.exit(1)
}
await commands[command](agentDir, arg)
