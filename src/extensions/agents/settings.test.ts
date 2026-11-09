import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { saveAndEmitChanged } from "./settings.js"

describe("saveAndEmitChanged", () => {
	it("persists project settings under the caller-provided session cwd, not process.cwd()", () => {
		// /agents → Settings writes must land in the session's project (issue
		// #1677's settings half): an ACP session's project differs from the
		// server-process launch directory.
		const cwd = mkdtempSync(join(tmpdir(), "kimchi-agents-settings-"))
		const emit = vi.fn()

		const result = saveAndEmitChanged({ maxConcurrent: 3 }, "applied", emit, cwd)

		expect(result).toEqual({ message: "applied", level: "info" })
		const path = join(cwd, ".kimchi", "agents.json")
		expect(existsSync(path)).toBe(true)
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ maxConcurrent: 3 })
		expect(emit).toHaveBeenCalledWith("subagents:settings_changed", {
			settings: { maxConcurrent: 3 },
			persisted: true,
		})
	})
})
