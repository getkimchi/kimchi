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

async function readWorkRecordsCommand(agent: string): Promise<void> {
	out(readWorkRecords(agent))
}

async function knownAsyncReadRegressions(agent: string, recordJson: string): Promise<void> {
	const { backendFor, closeBackends, recordHashOf, rebuildWork } = await import(
		"../../../../src/extensions/pr-cost-reporting/ledger/records.js"
	)
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
		await readWorkRecordsAsync(agent, controller.signal)
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
	const snapshot = await readWorkRecordsAsync(agent, new AbortController().signal)
	backend.readRecordPage = page
	const next = await readWorkRecordsAsync(agent, new AbortController().signal)
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
	"known-schema-race": (agent) => knownSchemaRace(agent),
	"known-schema-race-open": (agent) => knownSchemaRaceOpen(agent),
}

if (!command || !agentDir || !commands[command]) {
	console.error(`usage: ledger-driver.ts <${Object.keys(commands).join("|")}> <agentDir> [arg]`)
	process.exit(1)
}
await commands[command](agentDir, arg)
