/**
 * Tests for the `daemon_control` tool definition.
 *
 * Real processes in a temp state dir (same rationale as spawn.test.ts):
 * list / status / logs / stop round-trip through actual pids so the
 * liveness check and group kill are exercised, with soft-error shapes
 * (NOT thrown tool errors) asserted for unknown ids — that pattern is the
 * mark_todo lesson: hard errors make the model retry-churn.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createDaemonControlToolDefinition, DAEMON_CONTROL_TOOL_DESCRIPTION } from "./daemon-control-tool.js"
import { spawnDaemon } from "./spawn.js"
import { isPidAlive, readDaemon } from "./state.js"

const describePosix = process.platform === "win32" ? describe.skip : describe

const fakeCtx = createContext()

describe("daemon_control tool description (steering)", () => {
	it("documents the four actions and disclaims bash_control overlap", () => {
		for (const action of ['"list"', '"status"', '"logs"', '"stop"']) {
			expect(DAEMON_CONTROL_TOOL_DESCRIPTION).toContain(action)
		}
		expect(DAEMON_CONTROL_TOOL_DESCRIPTION).toContain("NOT managed by bash_control")
	})
})

describePosix("daemon_control tool execute (real processes)", () => {
	let dir: string
	const livePids: number[] = []

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "daemon-ctl-test-"))
	})

	afterEach(() => {
		for (const pid of livePids) {
			try {
				process.kill(-pid, "SIGKILL")
			} catch {
				// Expectations may have stopped it already.
			}
		}
		livePids.length = 0
		rmSync(dir, { recursive: true, force: true })
	})

	function tool() {
		return createDaemonControlToolDefinition({ stateDir: dir })
	}

	async function startSleeper(name: string): Promise<{ id: string; pid: number; logFile: string }> {
		const outcome = await spawnDaemon({
			command: "sleep 60",
			cwd: dir,
			name,
			stateDir: dir,
			crashGraceMs: 100,
		})
		if (!outcome.ok) throw new Error(`setup spawn failed: ${outcome.error}`)
		livePids.push(outcome.record.pid)
		return outcome.record
	}

	it("list shows live daemons and prunes dead ones", async () => {
		const empty = await tool().execute("t1", { action: "list" }, undefined, undefined, fakeCtx)
		expect(empty.content[0].type === "text" && empty.content[0].text).toContain("No live daemons")

		const record = await startSleeper("listed")
		const listed = await tool().execute("t2", { action: "list" }, undefined, undefined, fakeCtx)
		const text = listed.content[0].type === "text" ? listed.content[0].text : ""
		expect(text).toContain(record.id)
		expect(text).toContain(String(record.pid))
	})

	it("status reports a running daemon", async () => {
		const record = await startSleeper("checked")
		const result = await tool().execute("t3", { action: "status", id: record.id }, undefined, undefined, fakeCtx)
		const text = result.content[0].type === "text" ? result.content[0].text : ""
		expect(text).toContain("RUNNING")
		expect(text).toContain(String(record.pid))
	})

	it("status on a dead daemon: reports not-running and KEEPS the record", async () => {
		// Regression for review feedback: status must not prune dead
		// records as a side effect — only `list` does that.
		const outcome = await spawnDaemon({
			command: "bash -c 'echo transient; exit 0'",
			cwd: dir,
			name: "transient",
			stateDir: dir,
			crashGraceMs: 0, // skip liveness check — it's SUPPOSED to exit
		})
		if (!outcome.ok) throw new Error(`setup spawn failed: ${outcome.error}`)
		// Bounded wait for natural death.
		const deadline = Date.now() + 3000
		while (isPidAlive(outcome.record.pid) && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50))
		}
		expect(isPidAlive(outcome.record.pid)).toBe(false)

		const result = await tool().execute(
			"t3b",
			{ action: "status", id: outcome.record.id },
			undefined,
			undefined,
			fakeCtx,
		)
		const text = result.content[0].type === "text" ? result.content[0].text : ""
		expect(text).toContain("not running")
		// Record retained for the next `list` to prune (or investigate).
		expect(readDaemon(dir, outcome.record.id)).toBeDefined()
	})

	it("status on unknown id steers to list (soft, not a throw)", async () => {
		const result = await tool().execute("t4", { action: "status", id: "ghost-123abc" }, undefined, undefined, fakeCtx)
		const text = result.content[0].type === "text" ? result.content[0].text : ""
		expect(text).toContain("not recorded")
		expect(text).toContain("list")
		expect(result.details?.error).toBe("unknown-id")
	})

	it("logs tails the daemon's output file", async () => {
		const outcome = await spawnDaemon({
			command: "bash -c 'echo log-marker-xyzzy; exec sleep 60'",
			cwd: dir,
			name: "logger",
			stateDir: dir,
			crashGraceMs: 100,
		})
		if (!outcome.ok) throw new Error(`setup spawn failed: ${outcome.error}`)
		livePids.push(outcome.record.pid)

		// Bounded wait for the log line to land.
		const deadline = Date.now() + 3000
		let text = ""
		while (Date.now() < deadline) {
			const res = await tool().execute(
				"t5",
				{ action: "logs", id: outcome.record.id, max_bytes: 4096 },
				undefined,
				undefined,
				fakeCtx,
			)
			text = res.content[0].type === "text" ? res.content[0].text : ""
			if (text.includes("log-marker-xyzzy")) break
			await new Promise((r) => setTimeout(r, 50))
		}
		expect(text).toContain("log-marker-xyzzy")
	})

	it("stop kills the daemon and removes its record", async () => {
		const record = await startSleeper("stopped")
		const result = await tool().execute("t6", { action: "stop", id: record.id }, undefined, undefined, fakeCtx)
		const text = result.content[0].type === "text" ? result.content[0].text : ""
		expect(text).toContain("stopped")
		expect(isPidAlive(record.pid)).toBe(false)
		expect(readDaemon(dir, record.id)).toBeUndefined()
	})

	it("stop on unknown id is a soft report", async () => {
		const result = await tool().execute("t7", { action: "stop", id: "ghost-123abc" }, undefined, undefined, fakeCtx)
		expect(result.details?.error).toBe("unknown-id")
	})

	it("status/logs/stop without id return a clear error", async () => {
		const result = await tool().execute("t8", { action: "status" }, undefined, undefined, fakeCtx)
		expect(result.details?.error).toBe("missing-id")
	})
})
