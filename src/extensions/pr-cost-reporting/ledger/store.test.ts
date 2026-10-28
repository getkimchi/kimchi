import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, onTestFinished, test } from "vitest"
import { classifyUserVersion, LedgerUnavailableError, ledgerDbPath, openStore } from "./store.js"

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
	test("PR lookup backoff migrates once and survives a real SQLite reopen", () => {
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
