/**
 * Unit tests for daemon state management (`state.ts`).
 *
 * Everything filesystem-scoped runs inside a real temp dir so the
 * register/read/prune round-trip is exercised against the actual state
 * layout (`.kimchi/daemons`-style JSON + pid files) without touching
 * `~/.config/kimchi`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	type DaemonRecord,
	isPidAlive,
	listDaemons,
	makeDaemonId,
	readDaemon,
	registerDaemon,
	unregisterDaemon,
	validateDaemonName,
} from "./state.js"

function makeRecord(overrides: Partial<DaemonRecord> = {}): DaemonRecord {
	const id = overrides.id ?? "test-daemon-123abc"
	return {
		id,
		pid: process.pid, // alive for the test run
		command: "sleep 60",
		cwd: "/tmp",
		name: "test-daemon",
		startedAt: new Date().toISOString(),
		logFile: `/tmp/${id}.log`,
		pidFile: `/tmp/${id}.pid`,
		...overrides,
	}
}

describe("daemon state", () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "daemon-state-test-"))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	describe("validateDaemonName", () => {
		it("accepts alphanumerics, dash, underscore", () => {
			expect(validateDaemonName("pypi-server_2")).toBeUndefined()
			expect(validateDaemonName("a")).toBeUndefined()
		})

		it("rejects path separators, dots, spaces", () => {
			expect(validateDaemonName("../escape")).toBeDefined()
			expect(validateDaemonName("has space")).toBeDefined()
			expect(validateDaemonName("has.dot")).toBeDefined()
			expect(validateDaemonName("too/short-ish")).toBeDefined()
		})

		it("rejects over-long names", () => {
			expect(validateDaemonName("x".repeat(41))).toBeDefined()
		})

		it("rejects empty string (must not silently fall back to a '-'-prefixed id)", () => {
			expect(validateDaemonName("")).toBeDefined()
		})
	})

	describe("makeDaemonId", () => {
		it("treats empty name as absent (defensive — tools coerce at the boundary)", () => {
			expect(makeDaemonId("")).toMatch(/^daemon-[0-9a-f]{6}$/)
		})

		it("prefixes with the name and a 6-hex suffix", () => {
			expect(makeDaemonId("web")).toMatch(/^web-[0-9a-f]{6}$/)
		})

		it("falls back to 'daemon-' when no name given", () => {
			expect(makeDaemonId(undefined)).toMatch(/^daemon-[0-9a-f]{6}$/)
		})

		it("generates unique ids", () => {
			expect(makeDaemonId("web")).not.toBe(makeDaemonId("web"))
		})
	})

	describe("register/read/unregister round-trip", () => {
		it("persists a record and reads it back", () => {
			const record = makeRecord()
			registerDaemon(dir, record)
			expect(readDaemon(dir, record.id)).toEqual(record)
			// pid file written as plain text for humans
			expect(readFileSync(record.pidFile, "utf8")).toBe(String(record.pid))
		})

		it("unregister removes json and pid files", () => {
			const record = makeRecord()
			registerDaemon(dir, record)
			unregisterDaemon(dir, record.id)
			expect(readDaemon(dir, record.id)).toBeUndefined()
		})

		it("readDaemon returns undefined for missing ids", () => {
			expect(readDaemon(dir, "nope-123abc")).toBeUndefined()
		})

		it("readDaemon skips malformed JSON instead of throwing", () => {
			writeFileSync(join(dir, "broken-123abc.json"), "{not json", "utf8")
			expect(readDaemon(dir, "broken-123abc")).toBeUndefined()
		})

		it("readDaemon skips records with missing fields", () => {
			writeFileSync(join(dir, "thin-123abc.json"), JSON.stringify({ id: "thin-123abc" }), "utf8")
			expect(readDaemon(dir, "thin-123abc")).toBeUndefined()
		})
	})

	describe("isPidAlive", () => {
		it("reports the current process as alive", () => {
			expect(isPidAlive(process.pid)).toBe(true)
		})

		it("reports an impossible pid as dead", () => {
			// Pid 2^22-1 is beyond typical pid_max; on macOS max pid is 99998.
			expect(isPidAlive(4194303)).toBe(false)
		})
	})

	describe("listDaemons", () => {
		it("returns live records", () => {
			registerDaemon(dir, makeRecord())
			const live = listDaemons(dir)
			expect(live).toHaveLength(1)
			expect(live[0].alive).toBe(true)
		})

		it("prunes dead-pid records from disk", () => {
			registerDaemon(dir, makeRecord({ id: "dead-123abc", pid: 4194303 }))
			expect(listDaemons(dir)).toHaveLength(0)
			// Pruned: a second read finds no record at all.
			expect(readDaemon(dir, "dead-123abc")).toBeUndefined()
		})

		it("handles an empty or missing state dir", () => {
			expect(listDaemons(join(dir, "does-not-exist"))).toEqual([])
		})
	})
})
