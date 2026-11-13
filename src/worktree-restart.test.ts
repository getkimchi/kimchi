import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
	clearWorktreeRestartRequest,
	readWorktreeRestartRequest,
	writeWorktreeRestartRequest,
} from "./worktree-restart.js"

let agentDir: string

beforeEach(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "wt-restart-"))
})

afterEach(async () => {
	await rm(agentDir, { recursive: true, force: true })
})

describe("worktree restart marker", () => {
	it("round-trips an enter request", () => {
		writeWorktreeRestartRequest(agentDir, { direction: "enter", name: "demo", sessionFile: "/s/1.jsonl" })
		expect(readWorktreeRestartRequest(agentDir)).toEqual({
			direction: "enter",
			name: "demo",
			sessionFile: "/s/1.jsonl",
		})
	})

	it("round-trips an exit request with mainRoot", () => {
		writeWorktreeRestartRequest(agentDir, { direction: "exit", mainRoot: "/repo", sessionFile: "/s/2.jsonl" })
		expect(readWorktreeRestartRequest(agentDir)).toEqual({
			direction: "exit",
			mainRoot: "/repo",
			sessionFile: "/s/2.jsonl",
		})
	})

	it("clear removes the marker", () => {
		writeWorktreeRestartRequest(agentDir, { direction: "enter", name: "demo", sessionFile: "/s/1.jsonl" })
		clearWorktreeRestartRequest(agentDir)
		expect(readWorktreeRestartRequest(agentDir)).toBeUndefined()
		// clearing twice is fine
		clearWorktreeRestartRequest(agentDir)
	})

	it("returns undefined for a missing or malformed marker", async () => {
		expect(readWorktreeRestartRequest(agentDir)).toBeUndefined()
		await writeFile(join(agentDir, "worktree-restart.json"), "{ nope")
		expect(readWorktreeRestartRequest(agentDir)).toBeUndefined()
		await writeFile(join(agentDir, "worktree-restart.json"), JSON.stringify({ direction: "sideways" }))
		expect(readWorktreeRestartRequest(agentDir)).toBeUndefined()
		await writeFile(join(agentDir, "worktree-restart.json"), JSON.stringify({ direction: "enter" }))
		expect(readWorktreeRestartRequest(agentDir)).toBeUndefined()
	})
})
