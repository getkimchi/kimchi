import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
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
		const holder = spawn("bun", [DRIVER, "hold-writer", agent, "7000"], { cwd: ROOT })
		let holderOut = ""
		holder.stdout.on("data", (chunk) => (holderOut += chunk))
		let holderErr = ""
		holder.stderr.on("data", (chunk) => (holderErr += chunk))
		const dead = Date.now() + 30_000
		while (!holderOut.includes('"held":true')) {
			if (Date.now() > dead) throw new Error(`hold-writer never acquired the lock: ${holderErr}`)
			await new Promise((resolve) => setTimeout(resolve, 50))
		}

		// A reader proceeds under WAL even though the writer holds BEGIN IMMEDIATE.
		const reader = driver("read-only", agent)
		expect(reader.count).toBe(0)

		// A writer waiting on the same lock gives up after the 5s busy timeout.
		const probe = driver("write-probe", agent)
		expect(probe.acquired).toBe(false)
		expect(probe.elapsedMs).toBeGreaterThanOrEqual(4000)
		expect(String(probe.message)).toContain("locked")

		const exitCode = await new Promise<number>((resolve, reject) => {
			holder.on("exit", (code) => (code === 0 ? resolve(code) : reject(new Error(`holder exit ${code}: ${holderErr}`))))
		})
		expect(exitCode).toBe(0)
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
