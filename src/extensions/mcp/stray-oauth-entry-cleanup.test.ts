import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SecurityToolResult, SecurityToolRunner } from "./keyring-require-bridge.js"
import {
	cleanupStrayMcpOAuthEntries,
	cleanupStrayMcpOAuthEntriesBestEffort,
	parseDumpedAccounts,
	resetStrayCleanupGuardForTests,
} from "./stray-oauth-entry-cleanup.js"

const SERVICE = "dev.kimchi.mcp.oauth"
const ATLASSIAN = "sha256-651b2c67d53613630734935b1b7ac642f500543630d5833c277383eb12e5f182"
const CHUNK = `${ATLASSIAN}.chunk.0123456789abcdef.0`

function entry(service: string, account: string): string {
	return `class: "genp"
attributes:
    0x00000007 <blob>="${service}"
    "acct"<blob>="${account}"
    "cdat"<timedate>=0x00  "20261001000000Z\\000"
    "mdat"<timedate>=0x00  "20261001000000Z\\000"
    "svce"<blob>="${service}"
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
`
}

function okResult(overrides: Partial<SecurityToolResult> = {}): SecurityToolResult {
	return { stdout: "", stderr: "", status: 0, error: undefined, ...overrides }
}

/** Dump runner whose delete results are decided per account; records attempted deletions. */
function makeRunner(
	dump: string,
	deleteOutcome: (account: string) => SecurityToolResult,
): SecurityToolRunner & { attempted: string[] } {
	const attempted: string[] = []
	const runner: SecurityToolRunner & { attempted: string[] } = (args) => {
		if (args[0] === "dump-keychain") return okResult({ stdout: dump })
		if (args[0] === "delete-generic-password") {
			const account = args[args.indexOf("-a") + 1]
			attempted.push(account)
			return deleteOutcome(account)
		}
		return okResult({ status: 1 })
	}
	runner.attempted = attempted
	return runner
}

describe("parseDumpedAccounts", () => {
	it("collects accounts for the target service only", () => {
		const output = [
			entry(SERVICE, ATLASSIAN),
			entry("com.apple.assistant", "62DC7CBC-8E02-4EAB-B353-E6C91326A565 - Assistant Identifier"),
			entry(SERVICE, "Bearer"),
		].join("\n")
		expect(parseDumpedAccounts(output, SERVICE)).toEqual([ATLASSIAN, "Bearer"])
	})

	it("never returns accounts of legacy-service items even with non-conforming accounts", () => {
		const output = entry("pi-mcp-adapter.oauth", "Bearer")
		expect(parseDumpedAccounts(output, SERVICE)).toEqual([])
	})

	it("skips entries whose acct renders as a hex blob instead of a string", () => {
		const output = `class: "genp"
attributes:
    0x00000007 <blob>="${SERVICE}"
    "acct"<blob>=0x31323334  "1234"\\u0000
    "svce"<blob>="${SERVICE}"
`
		expect(parseDumpedAccounts(output, SERVICE)).toEqual([])
	})

	it("handles accounts with spaces and mixed content", () => {
		const output = entry(SERVICE, "some account with spaces")
		expect(parseDumpedAccounts(output, SERVICE)).toEqual(["some account with spaces"])
	})

	it("returns nothing for empty output", () => {
		expect(parseDumpedAccounts("", SERVICE)).toEqual([])
	})
})

