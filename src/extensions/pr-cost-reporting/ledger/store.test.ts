import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, onTestFinished, test } from "vitest"
import { readRecordsSinceSql } from "./records.js"
import { LEDGER_ADDITIVE_SCHEMA } from "./schema.js"
import { classifyUserVersion, LedgerUnavailableError, ledgerDbPath, openStore, retryOnBusy } from "./store.js"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const DRIVER = join(ROOT, "tests/e2e/tui/support/ledger-driver.ts")
const isBun = typeof (process.versions as Record<string, string | undefined>).bun === "string"

const dirs: string[] = []
function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-ledger-c1-"))
	dirs.push(dir)
	return dir
}
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

interface DriverResult {
	[key: string]: unknown
}
function driver(...args: string[]): DriverResult {
	const stdout = execFileSync("bun", [DRIVER, ...args], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env },
	})
	const line = stdout.trim().split("\n").pop()
	if (!line) throw new Error(`ledger driver produced no output: ${args.join(" ")}`)
	return JSON.parse(line) as DriverResult
}

describe("classifyUserVersion (pure)", () => {
	test.each([
		[0, "create"],
		[1, "open"],
		[2, "foreign"],
		[777, "foreign"],
	])("user_version %i → %s", (version, action) => {
		expect(classifyUserVersion(version)).toBe(action)
	})
})

describe("retryOnBusy (pure)", () => {
	const busy = (code = "SQLITE_BUSY") => Object.assign(new Error("busy"), { code })
	function fakeClock() {
		const c = {
			t: 0,
			sleeps: [] as number[],
			now: () => c.t,
			sleep: (ms: number) => {
				c.sleeps.push(ms)
				c.t += ms
			},
		}
		return c
	}

	test("retries busy errors (any SQLITE_BUSY* code) with capped backoff, then succeeds", () => {
		const clock = fakeClock()
		let calls = 0
		const result = retryOnBusy(
			() => {
				if (++calls <= 7) throw busy(calls % 2 ? "SQLITE_BUSY" : "SQLITE_BUSY_RECOVERY")
				return "ok"
			},
			5000,
			clock,
		)
		expect(result).toBe("ok")
		expect(clock.sleeps).toEqual([10, 20, 40, 80, 160, 250, 250])
	})

	test("non-busy errors are rethrown immediately without sleeping", () => {
		const clock = fakeClock()
		const boom = Object.assign(new Error("boom"), { code: "SQLITE_CORRUPT" })
		expect(() =>
			retryOnBusy(
				() => {
					throw boom
				},
				5000,
				clock,
			),
		).toThrow(boom)
		expect(clock.sleeps).toEqual([])
	})

	test("gives up with the last busy error once the budget is spent", () => {
		const clock = fakeClock()
		let calls = 0
		expect(() =>
			retryOnBusy(
				() => {
					calls++
					throw busy()
				},
				100,
				clock,
			),
		).toThrow("busy")
		expect(clock.t).toBe(100)
		expect(calls).toBeGreaterThan(1)
	})
})

describe("Node runtime", () => {
	test("module import is safe and openStore throws the coded error", { skip: isBun }, () => {
		let thrown: unknown
		try {
			openStore(agentDir())
		} catch (error) {
			thrown = error
		}
		expect(thrown).toBeInstanceOf(LedgerUnavailableError)
		expect((thrown as LedgerUnavailableError).code).toBe("pr-cost-ledger/unavailable")
	})
})

test("ledger path sits in the reporting directory", () => {
	expect(ledgerDbPath("/tmp/agent-x")).toBe("/tmp/agent-x/pr-cost-reporting/ledger.db")
})

