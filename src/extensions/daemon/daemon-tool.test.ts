/**
 * Tests for the `daemon` tool definition.
 *
 * Two test groups:
 *  - steering: the tool description is load-bearing for keeping the model
 *    OFF background-execution-by-default (constraint from the spec), so
 *    key phrases are asserted explicitly.
 *  - behaviour: execute() against real `sleep` processes in a temp state
 *    dir, validating the success/error result shapes the model sees.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createDaemonToolDefinition, DAEMON_TOOL_DESCRIPTION } from "./daemon-tool.js"
import { isPidAlive, readDaemon } from "./state.js"

const describePosix = process.platform === "win32" ? describe.skip : describe

const fakeCtx = (cwd: string) => createContext({ cwd })

describe("daemon tool description (steering)", () => {
	it("positions itself as last resort, not as a bash replacement", () => {
		expect(DAEMON_TOOL_DESCRIPTION).toContain("KEEPS RUNNING after this session ends")
		// Must steer AWAY for ordinary work — spec constraint "must not
		// encourage the model to prefer background execution".
		expect(DAEMON_TOOL_DESCRIPTION).toContain("Do NOT use for")
		expect(DAEMON_TOOL_DESCRIPTION).toContain("natural end")
		// Must own its lifecycle truth: no timeout, no streaming, no cleanup.
		expect(DAEMON_TOOL_DESCRIPTION).toContain("no timeout")
		// Points back at the managed path for everything else.
		expect(DAEMON_TOOL_DESCRIPTION).toContain("bash_control")
	})
})

describePosix("daemon tool execute (real processes)", () => {
	let dir: string
	const livePids: number[] = []

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "daemon-tool-test-"))
	})

	afterEach(() => {
		for (const pid of livePids) {
			try {
				process.kill(-pid, "SIGKILL")
			} catch {
				// Teardown of an expectation that already killed it — fine.
			}
		}
		livePids.length = 0
		rmSync(dir, { recursive: true, force: true })
	})

	function tool() {
		return createDaemonToolDefinition({ stateDir: dir, crashGraceMs: 100 })
	}

	it("starts a daemon and returns id/pid/log with management hint", async () => {
		const result = await tool().execute(
			"tc1",
			{ command: "sleep 60", name: "webserver" },
			undefined,
			undefined,
			fakeCtx(dir),
		)
		const text = result.content[0].type === "text" ? result.content[0].text : ""
		expect(text).toContain("Daemon started")
		expect(text).toContain("webserver-")
		expect(text).toContain("daemon_control")

		const id = result.details?.id as string
		const record = readDaemon(dir, id)
		if (!record) throw new Error(`record for ${id} not found in state dir`)
		livePids.push(record.pid)
		expect(isPidAlive(record.pid)).toBe(true)
	})

	it("rejects invalid names with a soft error (no throw)", async () => {
		const result = await tool().execute(
			"tc2",
			{ command: "sleep 5", name: "bad/../name" },
			undefined,
			undefined,
			fakeCtx(dir),
		)
		const text = result.content[0].type === "text" ? result.content[0].text : ""
		expect(text).toContain("Error:")
		expect(result.details?.error).toBe("invalid-name")
	})

	it("empty-string name falls back to the default daemon- prefix", async () => {
		const result = await tool().execute("tc2b", { command: "sleep 5", name: "" }, undefined, undefined, fakeCtx(dir))
		expect(result.details?.error).toBeUndefined()
		const text = result.content[0].type === "text" ? result.content[0].text : ""
		expect(text).toContain("Daemon started")
		expect(text).not.toMatch(/id:\s+-[0-9a-f]{6}/)
	})

	it("empty command returns an error result", async () => {
		const result = await tool().execute("tc3", { command: "  " }, undefined, undefined, fakeCtx(dir))
		expect(result.details?.error).toBe("spawn-failed")
	})

	it("instant-crash command surfaces the failure with log tail", async () => {
		const result = await tool().execute("tc4", { command: "exit 1" }, undefined, undefined, fakeCtx(dir))
		const text = result.content[0].type === "text" ? result.content[0].text : ""
		expect(text).toContain("exited immediately")
		expect(result.details?.error).toBe("spawn-failed")
	})
})