describe("cleanupStrayMcpOAuthEntries", () => {
	it("removes only accounts that do not match kimchi's key shapes", () => {
		const dump = [entry(SERVICE, ATLASSIAN), entry(SERVICE, CHUNK), entry(SERVICE, "Bearer")].join("\n")
		const runner = makeRunner(dump, () => okResult())
		const result = cleanupStrayMcpOAuthEntries(runner)
		expect(runner.attempted).toEqual(["Bearer"])
		expect(result.removed).toEqual(["Bearer"])
		expect(result.failedDeletes).toEqual([])
		expect(result.denied).toBe(false)
		expect(result.refused).toEqual([])
	})

	it("leaves a healthy keychain untouched", () => {
		const dump = entry(SERVICE, ATLASSIAN)
		const runner = makeRunner(dump, () => okResult())
		const result = cleanupStrayMcpOAuthEntries(runner)
		expect(runner.attempted).toEqual([])
		expect(result.removed).toEqual([])
	})

	it("aborts the sweep on the first consent denial (exit 128)", () => {
		const dump = [entry(SERVICE, "Bearer"), entry(SERVICE, "Fastly")].join("\n")
		const runner = makeRunner(dump, () => okResult({ status: 128 }))
		const result = cleanupStrayMcpOAuthEntries(runner)
		expect(runner.attempted).toEqual(["Bearer"])
		expect(result.denied).toBe(true)
		expect(result.deniedAccounts).toEqual(["Bearer"])
		expect(result.removed).toEqual([])
	})

	it("treats a runner timeout as a likely pending dialog and aborts", () => {
		const dump = [entry(SERVICE, "Bearer"), entry(SERVICE, "Fastly")].join("\n")
		const runner = makeRunner(dump, () =>
			okResult({ status: null, error: Object.assign(new Error("spawn ETIMEDOUT"), { code: "ETIMEDOUT" }) }),
		)
		const result = cleanupStrayMcpOAuthEntries(runner)
		expect(runner.attempted).toEqual(["Bearer"])
		expect(result.denied).toBe(true)
		expect(result.timedOut).toBe(true)
	})

	it("records non-denial delete failures and continues the sweep", () => {
		const dump = [entry(SERVICE, "Bearer"), entry(SERVICE, "Fastly")].join("\n")
		const runner = makeRunner(dump, () => okResult({ status: 45, stderr: "unexpected" }))
		const result = cleanupStrayMcpOAuthEntries(runner)
		expect(runner.attempted).toEqual(["Bearer", "Fastly"])
		expect(result.failedDeletes).toEqual(["Bearer", "Fastly"])
		expect(result.removed).toEqual([])
		expect(result.denied).toBe(false)
	})

	it("treats a concurrent not-found delete as removed", () => {
		const dump = entry(SERVICE, "Bearer")
		const runner = makeRunner(dump, () => okResult({ status: 44, stderr: "could not be found" }))
		const result = cleanupStrayMcpOAuthEntries(runner)
		expect(result.removed).toEqual(["Bearer"])
	})

	it("refuses all deletions when strays exceed the blast-radius cap", () => {
		const dump = [entry(SERVICE, "a"), entry(SERVICE, "b"), entry(SERVICE, "c")].join("\n")
		const runner = makeRunner(dump, () => okResult())
		const result = cleanupStrayMcpOAuthEntries(runner)
		expect(runner.attempted).toEqual([])
		expect(result.refused).toEqual(["a", "b", "c"])
		expect(result.removed).toEqual([])
	})

	it("deletes up to the cap but not beyond it", () => {
		const dump = [entry(SERVICE, "a"), entry(SERVICE, "b")].join("\n")
		const runner = makeRunner(dump, () => okResult())
		const result = cleanupStrayMcpOAuthEntries(runner)
		expect(runner.attempted).toEqual(["a", "b"])
		expect(result.removed).toEqual(["a", "b"])
		expect(result.refused).toEqual([])
	})

	it("never deletes entries with empty or whitespace accounts", () => {
		const dump = [entry(SERVICE, ""), entry(SERVICE, "   "), entry(SERVICE, ATLASSIAN)].join("\n")
		const runner = makeRunner(dump, () => okResult())
		const result = cleanupStrayMcpOAuthEntries(runner)
		expect(runner.attempted).toEqual([])
		expect(result.removed).toEqual([])
	})

	it("reports failure when dump-keychain fails", () => {
		const result = cleanupStrayMcpOAuthEntries(() => okResult({ status: 1, stderr: "err" }))
		expect(result.failed).toBe(true)
		expect(result.scanned).toBe(0)
	})
})

describe("cleanupStrayMcpOAuthEntriesBestEffort", () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")

	beforeEach(() => {
		resetStrayCleanupGuardForTests()
		// The best-effort entry point is darwin-only; stub the platform so the
		// warning behavior is covered on Linux CI runners too (the "does nothing
		// off darwin" test below overrides this with its own linux stub).
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
	})

	afterEach(() => {
		resetStrayCleanupGuardForTests()
		vi.restoreAllMocks()
		Object.defineProperty(process, "platform", { ...originalPlatform, configurable: true })
	})

	it("runs only once per process", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const dump = entry(SERVICE, "Bearer")
		const runner = makeRunner(dump, () => okResult())
		cleanupStrayMcpOAuthEntriesBestEffort(runner)
		cleanupStrayMcpOAuthEntriesBestEffort(makeRunner(entry(SERVICE, "other"), () => okResult()))
		expect(runner.attempted).toEqual(["Bearer"])
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it("does nothing off darwin", () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true })
		try {
			const dump = entry(SERVICE, "Bearer")
			const runner = makeRunner(dump, () => okResult())
			cleanupStrayMcpOAuthEntriesBestEffort(runner)
			expect(runner.attempted).toEqual([])
		} finally {
			Object.defineProperty(process, "platform", { ...originalPlatform, configurable: true })
		}
	})

	it("warns with manual-removal instructions when consent is denied", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const dump = entry(SERVICE, "Bearer")
		const runner = makeRunner(dump, () => okResult({ status: 128 }))
		cleanupStrayMcpOAuthEntriesBestEffort(runner)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toContain("denied")
		expect(warn.mock.calls[0][0]).toContain("Bearer")
		expect(warn.mock.calls[0][0]).toContain("Keychain Access")
	})

	it("mentions a possibly pending dialog on timeout", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const runner = makeRunner(entry(SERVICE, "Bearer"), () =>
			okResult({ status: null, error: Object.assign(new Error("spawn ETIMEDOUT"), { code: "ETIMEDOUT" }) }),
		)
		cleanupStrayMcpOAuthEntriesBestEffort(runner)
		expect(warn.mock.calls[0][0]).toContain("pending")
	})

	it("names all strays when the blast-radius cap refuses the sweep", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const dump = [entry(SERVICE, "a"), entry(SERVICE, "b"), entry(SERVICE, "c")].join("\n")
		cleanupStrayMcpOAuthEntriesBestEffort(makeRunner(dump, () => okResult()))
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0][0]).toContain("a, b, c")
	})

	it("stays quiet on a healthy keychain", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		cleanupStrayMcpOAuthEntriesBestEffort(makeRunner(entry(SERVICE, ATLASSIAN), () => okResult()))
		expect(warn).not.toHaveBeenCalled()
	})
})