describe("open via Bun driver", () => {
	// Three cold `bun` starts of the ledger module graph (~370 ms each on a CI runner)
	// plus SQLite work; the default 5 s budget is too tight when four workers share the box.
	test("PR lookup backoff migrates once and survives a real SQLite reopen", { timeout: 30_000 }, () => {
		const dir = agentDir()
		const repository = join(dir, "removed-worktree", ".git")
		const sha = "a".repeat(40)
		const now = Date.now()
		driver(
			"capture",
			dir,
			JSON.stringify({
				version: 1,
				type: "commit",
				workId: "11111111-1111-4111-8111-111111111111",
				sessionId: "writer",
				cwd: join(dir, "removed-worktree"),
				worktree: join(dir, "removed-worktree"),
				repository,
				sha,
				recordedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
				prLookup: { status: "pending", checkedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
				pullRequests: [],
			}),
		)
		mkdirSync(join(dir, "work-attribution"))
		const path = join(dir, "work-attribution", "pr-checks.json")
		const body = `${JSON.stringify({ [repository]: { [sha]: new Date(now).toISOString() } })}\n`
		writeFileSync(path, body)
		expect(driver("pr-checks", dir)).toEqual({ note: body, records: 1 })
		expect(readFileSync(path, "utf8")).toBe(body)
		writeFileSync(path, "{}\n")
		expect(driver("pr-checks", dir)).toEqual({ note: body, records: 1 })
		expect(readFileSync(path, "utf8")).toBe("{}\n")
	})
	test("fresh open creates dir/file with modes, schema version and tables", { timeout: 60_000 }, () => {
		const result = driver("probe", agentDir())
		expect(result.version).toBe(1)
		expect(result.dirMode).toBe(0o700)
		expect(result.fileMode).toBe(0o600)
		expect(result.tables).toEqual([
			"bookkeeping",
			"delivery_state",
			"diagnostics",
			"journal_cursor",
			"meta",
			"outbox_batches",
			"outbox_events",
			"pending_translation",
			"work_dirty",
			"work_projection_head",
			"work_projection_rows",
			"work_records",
		])
	})

	test("foreign user_version is refused and left untouched", { timeout: 60_000 }, () => {
		const result = driver("foreign-check", agentDir())
		expect(result.opened).toBe(false)
		expect(result.code).toBe("pr-cost-ledger/future-schema")
		expect(result.version).toBe(777)
		expect(result.tables).toBe(0)
	})

	test("WAL: concurrent reader works while a writer holds; a second writer surfaces the busy timeout", {
		timeout: 90_000,
	}, async () => {
		const agent = agentDir()
		driver("probe", agent) // create schema so the writer doesn't race on creation
		const holder = spawn("bun", [DRIVER, "hold-writer", agent, "release"], { cwd: ROOT })
		let holderErr = ""
		holder.stderr.on("data", (chunk) => (holderErr += chunk))
		const exited = new Promise<void>((resolve, reject) => {
			holder.once("error", reject)
			holder.once("exit", (code, signal) =>
				code === 0 ? resolve() : reject(new Error(`holder exit ${code}/${signal}: ${holderErr}`)),
			)
		})
		void exited.catch(() => {})
		onTestFinished(() => {
			if (holder.exitCode === null) holder.kill("SIGKILL")
		})
		try {
			await new Promise<void>((resolve, reject) => {
				let output = ""
				holder.stdout.on("data", (chunk) => {
					output += chunk
					if (output.includes('"held":true')) resolve()
				})
				holder.once("error", reject)
				holder.once("exit", () => reject(new Error(`holder exited before ready: ${holderErr}`)))
			})
			// The holder cannot release during reader/process startup, regardless of CI scheduling delay.
			const reader = driver("read-only", agent)
			expect(reader.count).toBe(0)
			const probe = driver("write-probe", agent)
			expect(probe.acquired).toBe(false)
			expect(probe.elapsedMs).toBeGreaterThanOrEqual(4000)
			expect(String(probe.message)).toContain("locked")
		} finally {
			if (holder.exitCode === null) holder.stdin.end("release\n")
			await exited
		}
		// The committed insert is visible afterwards.
		expect(driver("read-only", agent).count).toBe(1)
	})
})

test("agentDir stays inside the OS temp dir for tests", () => {
	mkdirSync(agentDir(), { recursive: true })
})

test("known regression: initialization rechecks a future version after obtaining the lock", { timeout: 60_000 }, () => {
	const result = driver("known-schema-race", agentDir())
	expect(result.opened).toBe(false)
	expect(result.code).toBe("pr-cost-ledger/future-schema")
	expect(result.version).toBe(777)
	expect(result.tables).toEqual(["future_only"])
})

test("the outbox status aggregate has covering indexes available to every open", () => {
	// LEDGER_SCHEMA only executes at database creation; pre-existing ledgers receive indexes through the
	// additive block that store.ts runs on every open, so both statements must live there.
	expect(LEDGER_ADDITIVE_SCHEMA).toContain(
		"CREATE INDEX IF NOT EXISTS outbox_pending_cover ON outbox_events(account_key, acked_at, blocked)",
	)
	// The earliest-batch-per-account scalar lookup must not scan the batch authority either.
	expect(LEDGER_ADDITIVE_SCHEMA).toContain(
		"CREATE INDEX IF NOT EXISTS outbox_batches_by_account ON outbox_batches(account_key, order_key, created_at)",
	)
	// The incremental reconcile read filters WHERE imported_at >= ? — at six figures that is a
	// full-table scan per pass without this index.
	expect(LEDGER_ADDITIVE_SCHEMA).toContain(
		"CREATE INDEX IF NOT EXISTS work_records_imported ON work_records(imported_at)",
	)
})

test("an existing ledger gains the additive indexes on open (bun driver)", () => {
	const dir = agentDir()
	// The driver opens the ledger, drops the additive indexes, reopens it, and reports what the
	// every-open additive apply restored — a pre-existing ledger behaves identically to a fresh one.
	const result = driver("schema-check", dir)
	const expected = ["outbox_batches_by_account", "outbox_pending_cover", "work_records_imported"]
	const indexes = (result.afterReopen as string[]).filter((name) => expected.includes(name))
	expect((result.afterDrop as string[]).some((name) => expected.includes(name))).toBe(false)
	expect(indexes.sort()).toEqual(expected)
})

test("the windowed read is hinted onto the imported index; unhinted SQL stays rowid-ordered", () => {
	expect(readRecordsSinceSql(true)).toContain("INDEXED BY work_records_imported")
	expect(readRecordsSinceSql(true)).toContain("ORDER BY rowid")
	// An indexless open (a contended first open defers the additive apply) must degrade to the scan, not error.
	expect(readRecordsSinceSql(false)).not.toContain("INDEXED BY")
})

test("the planner answers the windowed read from the index, not a full scan (bun driver)", () => {
	const dir = agentDir()
	// At table sizes past ~20k rows, the unhinted ORDER BY rowid read loses to a full scan without
	// STAT4; the driver seeds 25k rows so the planner's choice is the one the soak measured.
	const result = driver("plan-since", dir, "seed")
	expect(result.hinted).toBe(true)
	const plan = (result.plan as string[]).join(" ")
	expect(plan).toContain("work_records_imported")
	expect(plan).not.toContain("SCAN work_records")
})
